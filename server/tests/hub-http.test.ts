import { describe, expect, test } from "bun:test";
import { createHubHttp } from "../src/hub/http";

/**
 * The one door every hub request goes through: which failures are tried again, which are not, and
 * the fact each one becomes. A fake `fetch` answers from a script, and the waits are recorded
 * instead of slept.
 */

type Scripted = Response | "network";

function harness(script: Scripted[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const waits: number[] = [];
  const http = createHubHttp({
    url: "https://acme.hub.example",
    vmKey: "a".repeat(64),
    vmOrigin: "https://kim.agent.example",
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = script.shift() ?? "network";
      if (next === "network") throw new TypeError("fetch failed");
      return next;
    }) as unknown as typeof fetch,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });
  return { http, calls, waits };
}

const json = (status: number, body: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("the hub's HTTP door", () => {
  test("a 5xx is tried again after 0.5 s and 2 s, and the answer that came is returned", async () => {
    const { http, calls, waits } = harness([
      json(503, { ok: false }),
      json(502, { ok: false }),
      json(200, { ok: true, seq: 7 }),
    ]);
    const answer = await http.request<{ seq: number }>({ path: "/me" });
    expect(answer).toEqual({
      ok: true,
      status: 200,
      body: { ok: true, seq: 7 } as never,
    });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([500, 2_000]);
  });

  test("a hub that never answers is four tries, 0.5 s, 2 s and 8 s apart, then unreachable", async () => {
    const { http, calls, waits } = harness([]);
    const answer = await http.request({ path: "/me" });
    expect(answer).toEqual({
      ok: false,
      status: null,
      code: "laf:hub_unreachable",
    });
    expect(calls).toHaveLength(4);
    expect(waits).toEqual([500, 2_000, 8_000]);
  });

  test.each([
    [401, "laf:hub_pass_refused"],
    [403, "laf:hub_forbidden"],
    [404, "laf:hub_not_found"],
  ])("a %p is answered once, never retried, as %p", async (status, code) => {
    const { http, calls, waits } = harness([
      json(status, { ok: false, code: "laf:anything" }),
    ]);
    expect(await http.request({ path: "/me" })).toEqual({
      ok: false,
      status,
      code,
    });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  test("another 4xx keeps the hub's own code and is not retried", async () => {
    const { http, calls } = harness([
      json(400, { ok: false, code: "laf:request_invalid" }),
    ]);
    expect(await http.request({ path: "/sync?since=x" })).toEqual({
      ok: false,
      status: 400,
      code: "laf:request_invalid",
    });
    expect(calls).toHaveLength(1);
  });

  test("a 429 waits what Retry-After says, then asks again", async () => {
    const { http, waits } = harness([
      json(429, { ok: false }, { "retry-after": "3" }),
      json(200, { ok: true }),
    ]);
    expect((await http.request({ path: "/me" })).ok).toBe(true);
    expect(waits).toEqual([3_000]);
  });

  test("one attempt only when asked, as the outbox does", async () => {
    const { http, calls, waits } = harness([json(503, {})]);
    expect((await http.request({ path: "/x", retry: false })).ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  test("the pass, the VM and the write's key ride in headers, the path under /hub/v1", async () => {
    const { http, calls } = harness([json(200, { ok: true })]);
    await http.request({
      method: "POST",
      path: "/rooms/r1/messages",
      body: { text: "hi" },
      idempotencyKey: "key-12345678",
      run: "run_1",
      origin: "chat",
    });
    const [call] = calls;
    expect(call?.url).toBe("https://acme.hub.example/hub/v1/rooms/r1/messages");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${"a".repeat(64)}`);
    expect(headers["x-laf-vm"]).toBe("https://kim.agent.example");
    expect(headers["idempotency-key"]).toBe("key-12345678");
    expect(headers["x-laf-run"]).toBe("run_1");
    expect(headers["x-laf-origin"]).toBe("chat");
    expect(call?.init.body).toBe('{"text":"hi"}');
  });

  test("the socket's address is the events route with the cursor, and the pass in a header", () => {
    const { http } = harness([]);
    const socket = http.socket(42);
    expect(socket.url).toBe("wss://acme.hub.example/hub/v1/events?since=42");
    expect(socket.url).not.toContain("a".repeat(64));
    expect(socket.headers.authorization).toBe(`Bearer ${"a".repeat(64)}`);
  });
});
