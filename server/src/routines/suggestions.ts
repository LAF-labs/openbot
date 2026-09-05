import { eq } from "drizzle-orm";
import { siteById } from "../../../shared/sites/catalogue";
import type { AgentActor } from "../agents/profile-types";
import type { Database } from "../db/client";
import { lafRoutineSuggestionDismissals } from "../db/schema";
import { catalogueEntry } from "../plugins/catalogue";
import { RoutineError, type RoutineService } from "./service";
import {
  ROUTINE_SUGGESTIONS,
  type RoutineSuggestionEntry,
  type SuggestionRequirement,
} from "./suggestion-catalog";

/**
 * Which catalogue routines to offer this person, and what happens when they answer.
 *
 * THE RULES, all of them Hermes Agent's (`cron/suggestions.py`) and each one here for a reason
 * the catalogue's own note gives:
 *
 *  - CONSENT FIRST. Nothing is created until somebody presses 만들기. This module's `list` only
 *    reads; `accept` is the one path to a routine and it goes through the routine service's own
 *    `create`, so the cap, the schedule parsing and the trigger token are exactly what a routine
 *    typed by hand gets.
 *  - OFFERED ONLY WHEN IT CAN RUN. A card needs one of its connections actually connected — not
 *    pending, not waiting on a login — and a person with no Bot is offered nothing, because a
 *    routine with no Bot to run it is the routines page's own empty state, which already says so.
 *  - ONE PER KEY. A routine carrying the key exists → the card is gone, and it comes back when
 *    that routine is deleted. A routine with the same NAME counts too: the key is how the product
 *    knows, the name is how the person does, and a second 아침 브리핑 is a duplicate whichever way
 *    it was made.
 *  - 다음에 IS FOREVER. A dismissal is a row, per person and key, and is never re-offered.
 *  - AT MOST FIVE. The nag wall is the failure this whole feature would otherwise be — eleven
 *    cards above the list somebody came to read. Five, in catalogue order, and the next one moves
 *    up as the person decides about the ones in front of it.
 */

export const MAX_PENDING_SUGGESTIONS = 5;

/**
 * What the 연결 screen's own read composes, reduced to the two facts eligibility needs.
 *
 * Structurally a subset of `ConnectionsOverview`, so `readConnectionsOverview` can be handed in
 * whole and a test can hand in three lines.
 */
export type SuggestionConnections = {
  /** `title` is the vendor's own name for an OAuth entry; the card draws it through `t()`. */
  accounts: readonly { id: string; status: string; title?: string }[];
  sites: readonly { id: string; status: string }[];
};

/**
 * A requirement with the name the card draws for it.
 *
 * The name is an English key — a site's `name` from the shared catalogue, an OAuth entry's
 * `title` — which is exactly what the 연결 screen hands `t()` for the same row, so the card and
 * that screen cannot call one connection two things. A fact, not prose: the surface owns the words.
 */
export type NamedRequirement = SuggestionRequirement & { title: string };

/** A suggestion as the routines page receives it: the routine it would make, and what it runs on. */
export type OfferedSuggestion = {
  key: string;
  name: string;
  instruction: string;
  schedule: RoutineSuggestionEntry["schedule"];
  /** Everything the routine could run on, from the catalogue. */
  needs: NamedRequirement[];
  /** The subset of `needs` this person actually has connected — what the card names. */
  via: NamedRequirement[];
};

export type SuggestionDismissalStore = {
  dismissedKeys(userId: string): Promise<string[]>;
  dismiss(userId: string, key: string): Promise<void>;
};

/** The latch, on the table `laf_routine_suggestion_dismissals`. */
export function createSuggestionDismissalStore(
  database: Database,
): SuggestionDismissalStore {
  return {
    async dismissedKeys(userId) {
      const rows = await database
        .select({ key: lafRoutineSuggestionDismissals.suggestionKey })
        .from(lafRoutineSuggestionDismissals)
        .where(eq(lafRoutineSuggestionDismissals.userId, userId));
      return rows.map((row) => row.key);
    },
    async dismiss(userId, key) {
      // Pressing 다음에 twice — a double tap, a retried request — is one decision, not a conflict.
      await database
        .insert(lafRoutineSuggestionDismissals)
        .values({ userId, suggestionKey: key })
        .onConflictDoNothing({
          target: [
            lafRoutineSuggestionDismissals.userId,
            lafRoutineSuggestionDismissals.suggestionKey,
          ],
        });
    },
  };
}

export type RoutineSuggestionOptions = {
  /** The one path to a routine, and the list the dedup reads. */
  routines: Pick<RoutineService, "list" | "create">;
  dismissals: SuggestionDismissalStore;
  /** This person's connections, as `/api/connections/overview` would compose them. */
  connections: (userId: string) => Promise<SuggestionConnections>;
  /** The Bots this person can put a routine on. Empty means nothing is offered. */
  bots: (actor: AgentActor) => Promise<{ id: string; name: string }[]>;
  catalogue?: readonly RoutineSuggestionEntry[];
  limit?: number;
};

const requirementKey = (requirement: SuggestionRequirement) =>
  `${requirement.kind}:${requirement.id}`;

/**
 * 404 for a key that is not a card in front of this person right now — unknown, dismissed,
 * already made, or not eligible. One answer for all four, the way `noSuchRoutine` argues it:
 * a card that is not on the screen is a card that does not exist, as far as the screen can tell.
 */
const notOffered = () =>
  new RoutineError(
    "That suggestion is not on offer.",
    404,
    "laf:routine_suggestion_not_offered",
  );

export function createRoutineSuggestionService(
  options: RoutineSuggestionOptions,
) {
  const catalogue = options.catalogue ?? ROUTINE_SUGGESTIONS;
  const limit = options.limit ?? MAX_PENDING_SUGGESTIONS;

  /** Every eligible card, unbounded and in catalogue order. `list` cuts it; `accept` searches it. */
  async function offered(actor: AgentActor): Promise<OfferedSuggestion[]> {
    const bots = await options.bots(actor);
    if (bots.length === 0) return [];

    const [connections, dismissed, routines] = await Promise.all([
      options.connections(actor.id),
      options.dismissals.dismissedKeys(actor.id),
      options.routines.list(actor),
    ]);

    /*
     * `connected` only. `needs_login` and `needs_reconnect` are connections the person HAD, and a
     * routine offered on one would open a login wall at seven in the morning — the failed run
     * scheduled in advance that the catalogue's note is about.
     */
    const held = new Set<string>();
    for (const row of connections.sites) {
      if (row.status === "connected") held.add(`site:${row.id}`);
    }
    const accountTitles = new Map<string, string>();
    for (const row of connections.accounts) {
      if (row.title) accountTitles.set(row.id, row.title);
      if (row.status === "connected") held.add(`account:${row.id}`);
    }
    /*
     * The overview's title first, because it is what the 연결 screen drew; the catalogue's for
     * an account this deployment cannot connect (it is then in `needs`, never in `via`), so the
     * fact still carries a name and not a key.
     */
    const named = (requirement: SuggestionRequirement): NamedRequirement => ({
      ...requirement,
      title:
        (requirement.kind === "site"
          ? siteById(requirement.id)?.name
          : (accountTitles.get(requirement.id) ??
            catalogueEntry(requirement.id)?.title)) ?? requirement.id,
    });

    const latched = new Set(dismissed);
    const takenKeys = new Set<string>();
    const takenNames = new Set<string>();
    for (const routine of routines) {
      if (routine.suggestionKey) takenKeys.add(routine.suggestionKey);
      takenNames.add(routine.name);
    }

    const cards: OfferedSuggestion[] = [];
    for (const entry of catalogue) {
      if (latched.has(entry.key)) continue;
      if (takenKeys.has(entry.key) || takenNames.has(entry.name)) continue;
      const via = entry.needsAnyOf.filter((requirement) =>
        held.has(requirementKey(requirement)),
      );
      if (entry.needsAnyOf.length > 0 && via.length === 0) continue;
      cards.push({
        key: entry.key,
        name: entry.name,
        instruction: entry.instruction,
        schedule: entry.schedule,
        needs: entry.needsAnyOf.map(named),
        via: via.map(named),
      });
    }
    return cards;
  }

  return {
    async list(actor: AgentActor): Promise<OfferedSuggestion[]> {
      return (await offered(actor)).slice(0, limit);
    },

    /**
     * 만들기. On the Bot the card named, or on the only Bot there is when the card named none.
     *
     * The Bot has to be one this person can see. The routine service's `create` checks nothing
     * about the Bot beyond the reference — its own route takes whatever id the body carries — so
     * this is the one place a suggestion's Bot is judged, and it is judged against the same roster
     * the card's picker was drawn from.
     */
    async accept(actor: AgentActor, key: string, agentId?: string) {
      const card = (await offered(actor)).find((one) => one.key === key);
      if (!card) throw notOffered();
      const bots = await options.bots(actor);
      const bot = agentId
        ? bots.find((one) => one.id === agentId)
        : bots.length === 1
          ? bots[0]
          : undefined;
      if (!bot) {
        throw new RoutineError("Name a Bot.", 400, "laf:routine_incomplete");
      }
      return options.routines.create(actor, {
        agentId: bot.id,
        name: card.name,
        instruction: card.instruction,
        schedule: card.schedule,
        suggestionKey: card.key,
      });
    },

    /**
     * 다음에. Latched for any key the catalogue knows, eligible right now or not — a person who
     * declines a card while its site is connected has declined it, and it must not reappear the
     * day the site is connected again.
     */
    async dismiss(actor: AgentActor, key: string): Promise<void> {
      if (!catalogue.some((entry) => entry.key === key)) throw notOffered();
      await options.dismissals.dismiss(actor.id, key);
    },
  };
}

export type RoutineSuggestionService = ReturnType<
  typeof createRoutineSuggestionService
>;
