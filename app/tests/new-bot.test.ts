import { describe, expect, test } from "bun:test";
import {
  BOT_NAME_WORDS,
  nextBotName,
  randomFaceSeed,
} from "../src/lib/agents/bot-names";
import { agentInputFrom, emptyAgentForm } from "../src/lib/agents/form";
import { AGENT_REFUSALS } from "../src/lib/agents/mutations";
import { createBotNow } from "../src/lib/agents/new-bot";
import {
  DEFAULT_BOT_SEATS,
  seatsFrom,
  seatsFullMessage,
} from "../src/lib/agents/seats";
import { ko } from "../src/lib/i18n-ko";

/**
 * PRESSING 새 봇 MAKES A BOT, and this is what that press is made of.
 *
 * The hook itself is three lines of React around these: check the seats, name it, ask the server,
 * open its conversation. What is worth pinning is the parts that can be wrong without anything
 * throwing — a name nobody translated, a duplicate on the roster, a cap the screen believes in but
 * the server does not, and an input that quietly carries a job title nobody typed.
 */

describe("what a new Bot is called", () => {
  test("every name has Korean, because they are read through t(variable)", () => {
    // Invisible to `i18n-coverage.test.ts` for the same reason the presets are: the call is
    // `t(word)`, not `t("Lantern")`. An untranslated one names somebody's Bot in English.
    expect(BOT_NAME_WORDS.filter((word) => !(word in ko))).toEqual([]);
  });

  test("the names are distinct, so the pool is as big as it looks", () => {
    expect(new Set(BOT_NAME_WORDS).size).toBe(BOT_NAME_WORDS.length);
    expect(BOT_NAME_WORDS.length).toBeGreaterThanOrEqual(5);
  });

  test("never repeats a name already on the roster", () => {
    // Under the tests' English locale `t()` answers with the source word.
    const taken = BOT_NAME_WORDS.slice(0, BOT_NAME_WORDS.length - 1);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      expect(taken).not.toContain(nextBotName(taken));
    }
  });

  test("counts rather than collides when every name is taken", () => {
    const taken = [...BOT_NAME_WORDS];
    const named = nextBotName(taken, () => 0);
    expect(named).toBe(`${BOT_NAME_WORDS[0]} 2`);
    expect(nextBotName([...taken, named], () => 0)).toBe(
      `${BOT_NAME_WORDS[0]} 3`,
    );
  });

  test("a random draw stays inside the pool", () => {
    // `Math.random()` can return a value that rounds to the length; the index must still be a name.
    for (const value of [0, 0.5, 0.999999, 1]) {
      expect(BOT_NAME_WORDS).toContain(nextBotName([], () => value));
    }
  });

  test("the face is a seed, not a tile id", () => {
    // `mascotIdFor` maps any string to a drawn character, so a seed cannot name a tile that the art
    // set stopped shipping — which is exactly what a stored tile id can do.
    const seeds = new Set(
      Array.from({ length: 50 }, () => randomFaceSeed()).map(String),
    );
    expect(seeds.size).toBeGreaterThan(40);
  });
});

describe("the five seats", () => {
  test("a fresh account has room and says nothing", () => {
    const seats = seatsFrom(0);
    expect(seats).toMatchObject({ isFull: false, isLastSeat: false, total: 5 });
  });

  test("four is the last seat, five is full", () => {
    expect(seatsFrom(4).isLastSeat).toBe(true);
    expect(seatsFrom(4).isFull).toBe(false);
    expect(seatsFrom(5).isFull).toBe(true);
    // A deployment that seats more says so on /api/me, and the roster follows it.
    expect(seatsFrom(5, 8).isFull).toBe(false);
    expect(seatsFrom(8, 8).isFull).toBe(true);
  });

  test("a roster that somehow overflowed is still full rather than negative", () => {
    expect(seatsFrom(9).isFull).toBe(true);
  });

  test("the screen's refusal is the server's refusal, word for word", () => {
    // Two sentences for one fact is how somebody comes to believe they are two problems.
    expect(seatsFullMessage(seatsFrom(5))).toBe(
      (AGENT_REFUSALS["laf:seats_full"] as string).replace(
        "{seats}",
        String(DEFAULT_BOT_SEATS),
      ),
    );
  });
});

describe("what pressing it does", () => {
  const seated = { isFull: false, isLastSeat: false, total: 5, used: 1 };

  test("makes the Bot, then opens its conversation", async () => {
    const order: string[] = [];
    const outcome = await createBotNow({
      create: async (input) => {
        order.push(`create:${input.name}`);
        return { id: "agent_new" };
      },
      open: async (agentId) => {
        order.push(`open:${agentId}`);
      },
      seats: seated,
      taken: [],
    });

    expect(outcome).toEqual({ ok: true, agentId: "agent_new" });
    // The order is the whole point: opened AFTER it exists, and with the id the server gave back.
    const named = order[0]?.slice("create:".length);
    expect(order).toEqual([`create:${named}`, "open:agent_new"]);
    expect(BOT_NAME_WORDS).toContain(named);
  });

  test("refuses at the cap without asking the server at all", async () => {
    let asked = false;
    const outcome = await createBotNow({
      create: async () => {
        asked = true;
        return { id: "agent_never" };
      },
      open: async () => undefined,
      seats: { isFull: true, isLastSeat: false, total: 5, used: 5 },
      taken: [],
    });

    expect(asked).toBe(false);
    expect(outcome).toEqual({
      ok: false,
      problem: seatsFullMessage(seatsFrom(5)),
    });
  });

  test("a server that refuses is quoted, and nothing is opened", async () => {
    let opened = false;
    const outcome = await createBotNow({
      create: async () => {
        throw new Error("자리가 없습니다.");
      },
      open: async () => {
        opened = true;
      },
      seats: seated,
      taken: [],
    });

    expect(opened).toBe(false);
    expect(outcome).toEqual({ ok: false, problem: "자리가 없습니다." });
  });
});

describe("the input a press sends", () => {
  test("a name, and nothing anybody was asked to invent", () => {
    const input = agentInputFrom({ ...emptyAgentForm, name: nextBotName([]) });
    expect(input.title).toBe("");
    expect(input.roleDescription).toBe("");
    // The server's default, and the only visibility this deployment has any use for.
    expect(input.visibility).toBe("private");
    expect("auth" in input).toBe(false);
  });
});
