import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import {
  allowanceFor,
  createDatabaseStandingApprovalStore,
  createStandingApprovalStore,
  type StandingApprovalStore,
  scopeKeyOf,
  THREAD_ALLOWANCE_TTL_MS,
} from "../src/computer/standing-approvals";
import { createDatabase } from "../src/db/client";
import { agents, computerStandingApprovals } from "../src/db/schema";
import { TEST_POOL } from "./support/database";
import { A_CLICK } from "./support/subjects";

/**
 * One contract, two stores, same as the approval registry next door.
 *
 * A deployment runs the database one and the gateway's own tests run the Map, which is the exact
 * arrangement where a behaviour drifts on one side and nobody finds out. What is asserted here is
 * what somebody is relying on when they press a button that stands a boundary down: that the
 * allowance covers what it said it would, that a withdrawal actually withdraws it, and that pressing
 * the button twice does not leave a second grant behind the first one for a later revoke to miss.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const BOT = "standing-test-bot";
const RULE = 'intent == "navigate"';
const GRANT = {
  botId: BOT,
  rule: RULE,
  scope: { kind: "host", value: "wttr.in" } as const,
  subject: A_CLICK,
  grantedBy: "boss",
};

/*
 * The Bot the allowances name, created rather than assumed: `bot_id` is a real reference since
 * 0026, so a grant under an id no `agents` row carries fails on the reference instead of exercising
 * the store. Removed only if this file is what created it.
 */
let seededBot = false;

beforeAll(async () => {
  const made = await database
    .insert(agents)
    .values({
      id: BOT,
      name: "Standing Test Bot",
      type: "remote_ag_ui",
      configuration: {},
    })
    .onConflictDoNothing()
    .returning({ id: agents.id });
  seededBot = made.length > 0;
});

afterAll(async () => {
  if (seededBot) await database.delete(agents).where(eq(agents.id, BOT));
});

// This file's Bot only: unscoped, this would wipe the allowances of the database the app is using.
afterEach(async () => {
  await database
    .delete(computerStandingApprovals)
    .where(eq(computerStandingApprovals.botId, BOT));
});

const STORES: [string, () => StandingApprovalStore][] = [
  ["in memory", () => createStandingApprovalStore()],
  ["in the database", () => createDatabaseStandingApprovalStore(database)],
];

for (const [name, build] of STORES) {
  describe(`an allowance store ${name}`, () => {
    test("covers the action it was granted for", async () => {
      const store = build();
      await store.grant(GRANT);
      const found = await store.find(BOT, RULE, "host=wttr.in");
      expect(found?.grantedBy).toBe("boss");
      expect(found?.scopeValue).toBe("wttr.in");
    });

    test("covers nothing else", async () => {
      const store = build();
      await store.grant(GRANT);
      // A different site, a different Bot and a different boundary are three different questions.
      expect(await store.find(BOT, RULE, "host=example.com")).toBeNull();
      expect(await store.find("other-bot", RULE, "host=wttr.in")).toBeNull();
      expect(await store.find(BOT, "submit", "host=wttr.in")).toBeNull();
    });

    test("granting twice leaves one allowance, not two behind each other", async () => {
      const store = build();
      const first = await store.grant(GRANT);
      const second = await store.grant(GRANT);
      // The same row both times. Two would mean revoking the one on screen left the other standing.
      expect(second.id).toBe(first.id);
      expect(await store.list(BOT)).toHaveLength(1);
    });

    test("withdrawing it stops it covering anything", async () => {
      const store = build();
      const granted = await store.grant(GRANT);
      const revoked = await store.revoke(granted.id, "boss");
      expect(revoked?.revokedBy).toBe("boss");
      expect(await store.find(BOT, RULE, "host=wttr.in")).toBeNull();
      expect(await store.list(BOT)).toEqual([]);
    });

    test("withdrawing twice is a no-op rather than a rewrite", async () => {
      const store = build();
      const granted = await store.grant(GRANT);
      await store.revoke(granted.id, "boss");
      // Null, not a second row with a later time and a different name on it.
      expect(await store.revoke(granted.id, "somebody else")).toBeNull();
    });

    test("it can be granted again after being withdrawn", async () => {
      const store = build();
      const first = await store.grant(GRANT);
      await store.revoke(first.id, "boss");
      const again = await store.grant(GRANT);
      expect(again.id).not.toBe(first.id);
      expect(await store.find(BOT, RULE, "host=wttr.in")).not.toBeNull();
    });

    test("the list is what stands, and nothing else", async () => {
      const store = build();
      const kept = await store.grant(GRANT);
      const dropped = await store.grant({
        ...GRANT,
        scope: { kind: "tool", value: "computer_click" },
      });
      await store.revoke(dropped.id, "boss");
      expect((await store.list(BOT)).map((one) => one.id)).toEqual([kept.id]);
    });
  });
}

describe("what an allowance covers", () => {
  test("a file is the file, whatever page happened to be open", () => {
    expect(
      allowanceFor({
        tool: "computer_write_file",
        host: "example.com",
        filePath: "reports/q3.md",
      }),
    ).toEqual({ kind: "file", value: "reports/q3.md" });
  });

  test("otherwise it is the site", () => {
    expect(allowanceFor({ tool: "computer_click", host: "wttr.in" })).toEqual({
      kind: "host",
      value: "wttr.in",
    });
  });

  test("and where there is neither, the tool alone", () => {
    // Where every call to somebody else's server lands: no host, no path, only a name.
    expect(allowanceFor({ tool: "jira/create_issue" })).toEqual({
      kind: "tool",
      value: "jira/create_issue",
    });
  });

  test("blank is not a scope, so an empty host does not become one", () => {
    // The gateway passes `hostOf(pageUrl)`, which is "" for a page it could not parse. An allowance
    // keyed on `host=` would be one grant covering every unparseable address at once.
    expect(allowanceFor({ tool: "computer_click", host: "  " })).toEqual({
      kind: "tool",
      value: "computer_click",
    });
  });

  test("the key says which kind it is, so two kinds cannot collide", () => {
    expect(scopeKeyOf({ kind: "host", value: "a" })).toBe("host=a");
    expect(scopeKeyOf({ kind: "file", value: "a" })).toBe("file=a");
    expect(scopeKeyOf({ kind: "host", value: "a" })).not.toBe(
      scopeKeyOf({ kind: "file", value: "a" }),
    );
  });
});

/*
 * THE MIDDLE ANSWER, in both stores.
 *
 * "For this conversation" is the same row with a thread and a clock on it, and the two stores have
 * to agree on what those mean: which lookups it answers, when it stops, and that a standing grant
 * and a conversation's grant for the same question can both stand without either swallowing the
 * other. The database one carries the unique index that decides the last of those, which is the
 * reason this runs against a real table.
 */
const THREAD = "standing-test-thread-a";
const OTHER_THREAD = "standing-test-thread-b";
const FOR_THREAD = { ...GRANT, tier: "thread" as const, threadId: THREAD };

const CLOCKED: [string, (now: () => number) => StandingApprovalStore][] = [
  ["in memory", (now) => createStandingApprovalStore({ now })],
  [
    "in the database",
    (now) => createDatabaseStandingApprovalStore(database, { now }),
  ],
];

for (const [name, build] of CLOCKED) {
  describe(`an allowance for this conversation ${name}`, () => {
    let at = Date.parse("2026-09-06T09:00:00.000Z");
    const store = () => build(() => at);

    test("is bound to its thread and carries its clock", async () => {
      const granted = await store().grant(FOR_THREAD);
      expect(granted.tier).toBe("thread");
      expect(granted.threadId).toBe(THREAD);
      expect(Date.parse(granted.expiresAt ?? "")).toBe(
        at + THREAD_ALLOWANCE_TTL_MS,
      );
    });

    test("answers in its own thread, and nowhere else", async () => {
      const it = store();
      await it.grant(FOR_THREAD);
      expect(
        (await it.find(BOT, RULE, "host=wttr.in", { threadId: THREAD }))?.tier,
      ).toBe("thread");
      expect(
        await it.find(BOT, RULE, "host=wttr.in", { threadId: OTHER_THREAD }),
      ).toBeNull();
      // From nowhere in particular — a routine — the standing kind alone answers.
      expect(await it.find(BOT, RULE, "host=wttr.in")).toBeNull();
    });

    test("the standing kind and a conversation's kind stand side by side", async () => {
      const it = store();
      const forThread = await it.grant(FOR_THREAD);
      const forGood = await it.grant(GRANT);
      expect(forGood.id).not.toBe(forThread.id);
      expect((await it.list(BOT)).map((one) => one.tier).sort()).toEqual([
        "always",
        "thread",
      ]);
      // In the thread, the wider decision is the one named; see the Map's own comment.
      expect(
        (await it.find(BOT, RULE, "host=wttr.in", { threadId: THREAD }))?.id,
      ).toBe(forGood.id);
    });

    test("granting it twice for the same thread leaves one row", async () => {
      const it = store();
      const first = await it.grant(FOR_THREAD);
      const second = await it.grant(FOR_THREAD);
      expect(second.id).toBe(first.id);
      // And the narrower press is not answered with the wider row: a person who pressed "for this
      // conversation" is not told they pressed "always".
      await it.grant(GRANT);
      expect((await it.grant(FOR_THREAD)).id).toBe(first.id);
    });

    test("two conversations get two rows", async () => {
      const it = store();
      const first = await it.grant(FOR_THREAD);
      const second = await it.grant({ ...FOR_THREAD, threadId: OTHER_THREAD });
      expect(second.id).not.toBe(first.id);
      expect(await it.list(BOT)).toHaveLength(2);
    });

    test("runs out on its clock, and can be granted afresh once it has", async () => {
      const it = store();
      const first = await it.grant(FOR_THREAD);
      at += THREAD_ALLOWANCE_TTL_MS + 1;
      expect(
        await it.find(BOT, RULE, "host=wttr.in", { threadId: THREAD }),
      ).toBeNull();
      expect(await it.list(BOT)).toEqual([]);
      // The old row held the index's slot; the fresh grant has to get past it.
      const again = await it.grant(FOR_THREAD);
      expect(again.id).not.toBe(first.id);
      expect(
        (await it.find(BOT, RULE, "host=wttr.in", { threadId: THREAD }))?.id,
      ).toBe(again.id);
      at -= THREAD_ALLOWANCE_TTL_MS + 1;
    });

    test("ending the conversation withdraws what was bound to it and nothing else", async () => {
      const it = store();
      const forThread = await it.grant(FOR_THREAD);
      const elsewhere = await it.grant({
        ...FOR_THREAD,
        threadId: OTHER_THREAD,
      });
      const forGood = await it.grant(GRANT);
      const ended = await it.endThread(THREAD, "system");
      expect(ended.map((one) => one.id)).toEqual([forThread.id]);
      expect(ended[0]?.revokedBy).toBe("system");
      expect((await it.list(BOT)).map((one) => one.id).sort()).toEqual(
        [elsewhere.id, forGood.id].sort(),
      );
    });

    test("refuses a conversation's grant that names no conversation", async () => {
      await expect(store().grant({ ...GRANT, tier: "thread" })).rejects.toThrow(
        /which conversation/,
      );
    });
  });
}
