/**
 * Who may watch a Bot's screen.
 *
 * The live-screen upgrade resolved the person and then dropped the answer on the floor — `actor`
 * was assigned and never read — so the check was "somebody is signed in", not "this is your Bot".
 * Any staff account on a shared VM could name any Bot in the path and watch it work with the
 * owner's logins loaded, and type into it.
 *
 * Asserted on the rule rather than through a request because an upgrade never reaches Hono: Bun
 * hands the connection over in `fetch`, ahead of the app, so `app.request(...)` cannot drive it.
 */
import { describe, expect, test } from "bun:test";
import { streamBotAccess } from "../src/auth/stream-access";

const owner = { id: "owner", role: "user" as const };
const colleague = { id: "colleague", role: "user" as const };

/** The profile store's own scoping, in miniature: `get` answers null for a Bot you cannot see. */
const roster = async (
  actor: { id: string; role: "admin" | "user" },
  botId: string,
) => (actor.id === "owner" && botId === "agent_owned" ? { id: botId } : null);

describe("opening a Bot's live screen", () => {
  test("the owner may watch their own Bot", async () => {
    await expect(streamBotAccess("agent_owned", owner, roster)).resolves.toBe(
      "allowed",
    );
  });

  test("a colleague on the same deployment may not", async () => {
    await expect(
      streamBotAccess("agent_owned", colleague, roster),
    ).resolves.toBe("not_found");
  });

  test("a Bot that does not exist answers the same as one that is somebody else's", async () => {
    await expect(streamBotAccess("agent_ghost", owner, roster)).resolves.toBe(
      "not_found",
    );
  });

  test("nobody signed in is refused before the roster is asked", async () => {
    let asked = false;
    await expect(
      streamBotAccess("agent_owned", null, async (...args) => {
        asked = true;
        return roster(...args);
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
      streamBotAccess(botId, owner, async (...args) => {
        asked = true;
        return roster(...args);
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
      streamBotAccess("agent_9f2c1b", owner, async () => ({})),
    ).resolves.toBe("allowed");
    await expect(
      streamBotAccess("agent-9f2c1b", owner, async () => ({})),
    ).resolves.toBe("allowed");
  });
});
