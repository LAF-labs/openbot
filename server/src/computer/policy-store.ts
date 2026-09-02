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
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { actionPolicy } from "../db/schema";
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

export type PolicyStore = {
  /** Synchronous on purpose: this is asked on every action. */
  get: () => ActionPolicy;
  /**
   * Persisted before the in-memory copy changes, so a reported success is a saved rule.
   *
   * WHO, and not why. The reasoning behind a change belongs in the audit trail beside the change
   * itself, where a reader is already looking and where it cannot be overwritten by the next save;
   * `routes.ts` writes that row. This table holds what is in force now.
   */
  set: (policy: ActionPolicy, by?: string) => Promise<void>;
  /** Back to what configuration says, forgetting the saved one. */
  reset: () => Promise<void>;
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

  return {
    get: () => current,

    set: async (policy, by) => {
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
    },

    reset: async () => {
      // The saved policy is removed rather than overwritten with the configured one, so "reset" means
      // this deployment has no boundary of its own again, and changing what configuration says then
      // changes what it enforces, which is what an operator expects of a reset.
      if (database) {
        await database.delete(actionPolicy).where(eq(actionPolicy.id, CURRENT));
      }
      current = clone(configured);
    },

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
 */
export function parseActionPolicy(
  input: unknown,
): { ok: true; policy: ActionPolicy } | { ok: false; error: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "A policy must be an object." };
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
    console.warn(
      JSON.stringify({
        type: "computer-policy-mode-ignored",
        was: candidate.mode,
        now: "enforce",
      }),
    );
  }

  const lists: Record<"deny" | "ask" | "allow", string[]> = {
    deny: [],
    ask: [],
    allow: [],
  };
  for (const key of ["deny", "ask", "allow"] as const) {
    const value = candidate[key] ?? [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      return { ok: false, error: `${key} must be a list of expressions.` };
    }
    lists[key] = value as string[];
  }

  // Absent means allowed, like `ask` defaulting to empty: a policy written before this existed
  // still parses and still means what it meant. Anything else is refused rather than read as one of
  // the two, because a typo silently meaning "allowed" is the direction that loosens a boundary.
  const standing = candidate.settleWithoutAsking;
  if (standing !== undefined && standing !== "allowed" && standing !== "off") {
    return {
      ok: false,
      error: 'settleWithoutAsking must be "allowed" or "off".',
    };
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
