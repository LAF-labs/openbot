/**
 * "Do not ask me about this again", and exactly how much of it that covers.
 *
 * `approvals.ts` next door is one yes for one action: ten minutes wide, bound to a hash of the very
 * thing a person was shown, single use. That is what consent looks like, and it is the wrong shape
 * for a Bot that works all day. A person who has told the same Bot four times that it may read the
 * weather site is not consenting on the fourth press; they are clearing an obstacle. The docstring
 * on the approval card says it plainly — an ask rule that gets reflexively approved is worse than no
 * rule at all, because it produces a record of consent nobody actually gave. So this exists to let
 * somebody answer the wider question once, deliberately, and see what they answered.
 *
 * THE SCOPE IS THE WHOLE DESIGN. A standing allowance cannot be bound to a fingerprint — a ref
 * belongs to one snapshot and the next render invents a new one, so such an allowance would match
 * nothing and the button would be a lie. It is bound instead to the coarsest thing a person can hold
 * in their head and check afterwards: this host, this file, or this tool. That is a real widening of
 * the boundary, and three things pay for it:
 *
 *   the surface prints the scope on the button, so the widening is what was agreed to rather than
 *   what was inferred;
 *   the row keeps who granted it, when, and the sentence they were reading at the time;
 *   `deny` never gets here. Only an `ask` can be answered this way, so nothing a deployment has
 *   forbidden can be un-forbidden by somebody pressing a button at the end of a long task.
 *
 * The rule is part of the key, so rewriting the boundary asks again. A different rule stopping the
 * same action is a different question, and consent to one is not consent to the other.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { computerStandingApprovals } from "../db/schema/computer";

/**
 * What an allowance covers, in the terms the person granting it is shown.
 *
 * Three kinds and no more, because a fourth would be a kind nobody can predict from the sentence on
 * the button. `host` is every action on one site, `file` is one path, `tool` is one tool by name.
 */
export type AllowanceScope = {
  kind: "host" | "file" | "tool";
  value: string;
};

/**
 * The scope an action falls under, from the same fields the policy was given.
 *
 * Ordered by how specific each is, most specific first — a call that names a file is about that
 * file whatever page happened to be open, and one that names neither a file nor a host is about
 * nothing but itself.
 *
 * A FILE IS ONE FILE, deliberately, and it is the narrow end of a trade. A Bot writing twenty
 * reports asks twenty times, which is worse than it sounds until you consider the alternative: one
 * question about one file buying permission to write any file at all is not a widening anybody
 * pressing that button would have predicted. Somebody who genuinely wants the broader thing has the
 * broader tool — an `allow` rule in the policy — and this is a convenience for a repeated identical
 * question, not a policy editor with one button.
 *
 * `tool` is the fallback rather than a case, and it is what a call to somebody else's server always
 * lands on: an MCP tool has no host and no path, only a name. Note what that means for a tool that
 * writes: the approval it replaces was bound to the arguments, and this one is not. It is the widest
 * grant this module can produce and the sentence on the button says so.
 */
export function allowanceFor(subject: {
  /** The tool's name, or for a call to another server, the reference that identifies it. */
  tool: string;
  host?: string | undefined;
  filePath?: string | undefined;
}): AllowanceScope {
  const filePath = subject.filePath?.trim();
  if (filePath) return { kind: "file", value: filePath };
  const host = subject.host?.trim();
  if (host) return { kind: "host", value: host };
  return { kind: "tool", value: subject.tool };
}

/** The scope as one string, which is what the row is keyed on. */
export function scopeKeyOf(scope: AllowanceScope): string {
  return `${scope.kind}=${scope.value}`;
}

export type StandingApproval = {
  id: string;
  botId: string;
  /** The expression that asked. Empty when the floor asked rather than a written rule. */
  rule: string;
  scope: string;
  scopeKind: AllowanceScope["kind"];
  scopeValue: string;
  /** The sentence the person was reading when they granted it. */
  question: string;
  grantedBy: string;
  grantedAt: string;
  revokedAt?: string;
  revokedBy?: string;
};

export type StandingGrant = {
  botId: string;
  rule: string;
  scope: AllowanceScope;
  question: string;
  grantedBy: string;
};

export type StandingApprovalStore = {
  /**
   * The live allowance covering this action, or null.
   *
   * On the hot path of every asked action, before a question is opened. Null is the answer for a
   * revoked one, which is what makes revoking mean anything.
   */
  find: (
    botId: string,
    rule: string,
    scope: string,
  ) => Promise<StandingApproval | null>;
  /**
   * Grant one, or hand back the one that already stands.
   *
   * Idempotent, because two tabs showing the same question both offer the button and a person may
   * well press both. A second row would be one a later revoke does not remove.
   */
  grant: (input: StandingGrant) => Promise<StandingApproval>;
  /** Everything still standing, newest first. One Bot's, or every Bot's when none is named. */
  list: (botId?: string) => Promise<StandingApproval[]>;
  /**
   * Withdraw one. Null when it was not standing — already withdrawn, or never granted here.
   *
   * The row stays and is marked, because withdrawing an allowance is itself a decision about a
   * boundary and a row that vanishes takes the record of ever having granted it along too.
   */
  revoke: (id: string, actor: string) => Promise<StandingApproval | null>;
};

/**
 * The store, in memory.
 *
 * What the gateway's own tests run against, so a test about a boundary does not need a database.
 * Held to the same contract as the one below by `standing-approvals-contract.test.ts`; a deployment
 * runs the database one, because an allowance whose whole purpose is to outlive the turn must
 * outlive the process too.
 */
export function createStandingApprovalStore(
  options: { now?: () => number } = {},
): StandingApprovalStore {
  const now = options.now ?? (() => Date.now());
  const rows = new Map<string, StandingApproval>();

  const live = (botId: string, rule: string, scope: string) =>
    [...rows.values()].find(
      (row) =>
        row.botId === botId &&
        row.rule === rule &&
        row.scope === scope &&
        row.revokedAt === undefined,
    );

  return {
    find: async (botId, rule, scope) => live(botId, rule, scope) ?? null,

    grant: async (input) => {
      const scope = scopeKeyOf(input.scope);
      const standing = live(input.botId, input.rule, scope);
      if (standing) return standing;
      const granted: StandingApproval = {
        id: randomUUID(),
        botId: input.botId,
        rule: input.rule,
        scope,
        scopeKind: input.scope.kind,
        scopeValue: input.scope.value,
        question: input.question,
        grantedBy: input.grantedBy,
        grantedAt: new Date(now()).toISOString(),
      };
      rows.set(granted.id, granted);
      return granted;
    },

    list: async (botId) =>
      [...rows.values()]
        .filter(
          (row) =>
            row.revokedAt === undefined &&
            (botId === undefined || row.botId === botId),
        )
        .sort((left, right) => right.grantedAt.localeCompare(left.grantedAt)),

    revoke: async (id, actor) => {
      const row = rows.get(id);
      if (!row || row.revokedAt !== undefined) return null;
      const revoked: StandingApproval = {
        ...row,
        revokedAt: new Date(now()).toISOString(),
        revokedBy: actor,
      };
      rows.set(id, revoked);
      return revoked;
    },
  };
}

/**
 * The same store, where every process and every restart can see it.
 *
 * The one a deployment runs. An allowance held in a Map is withdrawn by a deploy without anybody
 * saying so, and quietly returning everybody to being asked is precisely the state this feature
 * exists to get them out of — so the Map is for tests and this is for people.
 *
 * `grant` inserts and lets the partial unique index decide the race, then reads back: two tabs
 * pressing the button at the same moment produce one live row, and both are told about that one.
 * `revoke` is `UPDATE ... WHERE revoked_at IS NULL`, so a second press is told there was nothing
 * left to withdraw rather than overwriting who withdrew it and when.
 */
export function createDatabaseStandingApprovalStore(
  database: Database,
  options: { now?: () => number } = {},
): StandingApprovalStore {
  const now = options.now ?? (() => Date.now());

  const asStanding = (
    row: typeof computerStandingApprovals.$inferSelect,
  ): StandingApproval => ({
    id: row.id,
    botId: row.botId,
    rule: row.rule,
    scope: row.scope,
    // Written by `grant` from an `AllowanceScope`, so the column only ever holds one of the three.
    scopeKind: row.scopeKind as AllowanceScope["kind"],
    scopeValue: row.scopeValue,
    question: row.question,
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt.toISOString(),
    ...(row.revokedAt === null
      ? {}
      : { revokedAt: row.revokedAt.toISOString() }),
    ...(row.revokedBy === null ? {} : { revokedBy: row.revokedBy }),
  });

  const find = async (botId: string, rule: string, scope: string) => {
    const [row] = await database
      .select()
      .from(computerStandingApprovals)
      .where(
        and(
          eq(computerStandingApprovals.botId, botId),
          eq(computerStandingApprovals.rule, rule),
          eq(computerStandingApprovals.scope, scope),
          isNull(computerStandingApprovals.revokedAt),
        ),
      );
    return row ? asStanding(row) : null;
  };

  return {
    find,

    grant: async (input) => {
      const scope = scopeKeyOf(input.scope);
      const [inserted] = await database
        .insert(computerStandingApprovals)
        .values({
          id: randomUUID(),
          botId: input.botId,
          rule: input.rule,
          scope,
          scopeKind: input.scope.kind,
          scopeValue: input.scope.value,
          question: input.question,
          grantedBy: input.grantedBy,
          grantedAt: new Date(now()),
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) return asStanding(inserted);
      // Lost the race, or it already stood: either way the answer is the row that is standing now.
      const standing = await find(input.botId, input.rule, scope);
      if (!standing) throw new Error("the allowance could not be recorded");
      return standing;
    },

    list: async (botId) => {
      const where = botId
        ? and(
            isNull(computerStandingApprovals.revokedAt),
            eq(computerStandingApprovals.botId, botId),
          )
        : isNull(computerStandingApprovals.revokedAt);
      const rows = await database
        .select()
        .from(computerStandingApprovals)
        .where(where)
        .orderBy(desc(computerStandingApprovals.grantedAt));
      return rows.map(asStanding);
    },

    revoke: async (id, actor) => {
      const [row] = await database
        .update(computerStandingApprovals)
        .set({ revokedAt: new Date(now()), revokedBy: actor })
        .where(
          and(
            eq(computerStandingApprovals.id, id),
            isNull(computerStandingApprovals.revokedAt),
          ),
        )
        .returning();
      return row ? asStanding(row) : null;
    },
  };
}
