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
  scopeKeyOf,
  type StandingApprovalStore,
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
