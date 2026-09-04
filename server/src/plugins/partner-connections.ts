import { and, asc, eq } from "drizzle-orm";
import { recordAuditEvent } from "../audit";
import { lafAlimtalkTemplates, lafPartnerConnections } from "../db/schema";
import type { PartnerFamily } from "./catalogue";
import type { PluginContext } from "./store";

/**
 * One person's registration with a partner vendor, and the rows that record it.
 *
 * THE PARTNER MODEL, IN ONE PARAGRAPH. Nobody using this product will ever obtain an API key. Where
 * a vendor sells through an agency — 솔라피's message-agency account, 팝빌's 연동회원 — LAF holds the
 * one account for the whole fleet and each person is REGISTERED under it by a step they take inside
 * the product. So the credential is fleet configuration, and what belongs to a person is the handle
 * the vendor issued them: a 발신프로필 senderKey, a 사업자등록번호. That is what these rows hold.
 *
 * It is deliberately not the OAuth machinery in `connections.ts`. Nothing here rotates, nothing here
 * is spent at a token endpoint, and there is no grant to revoke at the vendor — a person
 * disconnecting stops LAF sending as their channel, and the channel itself is still theirs.
 */

/**
 * The two vendors this reaches, named by their catalogue key so one word serves everywhere.
 *
 * The TYPE is the catalogue's ({@link PartnerFamily}) and this is the runtime list, annotated
 * against it: a vendor added to one and forgotten in the other stops compiling here rather than
 * becoming a provider with no entry, no host and no reviewed tools behind it.
 */
export const PARTNER_PROVIDERS: readonly PartnerFamily[] = Object.freeze([
  "kakao-alimtalk",
  "tax-invoice",
]);

export type PartnerProvider = PartnerFamily;

export function isPartnerProvider(value: string): value is PartnerProvider {
  return (PARTNER_PROVIDERS as readonly string[]).includes(value);
}

/**
 * What a partner module needs from the store, and nothing else.
 *
 * Narrower than {@link PluginContext} on purpose, and it is what breaks the cycle: the partner
 * runtime is ASSEMBLED OUTSIDE the store and handed in as transports, so a partner module that
 * asked for the whole context would make `store.ts` import the modules that import `store.ts`. A
 * `PluginContext` still satisfies it structurally, which is what a test passing one relies on.
 */
export type PartnerContext = Pick<PluginContext, "database" | "auditStore">;

/**
 * A partner step this deployment will not take, as a fact rather than a sentence.
 *
 * The `status` travels with it because these are HTTP answers as well as refusals, and the three
 * cases a person meets are genuinely different: they typed something wrong (400), this deployment
 * holds no key for the vendor (503), the vendor said no (502). A surface that cannot tell them apart
 * can only ever say "that did not work", which is how a connector one console entry away from
 * working looks broken.
 */
export class PartnerRefusedError extends Error {
  constructor(
    readonly fact: string,
    readonly status: number = 400,
    /** What a log and a stack trace show. The surface reads `fact`, never this. */
    message: string = fact,
  ) {
    super(message);
    this.name = "PartnerRefusedError";
  }
}

export type PartnerConnection = {
  provider: PartnerProvider;
  userId: string;
  /** The vendor's handle. Never crosses back to a browser — see the column's own note. */
  account: string;
  details: Record<string, unknown>;
  status: string;
  connectedAt: string;
};

/** LAF's own name for a template, its vendor id, and where its inspection got to. */
export type AlimtalkTemplateRow = {
  code: string;
  templateId: string;
  status: "pending" | "approved" | "rejected";
  reason: string;
  checkedAt: string | null;
};

export function createPartnerConnections(context: PartnerContext) {
  const { database, auditStore } = context;

  const toConnection = (
    row: typeof lafPartnerConnections.$inferSelect,
  ): PartnerConnection => ({
    provider: row.provider as PartnerProvider,
    userId: row.userId,
    account: row.account,
    details: (row.details ?? {}) as Record<string, unknown>,
    status: row.status,
    connectedAt: row.connectedAt.toISOString(),
  });

  const toTemplate = (
    row: typeof lafAlimtalkTemplates.$inferSelect,
  ): AlimtalkTemplateRow => ({
    code: row.code,
    templateId: row.templateId,
    // Read back as whatever the column holds, narrowed to the three the surface draws: a status this
    // build does not know is a row that still exists, and "pending" is the honest reading of one.
    status:
      row.status === "approved" || row.status === "rejected"
        ? row.status
        : "pending",
    reason: row.reason,
    checkedAt: row.checkedAt?.toISOString() ?? null,
  });

  /**
   * One person dropping their own registration.
   *
   * Local only, and it says so. There is nothing to revoke at the vendor: the 카카오톡 채널 and the
   * 팝빌 회원 are the person's own and outlive this row. What stops is LAF sending as them, which is
   * the whole of what this deployment was doing on their behalf.
   *
   * A named function rather than a method, because `retireFor` below calls it: a method reached
   * through `this` breaks the moment somebody destructures this object, which is exactly how the
   * store hands these out.
   */
  async function removeConnection(input: {
    provider: PartnerProvider;
    userId: string;
    by: string;
    reason: string;
  }): Promise<{ disconnected: boolean }> {
    const removed = await database
      .delete(lafPartnerConnections)
      .where(
        and(
          eq(lafPartnerConnections.provider, input.provider),
          eq(lafPartnerConnections.userId, input.userId),
        ),
      )
      .returning({ userId: lafPartnerConnections.userId });
    if (removed.length === 0) return { disconnected: false };

    if (input.provider === "kakao-alimtalk") {
      // The template rows belong to a 발신프로필 nothing here points at any more. Left behind they
      // would tell the next connect that LAF's templates are already registered under a channel
      // this deployment can no longer name.
      await database
        .delete(lafAlimtalkTemplates)
        .where(eq(lafAlimtalkTemplates.userId, input.userId));
    }

    await recordAuditEvent(auditStore, {
      eventType: "mcp.account_disconnected",
      targetType: "mcp_server",
      targetId: input.provider,
      payload: {
        actor: input.by,
        server: input.provider,
        owner: input.userId,
        reason: input.reason,
        // Said out loud rather than left to be assumed: this deployment stopped holding the
        // registration and nothing was withdrawn at the vendor.
        vendorRevoked: false,
      },
    });
    return { disconnected: true };
  }

  return {
    async find(
      provider: PartnerProvider,
      userId: string,
    ): Promise<PartnerConnection | null> {
      // The anonymous actor is the empty string, and an empty string must never match a row — the
      // same rule the OAuth connections keep, and for the same reason: a run nobody can be held
      // accountable for must not pick up somebody's channel.
      if (!userId) return null;
      const [row] = await database
        .select()
        .from(lafPartnerConnections)
        .where(
          and(
            eq(lafPartnerConnections.provider, provider),
            eq(lafPartnerConnections.userId, userId),
          ),
        )
        .limit(1);
      return row ? toConnection(row) : null;
    },

    /** Every partner connection this person has, for their own card list. */
    async listFor(userId: string): Promise<PartnerConnection[]> {
      if (!userId) return [];
      const rows = await database
        .select()
        .from(lafPartnerConnections)
        .where(eq(lafPartnerConnections.userId, userId))
        .orderBy(asc(lafPartnerConnections.provider));
      return rows.map(toConnection);
    },

    /**
     * Write the registration, replacing whatever was there.
     *
     * Upserted on the pair, so registering again — a person who moved their channel, a business that
     * changed its 담당자 — is the same act as registering the first time. The trail row is
     * `mcp.account_connected` rather than a type of its own: it is the same fact those rows already
     * carry, one person attaching their own account at a vendor, and `scope` says which handle in a
     * form that names nothing private.
     */
    async save(input: {
      provider: PartnerProvider;
      userId: string;
      account: string;
      details: Record<string, unknown>;
      /** What the trail may say about the handle. Never the handle itself. */
      label: string;
    }): Promise<{ replaced: boolean }> {
      const [existing] = await database
        .select({ userId: lafPartnerConnections.userId })
        .from(lafPartnerConnections)
        .where(
          and(
            eq(lafPartnerConnections.provider, input.provider),
            eq(lafPartnerConnections.userId, input.userId),
          ),
        )
        .limit(1);

      await database
        .insert(lafPartnerConnections)
        .values({
          provider: input.provider,
          userId: input.userId,
          account: input.account,
          details: input.details,
          status: "linked",
        })
        .onConflictDoUpdate({
          target: [
            lafPartnerConnections.provider,
            lafPartnerConnections.userId,
          ],
          set: {
            account: input.account,
            details: input.details,
            status: "linked",
            updatedAt: new Date(),
          },
        });

      await recordAuditEvent(auditStore, {
        eventType: "mcp.account_connected",
        targetType: "mcp_server",
        targetId: input.provider,
        payload: {
          actor: input.userId,
          server: input.provider,
          scope: input.label,
          reconnected: existing !== undefined,
        },
      });
      return { replaced: existing !== undefined };
    },

    remove: removeConnection,

    /**
     * Every partner registration belonging to one person, gone.
     *
     * For an offboarding. The rows cascade on the user row being deleted, but a withdrawal that
     * merely stops paying for a VM leaves the person row in place for a while, and "we removed their
     * access" has to be true of the thing that matters — which here is the senderKey this deployment
     * would otherwise still send with.
     */
    async retireFor(userId: string, by: string): Promise<{ retired: number }> {
      if (!userId) return { retired: 0 };
      const held = await database
        .select({ provider: lafPartnerConnections.provider })
        .from(lafPartnerConnections)
        .where(eq(lafPartnerConnections.userId, userId));

      let retired = 0;
      for (const row of held) {
        const provider = row.provider;
        if (!isPartnerProvider(provider)) continue;
        const { disconnected } = await removeConnection({
          provider,
          userId,
          by,
          reason: "person_removed",
        });
        if (disconnected) retired += 1;
      }
      return { retired };
    },

    /** LAF's standard templates as they stand under this person's channel. */
    async templatesFor(userId: string): Promise<AlimtalkTemplateRow[]> {
      if (!userId) return [];
      const rows = await database
        .select()
        .from(lafAlimtalkTemplates)
        .where(eq(lafAlimtalkTemplates.userId, userId))
        .orderBy(asc(lafAlimtalkTemplates.code));
      return rows.map(toTemplate);
    },

    /** One template's id and inspection status, as the vendor last reported it. */
    async recordTemplate(input: {
      userId: string;
      code: string;
      templateId: string;
      status: AlimtalkTemplateRow["status"];
      reason: string;
    }): Promise<void> {
      const now = new Date();
      await database
        .insert(lafAlimtalkTemplates)
        .values({
          userId: input.userId,
          code: input.code,
          templateId: input.templateId,
          status: input.status,
          reason: input.reason,
          checkedAt: now,
        })
        .onConflictDoUpdate({
          target: [lafAlimtalkTemplates.userId, lafAlimtalkTemplates.code],
          set: {
            templateId: input.templateId,
            status: input.status,
            reason: input.reason,
            checkedAt: now,
            updatedAt: now,
          },
        });
    },
  };
}

export type PartnerConnections = ReturnType<typeof createPartnerConnections>;
