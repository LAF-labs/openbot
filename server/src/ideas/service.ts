/**
 * Which 아이디어 cards to put in front of this person, in what order, and 다음에.
 *
 * FACTS, NOT WORDS. The route answers keys and connection states; the card's words are the surface's
 * (`shared/ideas/catalogue.ts` holds their English keys, `app/src/lib/i18n-ko.ts` their Korean).
 * Nothing here calls a model: the page costs nothing until somebody presses a card, and a press is
 * the composer's, not this route's.
 *
 * WHAT DECIDES WHETHER A CARD IS ON OFFER is the deployment and the connections, never the persona:
 *  - a card whose tool the Bot does not hold (지원사업 without the fleet's 기업마당 key) is not drawn —
 *    there is nothing on 연결 a person could press to get it;
 *  - a card that needs a connection this deployment offers no door to (a Google account where the
 *    fleet registered no Google application) is not drawn, for the same reason;
 *  - a card that needs a connection the person could make and has not is drawn as `connect`, and
 *    becomes `ready` the moment one of its connections is `connected` — not `needs_login`, which is a
 *    session that lapsed and would send the Bot to a login wall.
 * The persona only orders them (`orderIdeas`), so every persona gets the same keys.
 *
 * 다음에 IS A ROW ON THE ROUTINE SUGGESTIONS' LATCH, as `idea:<key>` (`IDEA_DISMISSAL_PREFIX`). The
 * table's key is text so that a catalogue edit is not a migration, and the routine suggestions only
 * ever look up their own keys (`routines/suggestions.ts`), so an idea's row never hides a routine.
 */
import {
  IDEA_DISMISSAL_PREFIX,
  IDEAS,
  type IdeaEntry,
  type IdeaNeed,
  orderIdeas,
} from "../../../shared/ideas/catalogue";
import { effectivePersona, type Persona } from "../../../shared/persona";
import type { ShopProfile } from "../../../shared/shop/catalogue";
import type { AgentActor } from "../agents/profile-types";
import type {
  SuggestionConnections,
  SuggestionDismissalStore,
} from "../routines/suggestions";

/** A connection a card names, with the vendor's own title for an OAuth account (an English key). */
export type IdeaNeedState = IdeaNeed & { title?: string };

/** One card, as the page receives it. */
export type OfferedIdea = {
  key: string;
  /** `ready`: pressing it can be sent now. `connect`: one of `needs` has to be connected first. */
  state: "ready" | "connect";
  /** The connections that make it answerable now — what the card says it works through. */
  via: IdeaNeedState[];
  /** Every connection that could, where this deployment offers it. */
  needs: IdeaNeedState[];
};

export type IdeasAnswer = {
  /** Whom the order was made for: the answer they pressed, or 사장님 by their shop answers. */
  persona: Persona | null;
  ideas: OfferedIdea[];
};

export type IdeaServiceOptions = {
  /** Who the person said they are, and the shop answers the effective persona falls back on. */
  person: (userId: string) => Promise<{
    persona: Persona | null;
    shop: Pick<ShopProfile, "kind" | "places">;
  }>;
  connections: (userId: string) => Promise<SuggestionConnections>;
  /** The tool refs the person's Bot holds. Empty when they have no Bot yet. */
  tools: (actor: AgentActor) => Promise<ReadonlySet<string>>;
  dismissals: SuggestionDismissalStore;
  catalogue?: readonly IdeaEntry[];
};

/** Thrown for a key that is not a card. A code; the surface owns the words. */
export class IdeaUnknownError extends Error {
  readonly code = "laf:idea_unknown";
  constructor() {
    super("That idea is not in the catalogue.");
  }
}

export function createIdeaService(options: IdeaServiceOptions) {
  const catalogue = options.catalogue ?? IDEAS;

  return {
    async list(actor: AgentActor): Promise<IdeasAnswer> {
      const [person, connections, tools, dismissed] = await Promise.all([
        options.person(actor.id),
        options.connections(actor.id),
        options.tools(actor),
        options.dismissals.dismissedKeys(actor.id),
      ]);
      const persona = effectivePersona(person.persona, person.shop);
      const latched = new Set(
        dismissed
          .filter((key) => key.startsWith(IDEA_DISMISSAL_PREFIX))
          .map((key) => key.slice(IDEA_DISMISSAL_PREFIX.length)),
      );

      /*
       * Offered: present in the overview, which lists only the sites a computer could hold and the
       * accounts this deployment can finish a consent for. Connected: `connected`, nothing less.
       */
      const status = new Map<string, string>();
      const titles = new Map<string, string>();
      for (const row of connections.sites)
        status.set(`site:${row.id}`, row.status);
      for (const row of connections.accounts) {
        status.set(`account:${row.id}`, row.status);
        if (row.title) titles.set(row.id, row.title);
      }
      const named = (need: IdeaNeed): IdeaNeedState => {
        const title = need.kind === "account" ? titles.get(need.id) : undefined;
        return title ? { ...need, title } : { ...need };
      };

      const cards: (OfferedIdea & { ready: boolean })[] = [];
      for (const idea of catalogue) {
        if (latched.has(idea.key)) continue;
        if (idea.tool && !tools.has(idea.tool)) continue;
        const offered = idea.needs.filter((need) =>
          status.has(`${need.kind}:${need.id}`),
        );
        if (idea.needs.length > 0 && offered.length === 0) continue;
        const via = offered.filter(
          (need) => status.get(`${need.kind}:${need.id}`) === "connected",
        );
        const ready = idea.needs.length === 0 || via.length > 0;
        cards.push({
          key: idea.key,
          state: ready ? "ready" : "connect",
          via: via.map(named),
          needs: offered.map(named),
          ready,
        });
      }
      return {
        persona,
        ideas: orderIdeas(cards, persona).map(({ ready: _, ...card }) => card),
      };
    },

    /**
     * 다음에. For any key in the catalogue, on offer right now or not — somebody who put a card
     * away while it waited on 배민 has put it away, and it must not come back the day 배민 connects.
     */
    async dismiss(actor: AgentActor, key: string): Promise<void> {
      if (!catalogue.some((idea) => idea.key === key)) {
        throw new IdeaUnknownError();
      }
      await options.dismissals.dismiss(
        actor.id,
        `${IDEA_DISMISSAL_PREFIX}${key}`,
      );
    },
  };
}

export type IdeaService = ReturnType<typeof createIdeaService>;
