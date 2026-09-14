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
    .all("*", (context) => context.json({ reached: true })),
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

  test("only reading the list primes it", async () => {
    primed.length = 0;
    const response = await ask("/api/copilotkit/threads", { method: "POST" });
    expect(response.status).toBe(200);
    expect(primed).toEqual([]);
  });
});
