import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { primeThreadRoutes } from "../src/runner/thread-priming";

/**
 * The runtime's thread routes read the thread they answer for before the runtime is asked, and
 * refuse one that is not the caller's — because the vendored runner's live copy would otherwise
 * answer it out of memory. The runner itself is `thread-scope.integration.test.ts`'s; this is the
 * door in front of it, which was a middleware chain inside `main.ts` until 2026-09-14.
 */

const primed: string[] = [];
const runner = {
  primeThreadList: async (userId: string) => {
    primed.push(`list:${userId}`);
  },
  prime: async (threadId: string, userId: string) => {
    primed.push(`thread:${threadId}:${userId}`);
    return threadId === "thread-mine";
  },
  getThreadMessages: (threadId: string) =>
    threadId === "thread-mine"
      ? ([
          { id: "u1", role: "user", content: "재고" },
          {
            id: "a1",
            role: "assistant",
            encryptedValue: '{"model":"m","reasoning_details":[]}',
            toolCalls: [],
          },
        ] as never)
      : [],
  stepState: (threadId: string) => ({
    running: false,
    waiting: threadId === "thread-mine",
  }),
  abandonStep: (threadId: string) => {
    primed.push(`abandon:${threadId}`);
    return true;
  },
};

/** The runtime, as far as these routes reach it: its own basePath, and a note that it was reached. */
const app = primeThreadRoutes({
  runner,
  actorOf: async (request) => {
    const id = request.headers.get("x-test-actor");
    return id ? { id } : null;
  },
}).route(
  "/",
  new Hono()
    .basePath("/api/copilotkit")
    /*
     * One wildcard, as the runtime routes (`fetch-router` reads the path itself). Behind it the
     * outer middleware's `param("threadId")` no longer answers — measured on the real stack, where
     * reading it after `next()` came back undefined and nothing was put back.
     */
    .all("*", (context) =>
      context.req.path.endsWith("/messages")
        ? // The runtime's own shape: every message rebuilt from a list of keys, not `encryptedValue`.
          context.json({
            messages: [
              { id: "u1", role: "user", content: "재고" },
              { id: "a1", role: "assistant", toolCalls: [] },
            ],
          })
        : context.json({ reached: true }),
    ),
);

const ask = (path: string, init: RequestInit & { actor?: string } = {}) =>
  app.request(`http://laf.test${path}`, {
    ...init,
    headers: init.actor ? { "x-test-actor": init.actor } : {},
  });

describe("the runtime's thread routes", () => {
  test("the list is primed for the person asking, and then the runtime answers", async () => {
    primed.length = 0;
    const response = await ask("/api/copilotkit/threads", { actor: "owner" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reached: true });
    expect(primed).toEqual(["list:owner"]);
  });

  test("a thread of the caller's is primed and answered", async () => {
    primed.length = 0;
    const response = await ask("/api/copilotkit/threads/thread-mine/messages", {
      actor: "owner",
    });
    expect(response.status).toBe(200);
    expect(primed).toEqual(["thread:thread-mine:owner"]);
  });

  test("somebody else's thread is refused here, before the runtime can answer it from memory", async () => {
    const response = await ask(
      "/api/copilotkit/threads/thread-theirs/messages",
      { actor: "owner" },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "laf:thread_not_found",
      code: "laf:thread_not_found",
    });
  });

  test("a caller whose session could not be read is refused, not guessed at", async () => {
    primed.length = 0;
    for (const path of [
      "/api/copilotkit/threads",
      "/api/copilotkit/threads/thread-mine/messages",
    ]) {
      const response = await ask(path);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: "laf:unauthenticated",
        code: "laf:unauthenticated",
      });
    }
    expect(primed).toEqual([]);
  });

  test("a message's carried reasoning comes back on the messages route, which drops it", async () => {
    const response = await ask("/api/copilotkit/threads/thread-mine/messages", {
      actor: "owner",
    });
    expect(await response.json()).toEqual({
      messages: [
        { id: "u1", role: "user", content: "재고" },
        {
          id: "a1",
          role: "assistant",
          toolCalls: [],
          encryptedValue: '{"model":"m","reasoning_details":[]}',
        },
      ],
    });
  });

  test("whether a step is out, and letting one go, are the thread's own person's (0.5.4 A)", async () => {
    const step = await ask("/api/copilotkit/threads/thread-mine/step", {
      actor: "owner",
    });
    expect(step.status).toBe(200);
    expect(await step.json()).toEqual({ running: false, waiting: true });

    primed.length = 0;
    const theirs = await ask(
      "/api/copilotkit/threads/thread-theirs/step-abandoned",
      { actor: "owner", method: "POST" },
    );
    expect(theirs.status).toBe(404);
    expect(primed).toEqual(["thread:thread-theirs:owner"]);

    primed.length = 0;
    const mine = await ask(
      "/api/copilotkit/threads/thread-mine/step-abandoned",
      { actor: "owner", method: "POST" },
    );
    expect(await mine.json()).toEqual({ abandoned: true });
    expect(primed).toEqual(["thread:thread-mine:owner", "abandon:thread-mine"]);
  });

  test("only reading the list primes it", async () => {
    primed.length = 0;
    const response = await ask("/api/copilotkit/threads", { method: "POST" });
    expect(response.status).toBe(200);
    expect(primed).toEqual([]);
  });
});
