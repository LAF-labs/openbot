import { describe, expect, test } from "bun:test";
import { conversationOf, mineOf, primaryBot } from "../src/lib/agents/my-bots";
import type { AgentProfile } from "../src/lib/agents/queries";
import type { ChannelSummary } from "../src/lib/channels/queries";

/**
 * WHICH BOT IS THE PERSON'S, AND WHICH ONE THE APP OPENS ON (2026-09-24).
 *
 * A person has one Bot. An account from before that keeps every Bot it had, and these three
 * functions are what keep them reachable: the hidden ones are put back beside the rest, the app
 * opens on the one last spoken with, and each opens on its own conversation.
 */

const bot = (id: string, extra: Partial<AgentProfile> = {}): AgentProfile => ({
  id,
  name: id,
  title: "",
  roleDescription: "",
  avatarSeed: `s:pebble.blue`,
  effort: "balanced",
  autoReview: "",
  endpoint: null,
  hasAuth: false,
  hidden: false,
  pinnedAt: null,
  notify: true,
  systemOwned: false,
  canManage: true,
  mine: true,
  ...extra,
});

const channel = (
  id: string,
  agentIds: string[],
  createdAt: string,
  lastMessageAt: string | null = null,
): ChannelSummary => ({
  id,
  name: id,
  agentIds,
  threadId: `thread-${id}`,
  active: true,
  lastMessage: null,
  lastMessageAt,
  lastMessageAgentId: null,
  unread: false,
  createdAt,
});

describe("the person's Bots", () => {
  test("are the ones that are theirs, hidden ones included, each once", () => {
    const hiddenOne = bot("b", { hidden: true });
    expect(
      mineOf(
        [bot("a"), bot("theirs", { mine: false })],
        [hiddenOne, bot("a")],
      )?.map((agent) => agent.id),
    ).toEqual(["a", "b"]);
  });

  test("are unknown until the roster answers, and the roster alone when the hidden list does not", () => {
    expect(mineOf(undefined, [bot("a")])).toBeUndefined();
    expect(mineOf([bot("a")], undefined)?.map((agent) => agent.id)).toEqual([
      "a",
    ]);
  });

  test("a person whose one Bot was hidden still has it", () => {
    expect(
      mineOf([], [bot("only", { hidden: true })])?.map((agent) => agent.id),
    ).toEqual(["only"]);
  });
});

describe("the Bot the app opens on", () => {
  test("is the one Bot, conversations or not", () => {
    expect(primaryBot([bot("only")], undefined)?.id).toBe("only");
    expect(primaryBot([bot("only")], [])?.id).toBe("only");
  });

  test("is nobody when there is none, which sends the person to make one", () => {
    expect(primaryBot([], [])).toBeUndefined();
  });

  test("on an account that still has several, is the one spoken with last", () => {
    const bots = [bot("older"), bot("recent"), bot("silent")];
    const channels = [
      channel("c1", ["older"], "2026-09-01T00:00:00Z", "2026-09-10T00:00:00Z"),
      channel("c2", ["recent"], "2026-09-02T00:00:00Z", "2026-09-20T00:00:00Z"),
    ];
    expect(primaryBot(bots, channels)?.id).toBe("recent");
  });

  test("a room from before does not count as speaking with either Bot in it", () => {
    const bots = [bot("a"), bot("b")];
    const channels = [
      channel("solo", ["a"], "2026-09-01T00:00:00Z", "2026-09-05T00:00:00Z"),
      channel(
        "room",
        ["a", "b"],
        "2026-09-02T00:00:00Z",
        "2026-09-22T00:00:00Z",
      ),
      channel("b-solo", ["b"], "2026-09-03T00:00:00Z", "2026-09-06T00:00:00Z"),
    ];
    expect(primaryBot(bots, channels)?.id).toBe("b");
  });
});

describe("a Bot's conversation", () => {
  test("is its oldest one-Bot channel, the one the server's create resolves to", () => {
    const channels = [
      channel("newer", ["a"], "2026-09-10T00:00:00Z"),
      channel("oldest", ["a"], "2026-09-01T00:00:00Z"),
      channel("room", ["a", "b"], "2026-08-01T00:00:00Z"),
      channel("other", ["b"], "2026-07-01T00:00:00Z"),
    ];
    expect(conversationOf("a", channels)?.id).toBe("oldest");
  });

  test("is none before its first message", () => {
    expect(conversationOf("a", [])).toBeUndefined();
    expect(conversationOf("a", undefined)).toBeUndefined();
  });
});
