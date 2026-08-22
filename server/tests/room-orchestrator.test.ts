import { describe, expect, test } from "bun:test";
import {
  ROOM_MESSAGES_PER_TURN,
  ROOM_ROUNDS,
  type RoomMember,
} from "../src/rooms/prompt";
import { runRoomTurn } from "../src/rooms/orchestrator";

/**
 * Every rule here exists to END a conversation between models, so every one is pinned. A room turn
 * that does not stop is a room turn that spends somebody's money until a timeout.
 */

const members: RoomMember[] = [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
  { id: "c", name: "C" },
];

function spy(
  reply: (member: RoomMember, call: number) => number,
  options: { addressedIds?: string[]; currentFor?: number } = {},
) {
  const asked: Array<{ id: string; windingDown: boolean }> = [];
  let calls = 0;
  let checks = 0;
  return {
    asked,
    deps: {
      members,
      addressedIds: options.addressedIds ?? [],
      isCurrent: async () => {
        checks += 1;
        return options.currentFor === undefined || checks <= options.currentFor;
      },
      runMember: async ({
        member,
        windingDown,
      }: {
        member: RoomMember;
        windingDown: boolean;
      }) => {
        asked.push({ id: member.id, windingDown });
        calls += 1;
        return reply(member, calls);
      },
    },
  };
}

describe("how a room turn ends", () => {
  test("a round where nobody spoke ends it, rather than asking again for filler", async () => {
    const { deps, asked } = spy(() => 0);
    const outcome = await runRoomTurn(deps);

    expect(outcome.ended).toBe("silent-round");
    expect(outcome.rounds).toBe(1);
    expect(asked).toHaveLength(3);
  });

  test("three rounds is the ceiling even when everybody keeps talking", async () => {
    const { deps } = spy(() => 1);
    const outcome = await runRoomTurn(deps);

    expect(outcome.ended).toBe("rounds");
    expect(outcome.rounds).toBe(ROOM_ROUNDS);
    // Three members × three rounds, and nine is under the per-turn cap.
    expect(outcome.posted).toBe(9);
  });

  test("the per-turn cap stops a chatty room mid-round", async () => {
    const { deps, asked } = spy(() => 3);
    const outcome = await runRoomTurn(deps);

    expect(outcome.ended).toBe("full");
    expect(outcome.posted).toBeGreaterThanOrEqual(ROOM_MESSAGES_PER_TURN);
    // Nobody is asked once the room is full.
    expect(asked.length).toBeLessThan(ROOM_ROUNDS * members.length);
  });

  test("a newer message from the person ends it at the next member", async () => {
    // Two checks pass: the round's own, and the first member's.
    const { deps, asked } = spy(() => 1, { currentFor: 2 });
    const outcome = await runRoomTurn(deps);

    expect(outcome.ended).toBe("superseded");
    expect(asked).toHaveLength(1);
    // The member that had already been asked still counts: its words were said.
    expect(outcome.posted).toBe(1);
  });

  test("one Bot in the room speaks once and stops, rather than talking to itself", async () => {
    const { deps, asked } = spy(() => 1, { addressedIds: ["b"] });
    const outcome = await runRoomTurn(deps);

    expect(outcome.ended).toBe("alone");
    expect(asked.map((entry) => entry.id)).toEqual(["b"]);
  });
});

describe("who speaks, and in what order", () => {
  test("naming nobody asks everybody, rotating who opens each round", async () => {
    const { deps, asked } = spy(() => 1);
    await runRoomTurn(deps);

    expect(asked.slice(0, 3).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(asked.slice(3, 6).map((entry) => entry.id)).toEqual(["b", "c", "a"]);
    expect(asked.slice(6, 9).map((entry) => entry.id)).toEqual(["c", "a", "b"]);
  });

  test("naming somebody asks only them", async () => {
    const { deps, asked } = spy(() => 0, { addressedIds: ["c"] });
    await runRoomTurn(deps);
    expect(asked.map((entry) => entry.id)).toEqual(["c"]);
  });
});

describe("winding down", () => {
  test("nobody is asked to wrap up on the first round of a quiet room", async () => {
    const { deps, asked } = spy(() => 0);
    await runRoomTurn(deps);
    expect(asked.every((entry) => !entry.windingDown)).toBe(true);
  });

  test("the last round asks everybody to wrap up", async () => {
    const { deps, asked } = spy(() => 1);
    await runRoomTurn(deps);
    expect(asked.slice(6, 9).every((entry) => entry.windingDown)).toBe(true);
  });

  test("a room nearly out of messages asks early, so it settles instead of being cut off", async () => {
    // Each member says three, so the room is two slots from full inside the first round.
    const { deps, asked } = spy((_member, call) => (call === 1 ? 3 : 1));
    await runRoomTurn(deps);
    expect(asked[0]?.windingDown).toBe(false);
    expect(asked.slice(1).some((entry) => entry.windingDown)).toBe(true);
  });
});
