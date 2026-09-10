/**
 * Who may open a Bot's screen.
 *
 * The live-screen upgrade resolved the person and then dropped the answer on the floor — `actor`
 * was assigned and never read — so the check was "somebody is signed in", not "this is your Bot".
 * Any staff account on a shared VM could name any Bot in the path and watch it work with the
 * owner's logins loaded, and type into it.
 *
 * And then it was fixed against the wrong question. The rule took the profile store's `get`, which
 * answers what a person may SEE — and a Bot marked `public` is visible to everybody on the
 * deployment. The stub here was stricter than the store, so this file went on passing while the
 * socket opened for anybody on a public Bot (audit A8, 2026-09-10). The lookup is whose the Bot is
 * now, and the real one is driven in `authorization-matrix.integration.test.ts`; what this file
 * pins is the decision table over the three answers a lookup can give.
 *
 * Asserted on the rule rather than through a request because an upgrade never reaches Hono: Bun
 * hands the connection over in `fetch`, ahead of the app, so `app.request(...)` cannot drive it.
 */
import { describe, expect, test } from "bun:test";
import type { BotOwner } from "../src/auth/guards";
import { streamBotAccess } from "../src/auth/stream-access";

const owner = { id: "owner", role: "user" as const };
const colleague = { id: "colleague", role: "user" as const };
const administrator = { id: "admin", role: "admin" as const };

/** Whose each Bot is: the owner's, nobody's (a package shipped it), or not a Bot at all. */
const OWNERS: Record<string, BotOwner> = {
  agent_owned: "owner",
  agent_shared: null,
};
const whose = async (botId: string): Promise<BotOwner> => OWNERS[botId];

describe("opening a Bot's live screen", () => {
  test("the owner may watch their own Bot", async () => {
    await expect(streamBotAccess("agent_owned", owner, whose)).resolves.toBe(
      "allowed",
    );
  });

  test("a colleague on the same deployment may not, whatever the Bot's visibility", async () => {
    // The lookup never reads visibility, so there is no `public` for this to be widened by.
    await expect(
      streamBotAccess("agent_owned", colleague, whose),
    ).resolves.toBe("not_found");
  });

  test("a Bot nobody made is every signed-in person's", async () => {
    await expect(
      streamBotAccess("agent_shared", colleague, whose),
    ).resolves.toBe("allowed");
  });

  test("an administrator may watch any Bot that exists", async () => {
    await expect(
      streamBotAccess("agent_owned", administrator, whose),
    ).resolves.toBe("allowed");
  });

  test("a Bot that does not exist answers the same as one that is somebody else's", async () => {
    await expect(streamBotAccess("agent_ghost", owner, whose)).resolves.toBe(
      "not_found",
    );
  });

  test("a lookup that failed is a Bot that is not there, never one that is allowed", async () => {
    await expect(
      streamBotAccess("agent_owned", owner, async () => {
        throw new Error("the database went away");
      }),
    ).resolves.toBe("not_found");
  });

  test("nobody signed in is refused before the roster is asked", async () => {
    let asked = false;
    await expect(
      streamBotAccess("agent_owned", null, async (botId) => {
        asked = true;
        return whose(botId);
      }),
    ).resolves.toBe("unauthenticated");
    expect(asked).toBe(false);
  });

  test.each([
    ["../../etc/passwd"],
    ["agent/../other"],
    ["agent owned"],
    [""],
    ["a".repeat(129)],
    ["shared%2f.."],
  ])("refuses %p before anything looks it up", async (botId) => {
    let asked = false;
    await expect(
      streamBotAccess(botId, owner, async (id) => {
        asked = true;
        return whose(id);
      }),
    ).resolves.toBe("bad_id");
    // The id becomes a directory in the browser container. It must not reach a query, let alone a
    // path, before it has been checked.
    expect(asked).toBe(false);
  });

  test("the ids this product actually mints pass", async () => {
    // The same shape every other door checks (`computer/bot-id.ts`), so a Bot the computer would
    // serve is a Bot whose screen can be watched, and no other.
    await expect(
      streamBotAccess("agent_9f2c1b", owner, async () => "owner"),
    ).resolves.toBe("allowed");
    await expect(
      streamBotAccess("agent-9f2c1b", owner, async () => "owner"),
    ).resolves.toBe("allowed");
  });
});
