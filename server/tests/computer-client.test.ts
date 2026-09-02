import { describe, expect, test } from "bun:test";
import {
  ComputerUnavailableError,
  createComputerClient,
  ElementNotFoundError,
  NavigationRefusedError,
} from "../src/computer/client";

function clientWith(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
  allowPrivateHosts = false,
  timeoutMs?: number,
) {
  return createComputerClient({
    baseUrl: "http://agent-computer:4100",
    allowPrivateHosts,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    fetchImpl: ((url: string, init?: RequestInit) =>
      Promise.resolve(handler(url, init))) as unknown as typeof fetch,
  });
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("computer client", () => {
  test("navigates and returns where it landed", async () => {
    const seen: string[] = [];
    const client = clientWith((url, init) => {
      seen.push(url);
      expect(JSON.parse(String(init?.body))).toEqual({
        url: "https://example.com/",
      });
      return ok({
        url: "https://example.com/",
        title: "Example",
        // The page's readable text, which is the whole reason navigate returns a body at all. It
        // was missing from both halves of this test, so the one call that carries what the model
        // reads was asserted without it.
        text: "Example Domain",
        truncated: false,
        elapsedMs: 12,
      });
    });

    await expect(client.navigate("https://example.com/")).resolves.toEqual({
      url: "https://example.com/",
      title: "Example",
      text: "Example Domain",
      truncated: false,
      elapsedMs: 12,
    });
    expect(seen).toEqual(["http://agent-computer:4100/navigate"]);
  });

  // The refusal happens before anything leaves. A guard that only inspects the response has
  // already let the request reach the internal service it was meant to protect.
  test("refuses an internal address without calling the computer", async () => {
    let called = false;
    const client = clientWith(() => {
      called = true;
      return ok({});
    });

    await expect(client.navigate("http://169.254.169.254/")).rejects.toThrow(
      NavigationRefusedError,
    );
    expect(called).toBe(false);
  });

  // The opt-in every laptop sets must not be a way to reach the cloud credential endpoint. The
  // earlier test above passes with the opt-in OFF, which is what let this through unnoticed.
  test("refuses cloud metadata even when private hosts are allowed", async () => {
    let called = false;
    const client = clientWith(() => {
      called = true;
      return ok({});
    }, true);

    for (const target of [
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
    ]) {
      await expect(client.navigate(target)).rejects.toThrow(
        NavigationRefusedError,
      );
    }
    expect(called).toBe(false);
  });

  test("allows an internal address when the deployment opted in", async () => {
    const client = clientWith(
      () => ok({ url: "http://localhost:3000/", title: "Local", elapsedMs: 3 }),
      true,
    );

    await expect(
      client.navigate("http://localhost:3000/"),
    ).resolves.toMatchObject({ title: "Local" });
  });

  // Two different failures that read identically to a person unless we separate them: the computer
  // being absent is an operator problem, a page failing to load is not.
  test("reports an absent computer distinctly from a failed page", async () => {
    const missing = clientWith(() => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(missing.navigate("https://example.com")).rejects.toThrow(
      "The assistant's computer is not running.",
    );

    const badPage = clientWith(
      () =>
        new Response(JSON.stringify({ error: "net::ERR_NAME_NOT_RESOLVED" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(badPage.navigate("https://nope.example")).rejects.toThrow(
      "net::ERR_NAME_NOT_RESOLVED",
    );
  });

  test("status reports unreachable rather than throwing", async () => {
    const client = clientWith(() => {
      throw new Error("down");
    });

    await expect(client.status("bot-1")).resolves.toEqual({
      botId: "bot-1",
      state: "unreachable",
      reason: "The assistant's computer is not running.",
    });
  });

  test("screenshot returns the png a transcript can render", async () => {
    const client = clientWith(() =>
      ok({
        base64: "aGVsbG8=",
        width: 1280,
        height: 800,
        capturedAt: "2026-08-14T00:00:00.000Z",
      }),
    );

    await expect(client.screenshot()).resolves.toMatchObject({
      base64: "aGVsbG8=",
      width: 1280,
    });
  });

  test("surfaces a timeout as the computer not responding", async () => {
    const client = clientWith(() => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    });

    await expect(client.status("bot-1")).resolves.toMatchObject({
      state: "unreachable",
      reason: "The assistant's computer did not respond in time.",
    });
  });
});

/**
 * A ref that is not on the page.
 *
 * Reported as a stale snapshot, not as computer unavailability. A model can recover by taking a
 * fresh snapshot.
 */
describe("acting on an element that is not there", () => {
  const playwrightTimeout = {
    error:
      "click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('aria-ref=e5')\n",
  };

  const timingOut = () =>
    clientWith(
      () =>
        new Response(JSON.stringify(playwrightTimeout), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );

  test("is its own condition, not an unavailable computer", async () => {
    expect(
      timingOut().click({ ref: "e5", snapshotId: 1 }),
    ).rejects.toBeInstanceOf(ElementNotFoundError);
  });

  test("says what to do next, and drops the call log", async () => {
    try {
      await timingOut().click({ ref: "e5", snapshotId: 1 });
      throw new Error("should have refused");
    } catch (error) {
      const message = (error as Error).message;
      // The instruction, naming the ref that failed.
      expect(message).toContain("e5");
      expect(message).toContain("fresh snapshot");
      // Not several lines of Playwright internals, which are noise to a model and to a person.
      expect(message).not.toContain("Call log");
      expect(message).not.toContain("Timeout");
    }
  });
});

/**
 * Stop has to travel.
 *
 * Pressing Stop aborts the surface's request. That abort is only useful if it reaches the browser: a
 * click already running in Chromium otherwise lands anyway, which is harmless most of the time and
 * not harmless on a Confirm button, precisely the moment somebody presses Stop.
 */
describe("the caller's Stop", () => {
  test("is passed to the request, so it can reach the browser", async () => {
    let seen: AbortSignal | undefined;
    const client = clientWith((_url, init) => {
      seen = init?.signal ?? undefined;
      return ok({ action: "click" });
    });

    const stop = new AbortController();
    await client.click({ ref: "e1", snapshotId: 1 }, stop.signal);

    expect(seen).toBeDefined();
    // Not the caller's signal itself: it is combined with the timeout, because a computer that stops
    // answering must still end the request even when nobody pressed anything.
    expect(seen?.aborted).toBe(false);
    stop.abort();
    expect(seen?.aborted).toBe(true);
  });

  test("a request that was already stopped never reaches the computer", async () => {
    let called = false;
    const client = clientWith(() => {
      called = true;
      return ok({ action: "click" });
    });

    const stop = new AbortController();
    stop.abort();

    // The refusal a stopped caller gets, named. `toBeDefined()` here accepted any rejection at all,
    // including the TypeError a broken client would produce — which is the one outcome that would
    // mean this path is not doing what the test says it does.
    await expect(
      client.click({ ref: "e1", snapshotId: 1 }, stop.signal),
    ).rejects.toThrow(ComputerUnavailableError);
    expect(called).toBe(false);
  });

  test("without one, the timeout still applies", async () => {
    let seen: AbortSignal | undefined;
    // Ten milliseconds, so the bound is watched rather than asserted to exist. `toBeDefined()` on
    // the signal passed against a client that had combined nothing and would hang forever.
    const client = clientWith(
      (_url, init) => {
        seen = init?.signal ?? undefined;
        return ok({ action: "click" });
      },
      false,
      10,
    );

    await client.click({ ref: "e1", snapshotId: 1 });

    expect(seen?.aborted).toBe(false);
    await Bun.sleep(30);
    // A caller that passes nothing must not end up with an unbounded request: the signal the client
    // built for itself fires on its own.
    expect(seen?.aborted).toBe(true);
    expect((seen?.reason as Error | undefined)?.name).toBe("TimeoutError");
  });
});

/**
 * WHICH BOT IS ASKING, ON EVERY CALL.
 *
 * Nothing in this repository named `x-openbot-bot-id` until this test, and it is the string the
 * whole per-Bot half of the computer hangs off: the profile that holds the logins, the proxy the
 * traffic leaves through, whose wheel is being held. A method that forgets it does not fail — it
 * silently lands on the default computer, on a blank page belonging to nobody, and the Bot reports
 * that the site logged it out.
 *
 * Every method, driven for real rather than a chosen few, because the way this breaks is a method
 * added later that does not go through the same `call`.
 */
describe("the header that says which Bot", () => {
  function recording() {
    const sent: Array<{ path: string; botId: string | null }> = [];
    const client = clientWith((url, init) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      sent.push({
        path: new URL(url).pathname,
        botId: headers.get("x-openbot-bot-id"),
      });
      return ok({
        url: "https://example.com/",
        title: "Example",
        elapsedMs: 1,
        base64: "aGVsbG8=",
        snapshotId: 1,
        elements: [],
        entries: [],
        contents: "",
        characters: 3,
        computers: [],
        holder: "bot",
      });
    }, true);
    return { client, sent };
  }

  /** Every method that reaches the computer, called once. */
  const drive = async (client: ReturnType<typeof recording>["client"]) => {
    await client.status("bot-7");
    await client.navigate("https://example.com/");
    await client.screenshot();
    await client.read();
    await client.snapshot();
    await client.click({ ref: "e1", snapshotId: 1 });
    await client.type({ ref: "e1", snapshotId: 1, text: "hello" });
    await client.key({ key: "Enter" });
    await client.scroll({ deltaY: 100 });
    await client.readFile({ path: "notes.md" });
    await client.writeFile({ path: "notes.md", contents: "hi" });
    await client.listFiles({});
    await client.control();
    await client.requestControl("stuck");
    await client.takeControl();
    await client.releaseControl();
    await client.requestSecret({ label: "PIN", ref: "e1", snapshotId: 1 });
    await client.supplySecret("hunter2");
    await client.humanInput({ kind: "click", x: 1, y: 2 });
    await client.computers();
    await client.stopComputer();
    await client.resetComputer();
  };

  test("rides every call a Bot's view makes", async () => {
    const { client, sent } = recording();

    await drive(client.forBot("bot-7"));

    expect(sent.length).toBeGreaterThan(20);
    const missing = sent.filter((call) => call.botId !== "bot-7");
    // Named, so a failure says which method forgot rather than only that one did.
    expect(missing.map((call) => call.path)).toEqual([]);
  });

  test("is absent from a client that was never told which Bot", async () => {
    // The base client is what a health probe and the admin computer listing use. It has no Bot to
    // name, and the computer's own fallback is what answers it — which is correct for exactly this
    // caller and wrong for every other one, hence the test above.
    const { client, sent } = recording();

    await drive(client);

    expect(sent.every((call) => call.botId === null)).toBe(true);
  });

  test("even /health carries it, so a probe is answered for that Bot's own computer", async () => {
    const { client, sent } = recording();

    await client.forBot("bot-7").status("bot-7");

    expect(sent).toEqual([{ path: "/health", botId: "bot-7" }]);
  });
});
