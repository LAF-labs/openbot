import { afterAll, describe, expect, test } from "bun:test";
import { askModel } from "../src/computer/model-call";
import { createDaySummarizer } from "../src/context/day-close";

/**
 * Why a call this server makes has no answer, said as what happened.
 *
 * In three weeks of `eval:memory-days` every day's close that ran to the summariser's two minutes
 * was logged `summary: refused`, at 120,00x ms, with no refusal from the provider beside it. The
 * provider had answered 200 at once and was still writing the body when the deadline cut it; the
 * evaluation's `fetch` had looked at a copy of the reply first and swallowed the timeout, and the
 * call's own read then failed as JSON that ends early — which `askModel` took for a refusal. A
 * provider refusing wants waiting and a slow one wants a smaller question, so the name matters
 * (CLAUDE.md, "Model calls").
 */

/** A provider that answers 200 at once and never finishes the body, as a model still writing does. */
const stalled = Bun.serve({
  port: 0,
  fetch: () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(" "));
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
});

afterAll(async () => {
  await stalled.stop(true);
});

/** A `fetch` that reads a copy of the reply before handing it on, and keeps quiet when it cannot. */
const lookingFirst = (async (
  url: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const response = await fetch(url, init);
  try {
    await response.clone().json();
  } catch {
    // Not JSON, or not all of it: nothing to read.
  }
  return response;
}) as typeof fetch;

const call = (send?: typeof fetch) => ({
  baseUrl: `http://localhost:${stalled.port}/v1`,
  model: "some/model",
  apiKey: async () => "key",
  ...(send ? { fetch: send } : {}),
});

const replying = (reply: () => Response | Promise<Response>) =>
  (async () => reply()) as unknown as typeof fetch;

describe("why a server-side model call has no answer", () => {
  test.each([
    ["by this call alone", undefined],
    ["first by a fetch that looks at a copy of it", lookingFirst],
  ])(
    "a body the deadline cut is a call that took too long, read %s",
    async (_who, send) => {
      expect(
        await askModel(call(send), { system: "s", user: "u", timeoutMs: 100 }),
      ).toEqual({ ok: false, because: "took too long" });
    },
  );

  test("and the day's close records it as that", async () => {
    const summarize = createDaySummarizer(call(lookingFirst), {
      timeoutMs: 100,
    });
    await expect(
      summarize({
        previous: null,
        transcript: "사장님: 주문 확인해줘\n봇: 두 건입니다.",
        day: "2026-10-05 (월)",
      }),
    ).rejects.toThrow("summary: took too long");
  });

  test("a reply that came and is not JSON is unreadable", async () => {
    expect(
      await askModel(
        call(replying(() => new Response("<html>502</html>", { status: 200 }))),
        { system: "s", user: "u", timeoutMs: 1000 },
      ),
    ).toEqual({ ok: false, because: "unreadable" });
  });

  test.each([
    [
      "a status that says no",
      replying(() => Response.json({ error: "rate" }, { status: 429 })),
    ],
    [
      "nothing coming back at all",
      replying(() => {
        throw new TypeError("fetch failed");
      }),
    ],
  ])("%s is a refusal", async (_what, send) => {
    expect(
      await askModel(call(send), { system: "s", user: "u", timeoutMs: 1000 }),
    ).toEqual({ ok: false, because: "refused" });
  });
});
