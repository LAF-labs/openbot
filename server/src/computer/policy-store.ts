/**
 * The policy the gateway is currently enforcing, and the ability to change it while running.
 *
 * It survives a restart. A rule held only in memory vanishes the next time the process comes up, and
 * the trail shows it being added without showing that it stopped applying. A reader would believe a
 * boundary held at a moment when it did not, and a form going through after a restart is
 * indistinguishable from a rule that never applied.
 *
 * Memory is the cache, and the table is the record. The gateway asks for the policy on every single
 * action, so `get` stays synchronous and reads from memory; the write goes through to the database
 * and the memory copy is only updated once it has. A store that answered from the database on every
 * click would put a query on the path of every keystroke a Bot makes.
 *
 * Without a database it still works in memory. Tests that only care about decision logic do not need
 * Postgres.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { actionPolicy } from "../db/schema";
import { log } from "../log";
import type { ActionPolicy } from "./policy";

/** There is one boundary per deployment, so there is one row. */
const CURRENT = "current";

/**
 * What a deployment enforces when it has not said otherwise.
 *
 * Lives in `default-policy.ts` with the word and host lists it is built from, and is re-exported here
 * because this is where everything that wants a starting policy already looks.
 */
export { DEFAULT_ACTION_POLICY } from "./default-policy";

/**
 * The one mode there is, written into the column the table still has.
 *
 * `dry-run` is gone (see policy.ts), and the column is not: dropping it is a migration, and a
 * migration to delete a field nothing reads is a worse trade than one honest constant. Rows written
 * before this say `dry-run` and mean nothing now, which is why `load` does not read the column at all.
 */
const ENFORCED = "enforce";

/**
 * A RULE THIS SERVER NO LONGER TAKES, and the one that says what it was meant to.
 *
 * The boundaries screen's "ask before writing a file outside notes/" wrote the first of these until
 * 2026-10-07. `matches` ignores letter case and a deployment's disk does not, so under it a write
 * to `Notes/x.md` was not asked about and made a second folder beside the one the label names.
 * Migration 0062 rewrites a stored copy, and that is not enough to be rid of it: a window that read
 * the boundary before the upgrade saves the whole of it back, and an operator can still have it in
 * `AGENT_COMPUTER_POLICY`. So it is refused where a policy comes in ({@link parseActionPolicy}).
 *
 * EXACTLY THIS STRING — the one the button wrote, which is the one the migration looks for
 * (`server/tests/notes-preset-migration.test.ts` holds the two to the letter). Not a detector of
 * negated matches: a rule somebody wrote by hand in that shape is theirs, and what it gets is the
 * paragraph in `docs/architecture.md`.
 */
export const RETIRED_NOTES_RULE =
  'intent == "write_file" && !matches(file.path, "^notes/")';
/** What the button writes now, and what the migration leaves in the old one's place. */
export const NOTES_RULE = 'intent == "write_file" && file.folder != "notes"';

/**
 * WHICH BOUNDARY A SAVE WAS MADE AGAINST, AS ONE SHORT MARK.
 *
 * The boundaries screen reads the policy once and sends the whole of it back with one thing
 * changed. Two windows doing that are a lost update: the second save writes its own older copy over
 * the first — a rule somebody just added gone, or `settleWithoutAsking` switched back, with nobody
 * having decided either. Measured 2026-10-07 on the case that found it: a window open across an
 * upgrade saved the rule a migration had just rewritten straight back.
 *
 * So whoever writes says which boundary they read ({@link PolicyStore.set}), and a write made
 * against one that is no longer in force stores nothing.
 *
 * THE MARK IS A DIGEST OF THE BOUNDARY, NOT A COUNT OF SAVES. A count lives in this process and
 * starts again when it does, so a window that read the boundary before a restart could present a
 * number the new process has since counted back up to — and an upgrade IS a restart, behind a
 * migration that may have rewritten the row. A digest of what was read can only match the boundary
 * it was read from: it survives a restart that changed nothing, and it does not survive a migration
 * that did. Absent `settleWithoutAsking` means allowed, so the two are one boundary and one mark.
 */
export function revisionOf(policy: ActionPolicy): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        policy.deny,
        policy.ask,
        policy.allow,
        policy.settleWithoutAsking ?? "allowed",
      ]),
    )
    .digest("hex")
    .slice(0, 24);
}

/** Who is writing, and which boundary they read before they changed it. */
export type PolicyWriter = {
  /** What {@link PolicyStore.revision} answered for the boundary this write was made against. */
  revision: string;
  /** Who, for the row. Why is the audit trail's (`routes.ts`). */
  by?: string;
};

/**
 * What came of a write. `stored: false` is the boundary having changed since its writer read it:
 * nothing was written, and what was in force still is.
 */
export type PolicyWrite = { stored: boolean };

export type PolicyStore = {
  /** Synchronous on purpose: this is asked on every action. */
  get: () => ActionPolicy;
  /** The mark of the boundary `get` returns: what a write has to present. See {@link revisionOf}. */
  revision: () => string;
  /**
   * Persisted before the in-memory copy changes, so a reported success is a saved rule — and only
   * where the writer read the boundary that is in force. There is no way to write without saying
   * which one that was: a caller that cannot say has not read it.
   *
   * WHO, and not why. The reasoning behind a change belongs in the audit trail beside the change
   * itself, where a reader is already looking and where it cannot be overwritten by the next save;
   * `routes.ts` writes that row. This table holds what is in force now.
   */
  set: (policy: ActionPolicy, from: PolicyWriter) => Promise<PolicyWrite>;
  /** Back to what configuration says, forgetting the saved one. Held to the same mark as `set`. */
  reset: (from: PolicyWriter) => Promise<PolicyWrite>;
  /** Read the saved policy at boot. Returns where the live policy came from. */
  load: () => Promise<"the database" | "configuration">;
};

export function createPolicyStore(
  initial: ActionPolicy,
  /** Absent keeps everything in memory, which is what a test without a database wants. */
  database?: Database,
): PolicyStore {
  const configured = clone(initial);
  let current = clone(initial);

  /*
   * ONE WRITE AT A TIME, so that "is this the boundary you read?" and the write behind it are one
   * step. Two saves that arrive together have read the same mark; left to interleave, both pass the
   * check while the first is still on its way to the database, and the second writes over it.
   *
   * IN THIS PROCESS'S MEMORY, AND THAT IS THE WHOLE OF IT. A deployment runs one API server
   * process (docs/laf/deployment-model.md), this store is the only thing in it that writes the
   * row's rules, and `current` is their cache — so the boundary in force is the one held here, and
   * a check against it is a check against the record. (An account's deletion overwrites who last
   * changed the row, `updated_by`, and no rule.) A migration writes the row before the server
   * starts, and `load` then reads what the migration left.
   */
  let writing: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const mine = writing.then(work, work);
    writing = mine.catch(() => undefined);
    return mine;
  };
  const isCurrent = (from: PolicyWriter) =>
    from.revision === revisionOf(current);

  return {
    get: () => current,
    revision: () => revisionOf(current),

    set: (policy, from) =>
      inTurn(async () => {
        if (!isCurrent(from)) return { stored: false };
        const by = from.by;
        const next = clone(policy);
        if (database) {
          // Written before it is enforced. If the write fails this throws and the caller reports a
          // failure, which is the honest outcome: an administrator who is told a rule was saved must
          // not be enforcing a rule that will disappear at the next restart.
          await database
            .insert(actionPolicy)
            .values({
              id: CURRENT,
              mode: ENFORCED,
              deny: next.deny,
              ask: next.ask,
              allow: next.allow,
              settleWithoutAsking: next.settleWithoutAsking ?? null,
              updatedBy: by ?? null,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: actionPolicy.id,
              set: {
                mode: ENFORCED,
                deny: next.deny,
                ask: next.ask,
                allow: next.allow,
                settleWithoutAsking: next.settleWithoutAsking ?? null,
                updatedBy: by ?? null,
                updatedAt: new Date(),
              },
            });
        }
        current = next;
        return { stored: true };
      }),

    reset: (from) =>
      inTurn(async () => {
        if (!isCurrent(from)) return { stored: false };
        // The saved policy is removed rather than overwritten with the configured one, so "reset"
        // means this deployment has no boundary of its own again, and changing what configuration
        // says then changes what it enforces, which is what an operator expects of a reset.
        if (database) {
          await database
            .delete(actionPolicy)
            .where(eq(actionPolicy.id, CURRENT));
        }
        current = clone(configured);
        return { stored: true };
      }),

    /*
     * READ AS IT IS WRITTEN, NOT PARSED. `parseActionPolicy` is the door for a policy somebody
     * hands over, and it refuses the retired rule; this is the deployment's own row, which the
     * migration has already rewritten by the time anything reads it. A boot that depended on a
     * parse here would turn a row some future parser dislikes into a server that does not start —
     * with the boundary it was enforcing the day before as the thing it could not read.
     */
    load: async () => {
      if (!database) return "configuration";
      const [row] = await database
        .select()
        .from(actionPolicy)
        .where(eq(actionPolicy.id, CURRENT))
        .limit(1);
      if (!row) return "configuration";

      current = {
        // The mode column is not read. A row saved when `dry-run` existed said "record it and let it
        // through", and honouring that now would bring the mode back for exactly the deployments
        // that had switched the boundary off.
        deny: [...row.deny],
        ask: [...row.ask],
        allow: [...row.allow],
        // Only the two the parser allows reach the column, so anything else in it is a row edited
        // by hand — read as "off", because that is the reading that keeps the boundary.
        ...(row.settleWithoutAsking === null
          ? {}
          : {
              settleWithoutAsking:
                row.settleWithoutAsking === "allowed" ? "allowed" : "off",
            }),
      };
      return "the database";
    },
  };
}

function clone(policy: ActionPolicy): ActionPolicy {
  return {
    deny: [...policy.deny],
    ask: [...policy.ask],
    allow: [...policy.allow],
    ...(policy.settleWithoutAsking
      ? { settleWithoutAsking: policy.settleWithoutAsking }
      : {}),
  };
}

/** Why a policy that arrived was not taken. */
export type PolicyRefusal =
  | "laf:policy_not_object"
  | "laf:policy_list_invalid"
  | "laf:policy_settle_invalid"
  /** It holds {@link RETIRED_NOTES_RULE} in a list that holds an action back. */
  | "laf:policy_rule_retired";

/**
 * Validate a policy that arrived over HTTP.
 *
 * Rejects rather than coerces. A policy is the thing standing between a Bot and somebody's live
 * website, and "we accepted your rule but not in the shape you wrote it" is the one behaviour that
 * must never happen here: an operator would believe a restriction is in force when it is not.
 *
 * Expressions are NOT validated for correctness on the way in, only for being strings. Whether a rule
 * is meaningful is the policy engine's business, it fails closed there, and pre-validating here would
 * mean two parsers to keep in agreement.
 *
 * A refusal is a code, and the list it is about where it is about one. It was an English sentence,
 * which the route answered with and the Boundaries page printed as the reason a rule was not saved.
 */
export function parseActionPolicy(input: unknown):
  | { ok: true; policy: ActionPolicy }
  | {
      ok: false;
      code: PolicyRefusal;
      list?: "deny" | "ask" | "allow";
      /** For a retired rule: the rule, and the one to write in its place. Facts, not a sentence. */
      rule?: string;
      replacement?: string;
    } {
  if (!input || typeof input !== "object") {
    return { ok: false, code: "laf:policy_not_object" };
  }
  const candidate = input as Record<string, unknown>;

  /*
   * `mode` IS READ AND THROWN AWAY, rather than refused.
   *
   * Everything enforces now. A policy that still carries `"mode": "dry-run"` — saved before that
   * decision, or copied out of an older `.env.example` — must not stop a deployment from booting
   * over a field that no longer means anything, and must not be silently believed either. So it
   * parses, it is said out loud, and the boundary it describes is enforced.
   */
  if (candidate.mode !== undefined && candidate.mode !== "enforce") {
    log.warn("computer_policy_mode_ignored", {
      was: candidate.mode,
      now: "enforce",
    });
  }

  const lists: Record<"deny" | "ask" | "allow", string[]> = {
    deny: [],
    ask: [],
    allow: [],
  };
  for (const key of ["deny", "ask", "allow"] as const) {
    const value = candidate[key] ?? [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      return { ok: false, code: "laf:policy_list_invalid", list: key };
    }
    lists[key] = value as string[];
  }

  /*
   * THE ONE RULE THAT IS NOT TAKEN, in the two lists where it lets something past
   * ({@link RETIRED_NOTES_RULE}). Refused, not rewritten: "we accepted your rule but not in the
   * shape you wrote it" is the one thing this function never does, and a window still holding the
   * old boundary should be told its copy is no good rather than have it quietly mended.
   *
   * NOT IN `allow`. There the same expression is a narrower grant — "writes that are not under
   * notes/" — and what it leaves out by ignoring case it leaves to the next rule. The migration
   * leaves it there for the same reason, and a boundary that held it there and could not be saved
   * again would be a deployment unable to change any rule at all: the screen sends `allow` back as
   * it read it, and has no way to edit it.
   */
  for (const key of ["deny", "ask"] as const) {
    if (lists[key].includes(RETIRED_NOTES_RULE)) {
      return {
        ok: false,
        code: "laf:policy_rule_retired",
        list: key,
        rule: RETIRED_NOTES_RULE,
        replacement: NOTES_RULE,
      };
    }
  }

  // Absent means allowed, like `ask` defaulting to empty: a policy written before this existed
  // still parses and still means what it meant. Anything else is refused rather than read as one of
  // the two, because a typo silently meaning "allowed" is the direction that loosens a boundary.
  const standing = candidate.settleWithoutAsking;
  if (standing !== undefined && standing !== "allowed" && standing !== "off") {
    return { ok: false, code: "laf:policy_settle_invalid" };
  }

  return {
    ok: true,
    policy: {
      deny: lists.deny,
      ask: lists.ask,
      allow: lists.allow,
      ...(standing === undefined ? {} : { settleWithoutAsking: standing }),
    },
  };
}
