import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ActionPolicy } from "../src/computer/policy";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  credentials,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  users,
} from "../src/db/schema";
import {
  type AccessToken,
  createPluginStore,
  PluginNeedsApprovalError,
  PluginRefusedError,
  TokenRefusedError,
} from "../src/plugins/store";
import { TEST_POOL } from "./support/database";
import { realMcpModule } from "./support/mcp-module";

/**
 * Whether a connection still works, and who finds out.
 *
 * THE BUG THIS FILE IS ABOUT. `connectionsFor` returned the row and nothing else, so the settings
 * page said 연결됨 for as long as the row existed — including for a grant the vendor had revoked
 * months earlier. The refresh has always happened on every call (one exchange per call, by design);
 * it simply wrote nothing down, so nothing anywhere except a Bot failing mid-answer knew.
 *
 * So every assertion here is about a COLUMN or a REFUSAL rather than about a return value that
 * happens to look right. "The health was recorded" is a claim about rows: a double that observed
 * the write would prove only that the code called the double.
 *
 * NOTHING REACHES A VENDOR. The token exchange is injected; the tool listing is real and still
 * reaches nobody, because this entry's transport is this repository's own code; and the server row
 * names a `.invalid` host so anything that did try to leave fails at DNS.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

/** 32 zero bytes in base64: a real AES-256 key length, which `importKey` insists on. */
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const suite = randomUUID().slice(0, 8);

/** A catalogue key, because `user-oauth` behaviour exists only for an entry that declares it. */
const serverId = "google-sheets";
/**
 * A guarded tool from that entry's `guardedTools`, and a plain one beside it.
 *
 * Both are names `google-sheets-rest.ts` really advertises, because the listing here is REAL: that
 * entry's transport is this repository's own code, so `refreshTools` produces the actual tool rows
 * without a network call and without anybody's credential. Seeding rows by hand instead would make
 * the first refresh see a definition it had never consented to and pause every tool for review.
 */
const guardedTool = "update_sheet_values";
const plainTool = "read_sheet_values";
const ref = `${serverId}/${plainTool}`;
/**
 * Arguments both tools' schemas accept. These calls used to carry `{}`, which was fine while the
 * first look at the arguments was the vendor's; since 2026-09-06 the call path refuses a call
 * missing a `required` property before the credential is even chosen (`laf:tool_arguments_invalid`),
 * and a refusal there is exactly the exchange this file exists to reach past.
 */
const ARGS = { spreadsheetId: "sheet-health", range: "주문", values: [["1"]] };
/** Every tool that entry offers, so "every advertised tool" is a set rather than the two named. */
const everyTool = [
  "list_sheet_tabs",
  "read_sheet_values",
  "append_sheet_row",
  "update_sheet_values",
];

const asker = `user_health_asker_${suite}`;
const other = `user_health_other_${suite}`;
/**
 * Somebody who connects and is never called through.
 *
 * Their own person rather than a reuse of `asker`, because the fact under test is the ABSENCE of a
 * date: `recordConnection` deliberately leaves `last_ok_at` alone (a consent is not an exchange),
 * so a person who has already had one successful call carries that date through every reconnect
 * and the assertion would be about the order these tests happen to run in.
 */
const newcomer = `user_health_new_${suite}`;
const everybody = [asker, other, newcomer];

/** Two Bots this person owns, because "every Bot they own" is the claim a connect makes. */
const firstBot = `agent_health_one_${suite}`;
const secondBot = `agent_health_two_${suite}`;
/** And one that is somebody else's, so a grant reaching it would be visible. */
const strangersBot = `agent_health_other_${suite}`;
const bots = [firstBot, secondBot, strangersBot];
/**
 * A Bot of the asker's made AFTER the connect. Not in `bots`, because it must not exist while the
 * connect-time grants are counted; it is made by the test that is about it and removed with the rest.
 */
const laterBot = `agent_health_later_${suite}`;

const policy: ActionPolicy = { deny: [], ask: [], allow: ["true"] };

/* ── the seams ───────────────────────────────────────────────────────────────────────────────── */

const exchanged: string[] = [];
let exchange: (input: { refreshToken: string }) => Promise<AccessToken> =
  async ({ refreshToken }) => ({
    accessToken: `access(${refreshToken})`,
  });

/** What the vendor's API answers once the exchange has worked. Reset by the tests that care. */
const vendorAnswers = () => ({
  text: "[no vendor is reached here]",
  isError: false,
});
let vendorReply: () => { text: string; isError: boolean; status?: number } =
  vendorAnswers;

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: createCredentialStore(database),
  encryptionKey: ENCRYPTION_KEY,
  policy: () => policy,
  approvals: createApprovalRegistry(),
  sharedClient: (family) =>
    family === "google"
      ? { clientId: "fleet-google", clientSecret: "fleet-secret" }
      : null,
  callVendor: async () => vendorReply(),
  exchangeRefreshToken: async (input) => {
    exchanged.push(input.refreshToken);
    return await exchange(input);
  },
  registerClient: async () => null,
});

/* ── reading what was written ────────────────────────────────────────────────────────────────── */

/** The health columns as the database holds them, which is what the page and the tool path read. */
async function healthRow(userId: string) {
  const [row] = await database
    .select({
      lastOkAt: mcpUserCredentials.lastOkAt,
      lastFailureAt: mcpUserCredentials.lastFailureAt,
      lastFailureCode: mcpUserCredentials.lastFailureCode,
    })
    .from(mcpUserCredentials)
    .where(
      and(
        eq(mcpUserCredentials.serverId, serverId),
        eq(mcpUserCredentials.userId, userId),
      ),
    );
  return row ?? null;
}

/** What `connectionsFor` says about this person's one connection. */
async function reported(userId: string) {
  const listed = await store.connectionsFor(userId);
  return listed.find((row) => row.serverId === serverId) ?? null;
}

/** Every Bot holding a grant on one ref, so "reached every Bot" is a set rather than a count. */
async function granted(toolRef: string): Promise<string[]> {
  const rows = await database
    .select({ agentId: pluginGrants.agentId })
    .from(pluginGrants)
    .where(and(eq(pluginGrants.kind, "mcp"), eq(pluginGrants.ref, toolRef)));
  return rows.map((row) => row.agentId).sort();
}

/** A connection in the state a fresh consent leaves it in. */
async function connect(userId: string, refreshToken: string) {
  await store.recordConnection({
    serverId,
    userId,
    refreshToken,
    scope: "read",
  });
}

/** Write a failure straight onto the row, for the tests about what a recorded failure DOES. */
async function markFailed(userId: string, code: string) {
  await database
    .update(mcpUserCredentials)
    .set({ lastFailureAt: new Date(), lastFailureCode: code })
    .where(
      and(
        eq(mcpUserCredentials.serverId, serverId),
        eq(mcpUserCredentials.userId, userId),
      ),
    );
}

beforeAll(async () => {
  // The real error classes, whatever another suite left in the registry: one test below hands the
  // call path a thrown `McpServerError`, and the class it checks has to be the class thrown.
  mock.module("../src/plugins/mcp", () => realMcpModule);

  for (const id of everybody) {
    await database
      .insert(users)
      .values({ id, email: `${id}@laf.test`, name: id, emailVerified: false })
      .onConflictDoNothing();
  }
  for (const id of bots) {
    await database
      .insert(agents)
      .values({ id, name: id, type: "remote_ag_ui", configuration: {} })
      .onConflictDoNothing();
    await database
      .insert(agentProfiles)
      .values({
        agentId: id,
        ownerUserId: id === strangersBot ? other : asker,
        roleDescription: "",
        avatarSeed: id,
      })
      .onConflictDoNothing();
  }

  /*
   * Written directly rather than through `addServer`, which would reach for a credential on the way
   * in. The URL is a `.invalid` host, so anything that did try to leave this machine fails at DNS
   * rather than arriving at Google.
   */
  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Google Sheets",
      vendor: "Google",
      url: "https://sheets.test.invalid/mcp",
      provenance: "first-party",
    })
    .onConflictDoNothing();
  /*
   * The tool rows, through the product's own path rather than by hand — see `plainTool` above. The
   * Sheets transport answers from this repository's code, so this reaches nobody.
   */
  await store.refreshTools(serverId);

  // The Bot holds the plain tool throughout: what these tests are about is the person's connection,
  // not the grant, and `callTool` refuses on a missing grant long before it looks at either.
  await database
    .insert(pluginGrants)
    .values({ kind: "mcp", ref, agentId: firstBot })
    .onConflictDoNothing();
});

afterAll(async () => {
  const everyBot = [...bots, laterBot];
  await database
    .delete(pluginGrants)
    .where(inArray(pluginGrants.agentId, everyBot));
  await database
    .delete(mcpUserCredentials)
    .where(inArray(mcpUserCredentials.userId, everybody));
  await database
    .delete(credentials)
    .where(
      and(
        eq(credentials.kind, "mcp_user_token"),
        inArray(credentials.keyId, everybody),
      ),
    );
  await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
  await database
    .delete(agentProfiles)
    .where(inArray(agentProfiles.agentId, everyBot));
  await database.delete(agents).where(inArray(agents.id, everyBot));
  await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await database.delete(users).where(inArray(users.id, everybody));
});

describe("what one exchange writes down about a connection", () => {
  test("a call that works records when, and clears whatever failure was standing", async () => {
    await connect(asker, "rt-ok-1");
    // A failure from before, so the clearing half is visible rather than assumed.
    await markFailed(asker, "vendor_down");
    exchange = async ({ refreshToken }) => ({
      accessToken: `access(${refreshToken})`,
    });
    const before = Date.now();

    await store.callTool({ ref, args: ARGS, botId: firstBot, actorId: asker });

    const health = await healthRow(asker);
    expect(health?.lastFailureAt).toBeNull();
    expect(health?.lastFailureCode).toBeNull();
    expect(health?.lastOkAt?.getTime() ?? 0).toBeGreaterThanOrEqual(before - 1);
  });

  /*
   * The success write shares the transaction with the rotation, which is the property worth pinning
   * rather than the write on its own: a `last_ok_at` that committed beside a rotation that rolled
   * back would claim a healthy connection while pointing at a token the vendor had already killed.
   */
  test("the rotated token and the healthy mark land together", async () => {
    await connect(asker, "rt-rotate-1");
    exchange = async ({ refreshToken }) => ({
      accessToken: `access(${refreshToken})`,
      refreshToken: "rt-rotate-2",
    });

    await store.callTool({ ref, args: ARGS, botId: firstBot, actorId: asker });

    const [stored] = await database
      .select({ encryptedValue: credentials.encryptedValue })
      .from(credentials)
      .where(
        and(
          eq(credentials.kind, "mcp_user_token"),
          eq(credentials.keyId, asker),
        ),
      );
    expect(stored).toBeDefined();
    expect((await healthRow(asker))?.lastOkAt).not.toBeNull();
  });

  test("the vendor disowning the grant is recorded as `revoked`", async () => {
    await connect(asker, "rt-revoked-1");
    exchange = async () => {
      throw new TokenRefusedError("the vendor said no (400)", "invalid_grant");
    };

    await store
      .callTool({ ref, args: ARGS, botId: firstBot, actorId: asker })
      .catch(() => undefined);

    const health = await healthRow(asker);
    expect(health?.lastFailureCode).toBe("revoked");
    expect(health?.lastFailureAt).not.toBeNull();
  });

  test("any other refusal from the token endpoint is `refresh_failed`", async () => {
    await connect(asker, "rt-refused-1");
    exchange = async () => {
      throw new TokenRefusedError("the vendor said no (400)", "invalid_scope");
    };

    await store
      .callTool({ ref, args: ARGS, botId: firstBot, actorId: asker })
      .catch(() => undefined);

    expect((await healthRow(asker))?.lastFailureCode).toBe("refresh_failed");
  });

  /*
   * A timeout is not a revocation, and the difference is the whole point of having three words: one
   * says "consent again", the other says "wait". Getting this wrong would put 다시 연결 in front of
   * every connection in the deployment during one outage.
   */
  test("a vendor that could not be reached at all is `vendor_down`", async () => {
    await connect(asker, "rt-down-1");
    exchange = async () => {
      throw new Error("connect ETIMEDOUT");
    };

    await store
      .callTool({ ref, args: ARGS, botId: firstBot, actorId: asker })
      .catch(() => undefined);

    expect((await healthRow(asker))?.lastFailureCode).toBe("vendor_down");
  });

  /*
   * THE FIRST LIE THE AUDIT MEASURED (2026-09-10, A9 F2). A token endpoint answering 503 or 429 is
   * still a `TokenRefusedError` — the response is not `ok`, and a defensive reader finds whatever
   * `error` the body carries — and judged on the code alone it was `refresh_failed`: 다시 연결 in
   * front of every connection on this VM for one bad five minutes at Google, and still there after
   * Google came back, because the row does not clear itself.
   */
  test("a token endpoint that cannot answer anybody is `vendor_down`, not a reason to reconnect", async () => {
    for (const [status, code] of [
      [503, "internal_failure"],
      [429, "rate_limited"],
    ] as const) {
      await connect(asker, `rt-outage-${status}`);
      exchange = async () => {
        throw new TokenRefusedError(
          `the vendor could not answer (${status})`,
          code,
          status,
        );
      };

      await store
        .callTool({ ref, args: ARGS, botId: firstBot, actorId: asker })
        .catch(() => undefined);

      expect({
        status,
        code: (await healthRow(asker))?.lastFailureCode,
        health: (await reported(asker))?.health.status,
      }).toEqual({ status, code: "vendor_down", health: "ok" });
    }

    // And the next call goes to the vendor, because an outage is the failure that comes back.
    exchanged.length = 0;
    exchange = async ({ refreshToken }) => ({
      accessToken: `access(${refreshToken})`,
    });
    await store.callTool({ ref, args: ARGS, botId: firstBot, actorId: asker });
    expect(exchanged).toEqual(["rt-outage-429"]);
  });

  /*
   * THE ONE REFUSAL THAT IS RECORDED NOWHERE, and the reason is amplification. `invalid_client` is
   * the vendor disowning the DEPLOYMENT's client — every connection on this VM gets it at once —
   * and `oauth-client.ts` measured that it is also what a vendor that is simply down answers every
   * exchange with. Written to the row it would put every person behind 다시 연결 for one outage and
   * leave them there after the vendor came back.
   */
  test("the vendor disowning our client is not this person's connection failing", async () => {
    await connect(asker, "rt-client-1");
    const before = await healthRow(asker);
    exchange = async () => {
      throw new TokenRefusedError("the vendor said no (401)", "invalid_client");
    };

    await store
      .callTool({ ref, args: ARGS, botId: firstBot, actorId: asker })
      .catch(() => undefined);

    expect(await healthRow(asker)).toEqual(before);
  });

  /*
   * The refusals this deployment issues about ITS OWN state — the row is gone, the grant was
   * withdrawn while the call queued — are not the vendor's verdict on the connection, and writing
   * them as one would mark a connection dead on the strength of a race.
   */
  test("our own refusal is not recorded as the vendor's", async () => {
    await connect(other, "rt-untouched-1");
    const before = await healthRow(other);
    exchange = async () => {
      throw new Error("never reached");
    };

    // Nobody's run: refused before the connection is even looked up.
    await store
      .callTool({ ref, args: ARGS, botId: firstBot, actorId: "" })
      .catch(() => undefined);

    expect(await healthRow(other)).toEqual(before);
  });
});

describe("what the connections list says about it", () => {
  test("a connection nothing has called through is ok, not broken", async () => {
    await store.recordConnection({
      serverId,
      userId: newcomer,
      refreshToken: "rt-fresh-1",
      scope: "read",
    });

    expect(await reported(newcomer)).toMatchObject({
      serverId,
      health: {
        status: "ok",
        lastOkAt: null,
        lastFailureAt: null,
        failureCode: null,
      },
    });
  });

  test("only the two codes a person can answer become needs_reconnect", async () => {
    await connect(asker, "rt-status-1");

    for (const code of ["revoked", "refresh_failed"]) {
      await markFailed(asker, code);
      expect(await reported(asker)).toMatchObject({
        health: { status: "needs_reconnect", failureCode: code },
      });
    }

    // The transient one is still reported — a screen may say "잠시 문제가 있었어요" — and still `ok`,
    // because nothing is being asked of anybody.
    await markFailed(asker, "vendor_down");
    expect(await reported(asker)).toMatchObject({
      health: { status: "ok", failureCode: "vendor_down" },
    });
  });

  test("a code this build does not know is no code at all", async () => {
    await connect(asker, "rt-unknown-1");
    await markFailed(asker, "something_a_later_build_wrote");

    // Narrowed rather than cast: the column is text, and the surface has no words for a value this
    // build has never heard of. `ok` because nothing here says a person has to do anything.
    expect(await reported(asker)).toMatchObject({
      health: { status: "ok", failureCode: null },
    });
  });

  test("connecting again is what lifts it", async () => {
    await connect(asker, "rt-reconnect-1");
    await markFailed(asker, "revoked");
    expect((await reported(asker))?.health.status).toBe("needs_reconnect");

    await connect(asker, "rt-reconnect-2");

    expect(await reported(asker)).toMatchObject({
      health: { status: "ok", failureCode: null, lastFailureAt: null },
    });
  });
});

describe("a connection the last exchange proved dead", () => {
  /*
   * Refused BEFORE the vendor is contacted, and that is not merely a saved round trip. The token in
   * that row is one the vendor already refused, and presenting it again is what refresh-token-reuse
   * detection punishes: a vendor that reads the second presentation as a replay revokes the whole
   * family, so a Bot retrying politely every few minutes turns a recoverable connection into one
   * nothing can recover.
   */
  test("refuses with `laf:needs_reconnect` without asking the vendor", async () => {
    await connect(asker, "rt-dead-1");
    await markFailed(asker, "revoked");
    exchanged.length = 0;
    exchange = async () => {
      throw new Error("the vendor must not be reached");
    };

    const thrown = await store
      .callTool({ ref, args: ARGS, botId: firstBot, actorId: asker })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(PluginRefusedError);
    // The CODE, not the sentence: the English is a placeholder and the Korean the Bot reads is
    // looked up from this (`shared/prompt/tool-results.ko.ts`).
    expect((thrown as PluginRefusedError).code).toBe("laf:needs_reconnect");
    expect(exchanged).toEqual([]);
  });

  test("a transient failure is not a refusal", async () => {
    await connect(asker, "rt-transient-1");
    await markFailed(asker, "vendor_down");
    exchanged.length = 0;
    exchange = async ({ refreshToken }) => ({
      accessToken: `access(${refreshToken})`,
    });

    await store.callTool({ ref, args: ARGS, botId: firstBot, actorId: asker });

    expect(exchanged).toEqual(["rt-transient-1"]);
  });

  test("connecting again makes the call possible", async () => {
    await connect(asker, "rt-again-1");
    await markFailed(asker, "refresh_failed");
    await connect(asker, "rt-again-2");
    exchanged.length = 0;
    exchange = async ({ refreshToken }) => ({
      accessToken: `access(${refreshToken})`,
    });

    await store.callTool({ ref, args: ARGS, botId: firstBot, actorId: asker });

    expect(exchanged).toEqual(["rt-again-2"]);
  });

  test("somebody who never connected is told that instead, with its own code", async () => {
    await database
      .delete(mcpUserCredentials)
      .where(
        and(
          eq(mcpUserCredentials.serverId, serverId),
          eq(mcpUserCredentials.userId, other),
        ),
      );

    /*
     * Through their OWN Bot, holding the tool for the length of this test. Since 2026-09 a person
     * calls a tool only through a Bot that is theirs (or nobody's), so through `firstBot`, which
     * is the asker's, they would be refused as not the Bot's person (`laf:bot_not_found`) before
     * their connection was ever looked at. The grant is taken back afterwards because the suite
     * below counts which Bots hold one.
     */
    await database
      .insert(pluginGrants)
      .values({ kind: "mcp", ref, agentId: strangersBot })
      .onConflictDoNothing();
    const thrown = await store
      .callTool({ ref, args: ARGS, botId: strangersBot, actorId: other })
      .catch((error: unknown) => error);
    await database
      .delete(pluginGrants)
      .where(eq(pluginGrants.agentId, strangersBot));

    expect((thrown as PluginRefusedError).code).toBe("laf:not_connected");
  });
});

/*
 * WHAT A CONNECT REACHES. Until 2026-09 the answer was nothing: the OAuth callback stored a
 * credential and stopped, so the settings page said 연결됨 and every Bot the person owned still had
 * no tool. Only the admin-only refresh could grant one, and only an administrator could press it.
 */
describe("a connection somebody just made, on the Bots they own", () => {
  test("grants every advertised tool to every Bot of theirs, and to nobody else's", async () => {
    await connect(asker, "rt-grants-1");
    exchange = async ({ refreshToken }) => ({
      accessToken: `access(${refreshToken})`,
    });

    await store.offerToolsTo(serverId, asker, asker);

    for (const name of everyTool) {
      expect({ name, bots: await granted(`${serverId}/${name}`) }).toEqual({
        name,
        bots: [firstBot, secondBot].sort(),
      });
    }
    expect(await granted(ref)).not.toContain(strangersBot);
  });

  /*
   * GRANTING IS NOT PERMISSION TO ACT UNASKED. The guard floor is decided on the call, not on the
   * grant, so the connect making a `destructive` tool reachable must not also make it quiet. This
   * is the assertion that keeps "a connect grants" from becoming "a connect waives the boundary".
   */
  test("a guarded tool still stops and asks the first time a Bot reaches for it", async () => {
    await connect(asker, "rt-guard-1");
    exchange = async ({ refreshToken }) => ({
      accessToken: `access(${refreshToken})`,
    });
    await store.offerToolsTo(serverId, asker, asker);

    const thrown = await store
      .callTool({
        ref: `${serverId}/${guardedTool}`,
        args: ARGS,
        botId: firstBot,
        actorId: asker,
      })
      .catch((error: unknown) => error);

    // The policy above allows everything, so nothing but the catalogue's own floor can stop this.
    expect(thrown).toBeInstanceOf(PluginNeedsApprovalError);
  });

  test("disconnecting takes them back from their Bots and leaves everybody else's alone", async () => {
    await connect(asker, "rt-withdraw-1");
    await store.offerToolsTo(serverId, asker, asker);
    // Somebody else's Bot holds one too, by an administrator's separate decision.
    await store.grant("mcp", ref, strangersBot, "admin@laf.test");

    await store.withdrawToolsFrom(serverId, asker, asker);

    expect(await granted(ref)).toEqual([strangersBot]);
    expect(await granted(`${serverId}/${guardedTool}`)).toEqual([]);
    // The server row is the DEPLOYMENT's and stays: on a shared one, somebody else is connected to
    // it, and removing it here would take their connector with it.
    const [row] = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId));
    expect(row?.id).toBe(serverId);
  });
});

/*
 * THE SECOND LIE THE AUDIT MEASURED (2026-09-10, A9 F3). An exchange that works proves the refresh
 * token is alive and nothing else; the access token it minted can still be refused by the API — a
 * grant missing a scope, an account whose workspace administrator blocked the app. Every such call
 * failed, and the row recorded a SUCCESS each time: `last_ok_at` moved forward, the card said 연결됨.
 */
describe("what the vendor's API answers after a good exchange", () => {
  const ok: typeof exchange = async ({ refreshToken }) => ({
    accessToken: `access(${refreshToken})`,
  });

  // The disconnect above took the Bot's grant back; these are about the connection, not the grant.
  beforeAll(async () => {
    await database
      .insert(pluginGrants)
      .values({ kind: "mcp", ref, agentId: firstBot })
      .onConflictDoNothing();
  });

  test("a 401 is a grant that no longer works: recorded, and the next call refused unasked", async () => {
    await connect(asker, "rt-api-401");
    exchange = ok;
    vendorReply = () => ({
      text: "Google Sheets refused this request (401): Invalid Credentials",
      isError: true,
      status: 401,
    });

    const result = await store.callTool({
      ref,
      args: ARGS,
      botId: firstBot,
      actorId: asker,
    });
    expect(result.isError).toBe(true);

    expect((await healthRow(asker))?.lastFailureCode).toBe("refresh_failed");
    expect((await reported(asker))?.health.status).toBe("needs_reconnect");

    // Refused before the vendor is contacted, exactly as a refused exchange is.
    exchanged.length = 0;
    vendorReply = vendorAnswers;
    const thrown = await store
      .callTool({ ref, args: ARGS, botId: firstBot, actorId: asker })
      .catch((error: unknown) => error);
    expect((thrown as PluginRefusedError).code).toBe("laf:needs_reconnect");
    expect(exchanged).toEqual([]);
  });

  test("a 503 from the API is the vendor being down, and the connection stays ok", async () => {
    await connect(asker, "rt-api-503");
    exchange = ok;
    vendorReply = () => ({
      text: "Google Sheets refused this request (503).",
      isError: true,
      status: 503,
    });

    await store.callTool({ ref, args: ARGS, botId: firstBot, actorId: asker });

    expect((await healthRow(asker))?.lastFailureCode).toBe("vendor_down");
    expect((await reported(asker))?.health.status).toBe("ok");
    vendorReply = vendorAnswers;
  });

  test("a 403 says nothing about the connection", async () => {
    // Google answers 403 for an API not enabled on the project as well as for a missing scope, and
    // only the first is not the person's to fix. The status cannot tell them apart, so it decides
    // nothing; the vendor's sentence stays on the result, where it names which.
    await connect(asker, "rt-api-403");
    exchange = ok;
    vendorReply = () => ({
      text: "Google Sheets refused this request (403): API has not been used in project 123.",
      isError: true,
      status: 403,
    });

    await store.callTool({ ref, args: ARGS, botId: firstBot, actorId: asker });

    expect((await healthRow(asker))?.lastFailureCode).toBeNull();
    expect((await reported(asker))?.health.status).toBe("ok");
    vendorReply = vendorAnswers;
  });

  test("a transport that throws with a status is judged the same way", async () => {
    // The MCP transport answers a refusal by throwing rather than by a result; the status rides on
    // the error class instead, and the judgement is the same table.
    await connect(asker, "rt-api-thrown");
    exchange = ok;
    vendorReply = () => {
      throw new realMcpModule.McpServerError(
        "The vendor rejected this credential (401).",
        401,
      );
    };

    await store
      .callTool({ ref, args: ARGS, botId: firstBot, actorId: asker })
      .catch(() => undefined);

    expect((await healthRow(asker))?.lastFailureCode).toBe("refresh_failed");
    vendorReply = vendorAnswers;
  });
});

/*
 * THE FIRST FINDING OF THE AUDIT (2026-09-10, A9 F1). A connect granted to the Bots the person owned
 * at that moment and to no other. The partner connectors had this measured and fixed on
 * 2026-09-06; the OAuth connectors had the connect half only. The route-level proof — `POST
 * /api/agents` after connecting, then `/for/:id` — is `oauth-grants-new-bot.test.ts`; this is the
 * store's own half, beside the connect it mirrors.
 */
describe("a Bot made after the connect", () => {
  const trailRowsFor = async (botId: string) =>
    (
      await database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "configuration.changed"),
            sql`${auditEvents.payload} ->> 'change' = 'plugin_granted'`,
            sql`${auditEvents.payload} ->> 'bot' = ${botId}`,
          ),
        )
    ).length;

  test("is handed the same tools as the Bots that existed then, once", async () => {
    await connect(asker, "rt-later-1");
    exchange = async ({ refreshToken }) => ({
      accessToken: `access(${refreshToken})`,
    });
    await store.offerToolsTo(serverId, asker, asker);

    await database
      .insert(agents)
      .values({
        id: laterBot,
        name: laterBot,
        type: "remote_ag_ui",
        configuration: {},
      })
      .onConflictDoNothing();
    await database
      .insert(agentProfiles)
      .values({
        agentId: laterBot,
        ownerUserId: asker,
        roleDescription: "",
        avatarSeed: laterBot,
      })
      .onConflictDoNothing();
    expect(await granted(ref)).not.toContain(laterBot);

    await store.offerConnectionsTo(laterBot, asker, "deployment");

    for (const name of everyTool) {
      expect({ name, held: await granted(`${serverId}/${name}`) }).toEqual({
        name,
        held: expect.arrayContaining([laterBot]),
      });
    }
    // Once per tool, by the deployment — and the same offer again writes no more trail.
    expect(await trailRowsFor(laterBot)).toBe(everyTool.length);
    await store.offerConnectionsTo(laterBot, asker, "deployment");
    expect(await trailRowsFor(laterBot)).toBe(everyTool.length);
  });

  test("a Bot of somebody who connected nothing is handed nothing", async () => {
    const before = await granted(ref);

    await store.offerConnectionsTo(
      strangersBot,
      `user_health_nobody_${suite}`,
      "deployment",
    );

    expect(await granted(ref)).toEqual(before);
  });
});
