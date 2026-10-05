import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  FEED_REFUSALS,
  feedUnseenQueryOptions,
  likePost,
} from "../src/lib/feed/queries";
import {
  GOAL_REFUSALS,
  goalsQueryOptions,
  setGoalStatus,
} from "../src/lib/goals/queries";
import { RequestRefusedError } from "../src/lib/refusals";
import { ROUTINE_REFUSALS, routineRequest } from "../src/lib/routines/queries";
import {
  SUGGESTION_REFUSALS,
  suggestionRequest,
} from "../src/lib/routines/suggestions";
import { stubFetch } from "./support/fetch";

/**
 * FOUR DOORS, ONE WAY OF ASKING AND ONE WAY OF BEING REFUSED.
 *
 * The goals, 소식, the routines and their suggestions each ask the server the same way and each say
 * a refusal the same way: this surface's own sentence for the code, out of that door's own table,
 * with the status and the code beside it on what is thrown — and the one general sentence where no
 * table has the code, never the server's `error`, which is the code itself.
 *
 * Each of the four wrote that out for itself, so nothing held them to each other. This does, door
 * by door, through what each module exports — written while they were four copies, and passing
 * unchanged once they were one.
 *
 * Under a test runner `t()` answers in English, handing back its own key.
 */

const GENERAL = "That did not go through. Try again.";

type Asked = { url: string; init: RequestInit | undefined };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Every request answered the same way, and kept. */
function answering(status: number, body: unknown, type = "application/json") {
  const asked: Asked[] = [];
  globalThis.fetch = stubFetch(async (url, init) => {
    asked.push({ url: String(url), init });
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status, headers: { "content-type": type } },
    );
  });
  return asked;
}

/** Each door, asked without a body and with one, and a code its own table has. */
const DOORS = {
  goals: {
    read: () => runQuery(goalsQueryOptions()),
    write: () => setGoalStatus(new QueryClient(), "goal_1", "done"),
    table: GOAL_REFUSALS,
    code: "laf:goal_not_found",
  },
  feed: {
    read: () => runQuery(feedUnseenQueryOptions()),
    write: () => likePost("feed_1", true),
    table: FEED_REFUSALS,
    code: "laf:feed_post_not_found",
  },
  routines: {
    read: () => routineRequest("/api/routines"),
    write: () =>
      routineRequest("/api/routines/r_1/enabled", {
        method: "POST",
        body: JSON.stringify({ enabled: false }),
      }),
    table: ROUTINE_REFUSALS,
    code: "laf:routine_nothing_to_change",
  },
  suggestions: {
    read: () => suggestionRequest("/api/routines/suggestions"),
    write: () =>
      suggestionRequest("/api/routines/suggestions/reviews/accept", {
        method: "POST",
        body: JSON.stringify({ agentId: "bot_1" }),
      }),
    table: SUGGESTION_REFUSALS,
    code: "laf:routine_suggestion_not_offered",
  },
} as const;
type Door = keyof typeof DOORS;
const EVERY_DOOR = Object.keys(DOORS) as Door[];

/** A query's own read, as the query client would make it. */
function runQuery(options: { queryFn?: unknown }) {
  return (options.queryFn as (context: never) => Promise<unknown>)({} as never);
}

/** What a refused read threw, or the answer it got instead. */
async function thrownBy(work: () => Promise<unknown>) {
  try {
    return { answered: await work() };
  } catch (error) {
    return error;
  }
}

describe("what each door sends", () => {
  test("the session with every request, and a content type only with a body", async () => {
    for (const door of EVERY_DOOR) {
      const asked = answering(200, {});
      await DOORS[door].read();
      await DOORS[door].write();

      expect({ door, requests: asked.length }).toEqual({ door, requests: 2 });
      const [read, write] = asked;
      expect({ door, read: read?.init }).toEqual({
        door,
        read: { credentials: "include", headers: {} },
      });
      expect({
        door,
        credentials: write?.init?.credentials,
        headers: write?.init?.headers,
        hasBody: typeof write?.init?.body === "string",
      }).toEqual({
        door,
        credentials: "include",
        headers: { "content-type": "application/json" },
        hasBody: true,
      });
    }
  });

  test("the body as it came, for an answer", async () => {
    answering(200, { count: 3, routines: [{ id: "r_1" }] });
    expect(await runQuery(feedUnseenQueryOptions())).toBe(3);
    expect(await routineRequest("/api/routines")).toEqual({
      count: 3,
      routines: [{ id: "r_1" }],
    });
    // An answer that is not JSON is nothing, not a throw: the door was not refused.
    answering(200, "<html>", "text/html");
    expect(await suggestionRequest("/api/routines/suggestions")).toBeNull();
  });
});

describe("what each door says when it is refused", () => {
  test("its own table's sentence for the code, with the status and the code beside it", async () => {
    for (const door of EVERY_DOOR) {
      const { code, table } = DOORS[door];
      answering(409, { error: code, code });
      for (const ask of [DOORS[door].read, DOORS[door].write]) {
        const thrown = await thrownBy(ask);
        expect({
          door,
          refused: thrown instanceof RequestRefusedError,
        }).toEqual({ door, refused: true });
        const refusal = thrown as RequestRefusedError;
        expect({
          door,
          message: refusal.message,
          status: refusal.status,
          code: refusal.code,
        }).toEqual({ door, message: table[code], status: 409, code });
        // The sentence, and not the code the server put in `error`.
        expect(refusal.message).not.toContain("laf:");
      }
    }
  });

  test("the general sentence for a code no table has, and the code still travels", async () => {
    for (const door of EVERY_DOOR) {
      answering(403, {
        error: "laf:invented_tomorrow",
        code: "laf:invented_tomorrow",
      });
      const refusal = (await thrownBy(DOORS[door].read)) as RequestRefusedError;
      expect({
        door,
        message: refusal.message,
        status: refusal.status,
        code: refusal.code,
      }).toEqual({
        door,
        message: GENERAL,
        status: 403,
        code: "laf:invented_tomorrow",
      });
    }
  });

  test("the general sentence and no code for a body that carries none", async () => {
    for (const door of EVERY_DOOR) {
      for (const [status, body, type] of [
        [502, "<html>Bad Gateway</html>", "text/html"],
        [500, { error: "Internal Server Error" }, "application/json"],
        [500, { code: 500 }, "application/json"],
      ] as const) {
        answering(status, body, type);
        const refusal = (await thrownBy(
          DOORS[door].read,
        )) as RequestRefusedError;
        expect({
          door,
          status,
          refused: refusal instanceof RequestRefusedError,
          message: refusal.message,
          code: refusal.code,
        }).toEqual({
          door,
          status,
          refused: true,
          message: GENERAL,
          code: null,
        });
      }
    }
  });

  /*
   * THE ONE PLACE THE FOUR COPIES DISAGREED, and why this test came with the one function rather
   * than before it: a code that is the empty string was kept as "" by the routines' copy and read
   * as no code by the other three. No route sends one (`server/tests/error-codes.test.ts`), and
   * nothing that reads `code` off what is thrown can tell "" from none — every reader asks for a
   * `laf:` fact — so it is none at every door.
   */
  test("a code that is the empty string is no code, at every door", async () => {
    for (const door of EVERY_DOOR) {
      answering(400, { error: "", code: "" });
      const refusal = (await thrownBy(DOORS[door].read)) as RequestRefusedError;
      expect({ door, message: refusal.message, code: refusal.code }).toEqual({
        door,
        message: GENERAL,
        code: null,
      });
    }
  });

  /*
   * Accepting a suggestion IS creating a routine, so every refusal a routine can meet can come back
   * from it — the cap, above all — and it is said in the routines' words. Its own table comes first.
   */
  test("a suggestion is refused in a routine's words where the refusal is a routine's", async () => {
    const [routinesOnly] = Object.keys(ROUTINE_REFUSALS).filter(
      (code) => !(code in SUGGESTION_REFUSALS),
    );
    if (!routinesOnly)
      throw new Error("the routines' table has no code of its own");
    answering(409, { error: routinesOnly, code: routinesOnly });
    const refusal = (await thrownBy(() =>
      suggestionRequest("/api/routines/suggestions/reviews/accept", {
        method: "POST",
      }),
    )) as RequestRefusedError;
    expect(refusal.message).toBe(ROUTINE_REFUSALS[routinesOnly] as string);
    expect(refusal.code).toBe(routinesOnly);

    // And only the suggestions' door reads a second table: the goals do not borrow the routines'.
    const borrowed = (await thrownBy(DOORS.goals.read)) as RequestRefusedError;
    expect(borrowed.message).toBe(GENERAL);
  });
});
