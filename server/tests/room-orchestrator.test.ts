import { describe, expect, test } from "bun:test";
import { type MemberAsk, runRoomTurn } from "../src/rooms/orchestrator";
import {
  ROOM_MESSAGES_PER_TURN,
  ROOM_ROUNDS,
  type RoomMember,
} from "../src/rooms/prompt";

/**
 * Every rule here exists to END a conversation between models, so every one is pinned. A room turn
 * that does not stop is a room turn that spends somebody's money until a timeout.
 *
 * Who speaks after the first round is decided by naming (`turn-taking.ts`, pinned in its own
 * file); what these pin is the loop around it — the caps, the epoch, the wind-down, and that the
 * orchestrator feeds what was said back into the rule.
 */

const members: RoomMember[] = [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
  { id: "c", name: "C" },
];

/** What a member says when asked, by member and by how many times the room has asked anybody. */
type Reply = (member: RoomMember, call: number) => string[];

function spy(
  reply: Reply,
  options: {
    addressedIds?: string[];
    currentFor?: number;
    roster?: RoomMember[];
  } = {},
) {
  const asked: MemberAsk[] = [];
  let calls = 0;
  let checks = 0;
  return {
    asked,
    ids: () => asked.map((entry) => entry.member.id),
    deps: {
      members: options.roster ?? members,
      addressedIds: options.addressedIds ?? [],
      isCurrent: async () => {
        checks += 1;
        return options.currentFor === undefined || checks <= options.currentFor;
      },
      runMember: async (ask: MemberAsk) => {
        asked.push(ask);
        calls += 1;
        const said = reply(ask.member, calls);
        return { spoke: said.length, said };
      },
    },
  };
}

/** Everybody names the next member round the table, so every round pulls one colleague in. */
const chain: Reply = (member) =>
  member.id === "a"
    ? ["@B 어때?"]
    : member.id === "b"
      ? ["@C 어때?"]
      : ["@A 어때?"];

describe("how a room turn ends", () => {
  test("a round where nobody spoke ends it, rather than asking again for filler", async () => {
    const it = spy(() => []);
    const outcome = await runRoomTurn(it.deps);

    expect(outcome.ended).toBe("silent-round");
    expect(outcome.rounds).toBe(1);
    expect(it.asked).toHaveLength(3);
  });

  test("a round where nobody named anybody ends it, however much was said", async () => {
    // Three answers to the person and no colleague pulled in: the conversation has settled. Every
    // Bot used to answer again here, to what the other two had said, for two more rounds.
    const it = spy(() => ["정리했습니다"]);
    const outcome = await runRoomTurn(it.deps);

    expect(outcome.ended).toBe("nobody-named");
    expect(outcome.rounds).toBe(1);
    expect(outcome.posted).toBe(3);
    expect(it.asked).toHaveLength(3);
  });

  test("three rounds is the ceiling even when the members keep naming each other", async () => {
    const it = spy(chain);
    const outcome = await runRoomTurn(it.deps);

    expect(outcome.ended).toBe("rounds");
    expect(outcome.rounds).toBe(ROOM_ROUNDS);
    /*
     * Round 0: a names B, b names C, c names A — and by the end of it B and C have already
     * answered after being named, so only A is pulled into round 1. A names B, B is pulled into
     * round 2 and names C. Five messages, and the ceiling stops the chain.
     */
    expect(it.ids()).toEqual(["a", "b", "c", "a", "b"]);
    expect(outcome.posted).toBe(5);
  });

  test("the per-turn cap stops a chatty room mid-round", async () => {
    // Everybody says three things and names both colleagues every time.
    const it = spy(() => ["@A @B @C 하나", "둘", "셋"]);
    const outcome = await runRoomTurn(it.deps);

    expect(outcome.ended).toBe("full");
    expect(outcome.posted).toBeGreaterThanOrEqual(ROOM_MESSAGES_PER_TURN);
    // Nobody is asked once the room is full.
    expect(it.asked.length).toBeLessThan(ROOM_ROUNDS * members.length);
  });

  test("a newer message from the person ends it at the next member", async () => {
    // Two checks pass: the round's own, and the first member's.
    const it = spy(() => ["네"], { currentFor: 2 });
    const outcome = await runRoomTurn(it.deps);

    expect(outcome.ended).toBe("superseded");
    expect(it.asked).toHaveLength(1);
    // The member that had already been asked still counts: its words were said.
    expect(outcome.posted).toBe(1);
  });

  test("one Bot alone in a room speaks once and stops, rather than talking to itself", async () => {
    const it = spy(() => ["@A 저요"], {
      roster: [{ id: "a", name: "A" }],
    });
    const outcome = await runRoomTurn(it.deps);

    expect(outcome.ended).toBe("alone");
    expect(it.ids()).toEqual(["a"]);
  });

  test("the one Bot the person named speaks, and the turn ends unless it names a colleague", async () => {
    const quiet = spy(() => ["네, 확인했습니다"], { addressedIds: ["b"] });
    expect((await runRoomTurn(quiet.deps)).ended).toBe("nobody-named");
    expect(quiet.ids()).toEqual(["b"]);

    const asking = spy(chain, { addressedIds: ["b"] });
    const outcome = await runRoomTurn(asking.deps);
    // b names C, C names A, A names B: one colleague per round until the ceiling.
    expect(asking.ids()).toEqual(["b", "c", "a"]);
    expect(outcome.ended).toBe("rounds");
  });
});

describe("who speaks, in what order, and why", () => {
  test("naming nobody asks everybody, in the room's order, for that reason", async () => {
    const it = spy(() => []);
    await runRoomTurn(it.deps);

    expect(it.ids()).toEqual(["a", "b", "c"]);
    expect(it.asked.map((entry) => entry.reason)).toEqual([
      "everybody",
      "everybody",
      "everybody",
    ]);
    expect(it.asked.every((entry) => entry.round === 0)).toBe(true);
  });

  test("naming somebody asks only them, for that reason", async () => {
    const it = spy(() => [], { addressedIds: ["c"] });
    await runRoomTurn(it.deps);
    expect(it.asked).toEqual([
      {
        member: members[2] as RoomMember,
        windingDown: false,
        round: 0,
        reason: "addressed",
      },
    ]);
  });

  test("a colleague's naming pulls a Bot into the next round, and the ask says who named it", async () => {
    // b answered in round 0 and is then named by c, who spoke after it: pulled into round 1.
    const it = spy((member) =>
      member.id === "a"
        ? ["시작하죠"]
        : member.id === "c"
          ? ["@B 의견은요?"]
          : ["네"],
    );
    await runRoomTurn(it.deps);

    expect(it.ids()).toEqual(["a", "b", "c", "b"]);
    expect(it.asked[3]).toMatchObject({
      round: 1,
      reason: "named",
      namedBy: "c",
    });
  });

  test("the order rotates by round, so the same Bot does not open every round", async () => {
    // c, speaking last in round 0, names both colleagues: round 1 is [a, b] rotated by one.
    const it = spy((member, call) =>
      member.id === "c" && call === 3 ? ["@A @B 두 분 의견은요?"] : [],
    );
    await runRoomTurn(it.deps);
    expect(it.ids()).toEqual(["a", "b", "c", "b", "a"]);
  });
});

describe("winding down", () => {
  test("nobody is asked to wrap up on the first round of a quiet room", async () => {
    const it = spy(() => []);
    await runRoomTurn(it.deps);
    expect(it.asked.every((entry) => !entry.windingDown)).toBe(true);
  });

  test("the last round asks to wrap up", async () => {
    const it = spy(chain);
    await runRoomTurn(it.deps);
    expect(it.asked.at(-1)?.round).toBe(ROOM_ROUNDS - 1);
    expect(it.asked.at(-1)?.windingDown).toBe(true);
    expect(it.asked.slice(0, -1).every((entry) => !entry.windingDown)).toBe(
      true,
    );
  });

  test("a room nearly out of messages asks early, so it settles instead of being cut off", async () => {
    // Nine messages inside the first round: the third member is asked with one slot left.
    const it = spy((member) =>
      member.id === "a"
        ? ["하나", "둘", "셋", "넷", "다섯"]
        : member.id === "b"
          ? ["하나", "둘", "셋", "넷"]
          : ["끝"],
    );
    await runRoomTurn(it.deps);
    expect(it.asked.map((entry) => entry.windingDown)).toEqual([
      false,
      false,
      true,
    ]);
  });
});
