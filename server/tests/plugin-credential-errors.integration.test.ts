import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ActionPolicy } from "../src/computer/policy";
import {
  CredentialUnavailableError,
  decryptCredentialForUse,
  encryptSecret,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  credentials as credentialRows,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * Which vault failure becomes "connect it again", and which one does not.
 *
 * The two reach a person completely differently. A withdrawn grant is nobody's fault and has an
 * obvious next step; anything else is this deployment being broken, and telling somebody to connect
 * again sends them round a loop that cannot end. So `plugins/connections.ts` converts the first into
 * a {@link PluginRefusedError} and rethrows the second.
 *
 * IT USED TO TELL THEM APART BY READING THE SENTENCE — `message.includes("revoked") ||
 * message.includes("not found")` against prose written in `credentials.ts` for a person to read. The
 * same read-the-prose pattern the plugin store's own note on `INVALID_CLIENT` records removing, and
 * it fails the same way: reword those sentences, or translate them, and every withdrawn grant starts
 * reading as a vendor outage with every test still green.
 *
 * So the last test here is the one that matters. It throws the OLD sentence, word for word, from
 * something that is not the vault's error class, and asserts it is not converted.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

/** 32 zero bytes in base64: a real AES-256 key length, which `importKey` insists on. */
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const suite = randomUUID().slice(0, 8);
const botId = `agent_credtest_${suite}`;
const serverId = `credtest-${suite}`;
const toolName = "search_things";
const ref = `${serverId}/${toolName}`;

const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

/** What the vault would hand back if it were asked, so only the reader's answer is under test. */
let envelope = "";
/** The credential row the server points at. A real one, because the pointer is a foreign key. */
let credentialId = "";

/**
 * A store that reads the vault however this test wants.
 *
 * Only `readSecret` is answered, because that is the whole seam: `decryptCredentialForUse` asks the
 * reader and then decrypts, so a reader is enough to produce every failure this path has.
 */
const storeReading = (readSecret: () => Promise<unknown>) =>
  createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: { readSecret } as never,
    encryptionKey: ENCRYPTION_KEY,
    policy: () => policy,
    approvals: createApprovalRegistry(),
    // Loud rather than absent: nothing here should reach a vendor, because every case fails while
    // the token is being fetched.
    callVendor: async () => {
      throw new Error("this suite never reaches a vendor");
    },
  });

beforeAll(async () => {
  envelope = await encryptSecret(ENCRYPTION_KEY, "the-server-token");

  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "remote_ag_ui", configuration: {} })
    .onConflictDoNothing();

  const [credential] = await database
    .insert(credentialRows)
    .values({
      kind: "mcp",
      provider: serverId,
      keyId: `token-${suite}`,
      encryptedValue: envelope,
      metadata: {},
    })
    .returning({ id: credentialRows.id });
  credentialId = credential?.id ?? "";

  /*
   * A CUSTOM server holding a deployment token, which is the shape that reaches `secretFor` on the
   * call path. A `user-oauth` server would take the per-person branch instead, and that one has its
   * own refusals well before the vault.
   */
  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Credential test server",
      vendor: "mcp.test.invalid",
      url: "https://mcp.test.invalid/mcp",
      provenance: "custom",
      credentialId,
    })
    .onConflictDoNothing();
  await database
    .insert(mcpTools)
    .values({
      serverId,
      name: toolName,
      description: "Search things.",
      // Declared read-only, so the LAF contract's guard floor does not stop the call before the
      // vault is ever asked.
      annotations: { readOnlyHint: true },
    })
    .onConflictDoNothing();

  await database
    .insert(pluginGrants)
    .values({ kind: "mcp", ref, agentId: botId, grantedBy: "admin@laf.test" })
    .onConflictDoNothing();
});

afterAll(async () => {
  await database.delete(pluginGrants).where(eq(pluginGrants.ref, ref));
  await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
  await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await database.delete(agents).where(eq(agents.id, botId));
  if (credentialId) {
    await database
      .delete(credentialRows)
      .where(eq(credentialRows.id, credentialId));
  }
});

const callWith = async (readSecret: () => Promise<unknown>) =>
  await storeReading(readSecret)
    .callTool({ ref, args: {}, botId, actorId: "someone@laf.test" })
    .catch((error: unknown) => error);

describe("a vault that cannot produce the secret", () => {
  test("a revoked credential becomes a refusal a person can act on", async () => {
    const thrown = await callWith(async () => ({
      encryptedValue: envelope,
      revokedAt: new Date(),
    }));

    expect(thrown).toBeInstanceOf(PluginRefusedError);
    expect((thrown as Error).message).toContain("no longer holds");
  });

  test("a credential that is simply gone is the same refusal", async () => {
    const thrown = await callWith(async () => null);

    expect(thrown).toBeInstanceOf(PluginRefusedError);
    expect((thrown as Error).message).toContain("no longer holds");
  });

  test("a secret this deployment cannot decrypt is NOT that refusal", async () => {
    // The row is there and live; the envelope is nonsense. Nothing about connecting again fixes a
    // deployment that cannot read its own vault, so this must reach the caller as what it is.
    const thrown = await callWith(async () => ({
      encryptedValue: "not-an-envelope",
      revokedAt: null,
    }));

    expect(thrown).not.toBeInstanceOf(PluginRefusedError);
    expect((thrown as Error).message).toContain("envelope");
  });

  /**
   * THE REGRESSION THIS CHANGE EXISTS FOR.
   *
   * The old branch would have converted this, because the sentence contains the word. The class is
   * what decides now, so a failure that merely SAYS "revoked" — a driver, a vendor library, a future
   * message in some unrelated layer — no longer gets to send somebody to the connect screen.
   */
  test("prose is not control flow: a plain error saying 'revoked' is rethrown", async () => {
    const thrown = await callWith(async () => {
      throw new Error("Credential is revoked");
    });

    expect(thrown).not.toBeInstanceOf(PluginRefusedError);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Credential is revoked");
  });

  // The other half of the same property, at the source: the vault raises its own class, and says
  // which of the two facts it could establish. `credentials.test.ts` holds the rest.
  test("the vault raises its class for both shapes of unavailable", async () => {
    for (const [readSecret, reason] of [
      [async () => null, "missing"],
      [
        async () => ({ encryptedValue: envelope, revokedAt: new Date() }),
        "revoked",
      ],
    ] as const) {
      const thrown = await decryptCredentialForUse(
        ENCRYPTION_KEY,
        { readSecret } as never,
        credentialId,
      ).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(CredentialUnavailableError);
      expect((thrown as CredentialUnavailableError).reason).toBe(reason);
    }
  });
});
