import { describe, expect, test } from "bun:test";
import { toolResultText } from "../../shared/prompt/tool-results.ko";
import {
  ComputerUnavailableError,
  ControlHeldError,
  createComputerClient,
  PAGE_TIMEOUT,
  PageLoadFailedError,
  PageLoadTimeoutError,
  ElementNotFoundError,
  NavigationRefusedError,
  StaleSnapshotError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
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

  /*
   * A routine's deadline, or a person's Stop, reaches navigate as it reaches click: a caller that
   * has already stopped is not dispatched at all. Navigate was the one acting call without the
   * parameter, so a routine that ran out of time mid-navigation still opened the page.
   */
  test("navigate does not dispatch for a caller that has already stopped", async () => {
    let dispatched = 0;
    const client = clientWith(() => {
      dispatched += 1;
      return ok({ url: "https://example.com/", title: "", text: "" });
    });
    const stop = new AbortController();
    stop.abort();

    await expect(
      client.navigate("https://example.com/", stop.signal),
    ).rejects.toThrow("laf:stopped");
    expect(dispatched).toBe(0);
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
    await expect(client.navigate("http://169.254.169.254/")).rejects.toThrow(
      "laf:navigation_refused",
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

  /*
   * WHERE IT LANDED, not only where it was asked to go (audit A3, 2026-09-10).
   *
   * The check above judges the address the Bot named, before the request. A public host that 302s
   * to `127.0.0.1` passes it — the host asked for is public — and the browser then follows the
   * redirect. The computer image every deployment runs until it pulls does not yet stop the hop, so
   * the server judges the URL the navigation reports having landed on, and stops the computer so the
   * page is not left open for the next `computer_read` to fetch.
   */
  test("refuses a navigation that landed on an internal address after a redirect", async () => {
    const paths: string[] = [];
    const client = clientWith((url) => {
      paths.push(new URL(url).pathname);
      if (url.endsWith("/navigate")) {
        // The public redirector was allowed; the browser followed it here.
        return ok({
          url: "http://169.254.169.254/latest/meta-data/",
          title: "",
          text: "ami-id\ninstance-id",
          truncated: false,
          elapsedMs: 20,
        });
      }
      return ok({ stopped: true, wasRunning: true });
    });

    await expect(
      client.navigate(
        "https://httpbin.org/redirect-to?url=http://169.254.169.254/",
      ),
    ).rejects.toThrow(NavigationRefusedError);
    // It stopped the browser after refusing, so the page it landed on is not left open.
    expect(paths).toEqual(["/navigate", "/computers/stop"]);
  });

  // The gateway's two asks of a navigation: stop at a host it has not judged, and send the Referer a
  // stopped hop was carrying. Neither is sent when not asked for, so a caller that is not the gateway
  // gets a browser that follows redirects under the floor, as it always did.
  test("asks the computer to hold at a new host, with the Referer, only when told to", async () => {
    const bodies: unknown[] = [];
    const client = clientWith((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return ok({
        url: "https://www.coupang.com/",
        title: "",
        text: "",
        truncated: false,
        elapsedMs: 1,
      });
    });

    await client.navigate("https://www.coupang.com/", undefined, {
      holdAtNewHost: true,
      referer: "https://bit.ly/",
    });
    await client.navigate("https://www.coupang.com/");
    expect(bodies).toEqual([
      {
        url: "https://www.coupang.com/",
        holdAtNewHost: true,
        referer: "https://bit.ly/",
      },
      { url: "https://www.coupang.com/" },
    ]);
  });

  // The computer refusing the hop itself (the newer image) reaches the server as its own code, and
  // must read as a refusal a person can act on rather than as the computer being broken.
  test("relays the computer's own redirect refusal as a refusal", async () => {
    const client = clientWith(
      () =>
        new Response(
          JSON.stringify({
            error: "laf:navigation_refused",
            code: "laf:navigation_refused",
            reason:
              "That address is inside this deployment's own network, so the assistant is not allowed to open it.",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(
      client.navigate("https://httpbin.org/redirect-to?url=http://10.0.0.5/"),
    ).rejects.toThrow(NavigationRefusedError);
  });

  // Two different failures that read identically to a person unless we separate them: the computer
  // being absent is an operator problem, a page failing to load is not.
  test("reports an absent computer distinctly from a failed page", async () => {
    const missing = clientWith(() => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(missing.navigate("https://example.com")).rejects.toThrow(
      "laf:computer_unreachable",
    );

    // What the container answers for an address that does not resolve (agent-computer/src/navigation.ts).
    const badPage = clientWith(
      () =>
        new Response(
          JSON.stringify({
            error: "laf:navigation_failed",
            code: "laf:navigation_failed",
          }),
          { status: 502, headers: { "content-type": "application/json" } },
        ),
    );
    // The container's own name for it, passed on — not a second one this file used to give it
    // (`laf:page_failed`), and not Chromium's words, which reached a Korean model as they came.
    const failure = await badPage
      .navigate("https://nope.example")
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(PageLoadFailedError);
    expect((failure as Error).message).toBe("laf:navigation_failed");
  });

  test("status reports unreachable rather than throwing", async () => {
    const client = clientWith(() => {
      throw new Error("down");
    });

    await expect(client.status("bot-1")).resolves.toEqual({
      botId: "bot-1",
      state: "unreachable",
      reason: "laf:computer_unreachable",
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
      // Its own fact, not the absent computer's: audit A3 (S3) found a slow page read as a broken one.
      reason: "laf:computer_timed_out",
    });
  });
});

/**
 * An element that would not take the action.
 *
 * Reported as its own condition, not as computer unavailability. A model can recover by looking again.
 */
describe("acting on an element that would not take it", () => {
  /** What the container answers (agent-computer/src/failures.ts). */
  const refusing = () =>
    clientWith(
      () =>
        new Response(
          JSON.stringify({
            error: "laf:element_not_actionable",
            code: "laf:element_not_actionable",
            stale: true,
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );

  test("is its own condition, not an unavailable computer", async () => {
    expect(
      refusing().click({ ref: "e5", snapshotId: 1 }),
    ).rejects.toBeInstanceOf(ElementNotFoundError);
  });

  test("is the container's fact, whose words say what to do next", async () => {
    const failure = await refusing()
      .click({ ref: "e5", snapshotId: 1 })
      .catch((error: Error) => error);
    expect((failure as Error).message).toBe("laf:element_not_actionable");
    expect(toolResultText((failure as Error).message)).toContain(
      "computer_snapshot",
    );
  });

  /*
   * UNTIL 2026-09-14 THIS WAS FOUND IN PLAYWRIGHT'S CALL LOG — `waiting for locator` in `error` meant
   * a stale ref — and the call log of a `fill` is where the typed value rides. An answer that carries
   * the log and no code is a computer that did not say what happened, and that is all it is.
   */
  test("Playwright's call log without a code decides nothing, and goes nowhere", async () => {
    const logged = clientWith(
      () =>
        new Response(
          JSON.stringify({
            error:
              "click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('aria-ref=e5')\n",
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    );
    const failure = await logged
      .click({ ref: "e5", snapshotId: 1 })
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(ComputerUnavailableError);
    expect((failure as Error).message).toBe("laf:computer_failed");
  });
});

/**
 * WHAT THE COMPUTER SAID, AS THE FACTS IT WAS.
 *
 * Until 2026-09-14 every refusal from the computer went up as whatever the container wrote in
 * `error` — "There is no file at notes.md.", "Nothing is waiting for a secret.", a Playwright log —
 * and the routes answered with it, into a Korean model's tool result and onto a Korean screen. Then,
 * for a day, a sentence became a fact of this client's own choosing, read off the door and the
 * status. Now the container's `code` passes through, and an answer without one is `laf:computer_failed`.
 */
describe("a refusal from the computer", () => {
  /** A value somebody typed, distinctive enough that finding it anywhere means what it looks like. */
  const SECRET_VALUE = "hunter2-Zx9-BANKPASS";

  const answering = (status: number, body: Record<string, unknown>) => () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const failureOf = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("should have refused");
      },
      (error: Error) => error,
    );

  test("that carries a code keeps the code", async () => {
    const relabelled = clientWith(
      answering(409, {
        error: "laf:label_changed",
        code: "laf:label_changed",
        stale: true,
      }),
    );
    const failure = await failureOf(
      relabelled.click({ ref: "e5", snapshotId: 1 }),
    );
    expect(failure).toBeInstanceOf(StaleSnapshotError);
    expect(failure.message).toBe("laf:label_changed");

    const held = clientWith(
      answering(409, {
        error: "laf:human_has_control",
        code: "laf:human_has_control",
        humanHasControl: true,
      }),
    );
    const waiting = await failureOf(held.click({ ref: "e5", snapshotId: 1 }));
    // Its own type: routes.ts found this one by matching `control` in a message until 2026-09-14.
    expect(waiting).toBeInstanceOf(ControlHeldError);
    expect(waiting.message).toBe("laf:human_has_control");
  });

  test("about a workspace path is the container's own fact, one name for each", async () => {
    const CASES: Array<[number, string, new (reason: string) => Error]> = [
      [400, "laf:file_not_found", WorkspaceRequestError],
      [400, "laf:file_wrong_kind", WorkspaceRequestError],
      [400, "laf:file_too_large", WorkspaceRequestError],
      [403, "laf:file_path_refused", WorkspaceRefusedError],
    ];
    for (const [status, code, kind] of CASES) {
      const client = clientWith(answering(status, { error: code, code }));
      const failure = await failureOf(client.readFile({ path: "notes.md" }));
      expect({ code, kind: failure.name, message: failure.message }).toEqual({
        code,
        kind: kind.name,
        message: code,
      });
    }
  });

  test("a sentence with no code is the computer failing, never the sentence and never a guess", async () => {
    // The two this client used to read off the door and the status: a missing file was
    // `laf:workspace_file_unusable` whatever it was, and a path outside `laf:workspace_path_refused`.
    for (const [status, error] of [
      [400, "There is no file at notes.md."],
      [403, "../secrets is outside your workspace, so it cannot be reached."],
    ] as const) {
      const client = clientWith(answering(status, { error }));
      const failure = await failureOf(client.readFile({ path: "notes.md" }));
      expect(failure).toBeInstanceOf(ComputerUnavailableError);
      expect(failure.message).toBe("laf:computer_failed");
    }
  });

  test("on a person's own door is the container's fact about what the person was doing", async () => {
    // The masked box: nothing asked for a value, or the box it was for would not take it.
    const nothingAsked = clientWith(
      answering(409, {
        error: "laf:secret_not_pending",
        code: "laf:secret_not_pending",
      }),
    );
    expect(
      (await failureOf(nothingAsked.supplySecret(SECRET_VALUE))).message,
    ).toBe("laf:secret_not_pending");
    const gone = clientWith(
      answering(409, {
        error: "laf:element_not_actionable",
        code: "laf:element_not_actionable",
        stale: true,
      }),
    );
    // The container's name, where this client used to say `laf:secret_field_gone` of its own.
    expect((await failureOf(gone.supplySecret(SECRET_VALUE))).message).toBe(
      "laf:element_not_actionable",
    );
    // The live screen, pressed before the wheel was taken.
    const notYours = clientWith(
      answering(409, {
        error: "laf:take_control_first",
        code: "laf:take_control_first",
      }),
    );
    const early = await failureOf(
      notYours.humanInput({ kind: "click", x: 1, y: 2 }),
    );
    expect(early).toBeInstanceOf(ControlHeldError);
    expect(early.message).toBe("laf:take_control_first");
  });

  test("a code this server does not know yet still passes through, and a malformed one does not", async () => {
    // A newer container than this server, for the length of a rollout: the fact is kept, not renamed.
    const newer = clientWith(
      answering(502, {
        error: "laf:printer_on_fire",
        code: "laf:printer_on_fire",
      }),
    );
    const kept = await failureOf(newer.screenshot());
    expect(kept).toBeInstanceOf(ComputerUnavailableError);
    expect(kept.message).toBe("laf:printer_on_fire");

    // `code` is read as a code only when it has a code's shape; anything else is a sentence.
    for (const code of [
      "laf:Your session has expired, please sign in",
      "laf:",
      42,
      `laf:${"x".repeat(65)}`,
    ]) {
      const odd = clientWith(answering(500, { error: "x", code }));
      expect((await failureOf(odd.screenshot())).message).toBe(
        "laf:computer_failed",
      );
    }
  });

  test("the floor says which of its two refusals it was", async () => {
    let called = false;
    const client = clientWith(() => {
      called = true;
      return ok({});
    });
    // Not a web address: fixed by writing one.
    for (const target of ["open the pricing page", "file:///etc/passwd"]) {
      expect((await failureOf(client.navigate(target))).message).toBe(
        "laf:url_invalid",
      );
    }
    // A web address that points inside the deployment: no rewording opens it.
    expect((await failureOf(client.navigate("http://10.0.0.5/"))).message).toBe(
      "laf:navigation_refused",
    );
    expect(called).toBe(false);
  });

  test("a caller who stops while the request is out is told it stopped, not that the computer is gone", async () => {
    const stop = new AbortController();
    const client = clientWith(async (_url, init) => {
      stop.abort();
      // What fetch does with an aborted signal: it rejects with the abort, not with a response.
      throw init?.signal?.reason ?? new DOMException("aborted", "AbortError");
    });
    expect(
      (await failureOf(client.click({ ref: "e1", snapshotId: 1 }, stop.signal)))
        .message,
    ).toBe("laf:stopped");
  });

  test("no failure the client raises carries a sentence", async () => {
    const cases: Array<[number, Record<string, unknown>, string]> = [
      [502, { error: "The action failed." }, "/click"],
      [500, { error: "Screenshot failed." }, "/screenshot"],
      [401, { error: "Not authorised." }, "/snapshot"],
      [409, { error: "Nothing is waiting for a secret." }, "/human/secret"],
      [400, { error: "notes is a directory, not a file." }, "/files/read"],
    ];
    for (const [status, body, path] of cases) {
      const client = clientWith(answering(status, body));
      const call =
        path === "/click"
          ? client.click({ ref: "e1", snapshotId: 1 })
          : path === "/screenshot"
            ? client.screenshot()
            : path === "/snapshot"
              ? client.snapshot()
              : path === "/human/secret"
                ? client.supplySecret(SECRET_VALUE)
                : client.readFile({ path: "notes" });
      const failure = await failureOf(call);
      expect({ path, fact: failure.message.startsWith("laf:") }).toEqual({
        path,
        fact: true,
      });
      expect(failure.message).not.toContain(String(body.error));
    }
  });
});

/**
 * A page that never finishes loading.
 *
 * Playwright says "Timeout" here too, and until 2026-09-06 that word alone sent it down the locator
 * branch above: a Bot whose browser could not reach 기업마당 was told an element had left the page
 * and to snapshot again — four navigations, two snapshots, six minutes, no sentence to act on.
 */
describe("a navigation that never finishes", () => {
  /** What the container answers at its deadline (agent-computer/src/navigation.ts). */
  const hanging = () =>
    clientWith(
      () =>
        new Response(
          JSON.stringify({
            error: "laf:page_timeout",
            code: "laf:page_timeout",
            recycled: "page",
            elapsedMs: 30_004,
          }),
          { status: 504, headers: { "content-type": "application/json" } },
        ),
    );

  test("is the page not loading, not an element that left it", async () => {
    await expect(
      hanging().navigate("https://www.bizinfo.go.kr/"),
    ).rejects.toBeInstanceOf(PageLoadTimeoutError);
  });

  test("is said as the fact code, which has Korean behind it", async () => {
    try {
      await hanging().navigate("https://www.bizinfo.go.kr/");
      throw new Error("should have refused");
    } catch (error) {
      expect((error as Error).message).toBe(PAGE_TIMEOUT);
      expect(toolResultText(PAGE_TIMEOUT)).not.toBe(PAGE_TIMEOUT);
      expect(toolResultText(PAGE_TIMEOUT)).not.toContain("snapshot");
    }
  });

  /*
   * MEASURED 2026-09-14, against the computer run from source: an address that does not resolve is
   * refused by Chromium in under a second, and the call log beside it says `navigating to "` like
   * every failed `goto` does. That phrase alone used to be read as a timeout, so the Bot was told the
   * page had taken thirty seconds not to load. The container names it now.
   */
  test("an address that does not resolve is a page that failed, not one that timed out", async () => {
    const unresolved = clientWith(
      () =>
        new Response(
          JSON.stringify({
            error: "laf:navigation_failed",
            code: "laf:navigation_failed",
          }),
          { status: 502, headers: { "content-type": "application/json" } },
        ),
    );
    const failure = await unresolved
      .navigate("https://nope.invalid/")
      .catch((error: Error) => error);
    expect(failure).not.toBeInstanceOf(PageLoadTimeoutError);
    expect(failure).toBeInstanceOf(PageLoadFailedError);
    expect((failure as Error).message).toBe("laf:navigation_failed");
  });

  /*
   * THE LINE-MATCHING IS GONE. The container kept `goto: Timeout 30000ms exceeded.` in `error` so this
   * client's regular expression could find it (W2-b), and this client matched it (W2-a); neither side
   * knew the other had moved. Playwright's words decide nothing here any more, whatever they say.
   */
  test("Playwright's first line without a code is not a timeout", async () => {
    const worded = clientWith(
      () =>
        new Response(
          JSON.stringify({
            error:
              'goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "https://www.bizinfo.go.kr/", waiting until "domcontentloaded"\n',
          }),
          { status: 504, headers: { "content-type": "application/json" } },
        ),
    );
    const failure = await worded
      .navigate("https://www.bizinfo.go.kr/")
      .catch((error: Error) => error);
    expect(failure).not.toBeInstanceOf(PageLoadTimeoutError);
    expect((failure as Error).message).toBe("laf:computer_failed");
  });

  test("the computer's own code for a timeout decides it, whatever the words beside it", async () => {
    const said = clientWith(
      () =>
        new Response(
          JSON.stringify({
            error: "Navigation did not finish.",
            code: "laf:page_timeout",
            recycled: "tab",
          }),
          { status: 504, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(said.navigate("https://slow.example/")).rejects.toBeInstanceOf(
      PageLoadTimeoutError,
    );
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

  /**
   * AND IT IS A NAME, NOT A PATH.
   *
   * The far side joins this header onto `/profiles` — the profile Chrome opens, the `control.json`
   * written on every handover, the tree `/computers/reset` deletes. Nothing between a route and the
   * wire looked at it, and Hono decodes `%2F` in a path parameter, so an address of
   * `..%2F..%2Ftmp%2Fx` reached this file as `../../tmp/x` and went out on the header as-is.
   *
   * Refused HERE, in the one file that invents the header, so a caller that is not a route — the
   * runner's toolkit, an account deletion, whatever is wired up next — cannot send one either.
   */
  test("a Bot id that is a path never reaches the wire", async () => {
    const { client, sent } = recording();

    for (const id of [
      "../../tmp/x",
      "..",
      "a/b",
      "a\\b",
      ".ssh",
      "bot 7",
      "bot\n7",
      "%2e%2e",
      "",
    ]) {
      // Every method goes through one `call`, so one of them proves the door: what matters is that
      // the request was never dispatched at all.
      await expect(client.forBot(id).snapshot()).rejects.toThrow(
        "laf:bot_id_invalid",
      );
    }

    expect(sent).toEqual([]);
  });

  test("the ids this product actually mints still go through", async () => {
    // The refusal is worth nothing if it also refuses `agent_<uuid>`, which is every Bot anybody
    // creates, or the plain names the tests and the health probe use.
    const { client, sent } = recording();

    for (const id of [
      "agent_2f1c9a3e-7d24-4a6b-9b1e-0c8f5d2a7b41",
      "bot-7",
      "health",
      "a",
    ]) {
      await client.forBot(id).snapshot();
    }

    expect(sent.map((call) => call.botId)).toEqual([
      "agent_2f1c9a3e-7d24-4a6b-9b1e-0c8f5d2a7b41",
      "bot-7",
      "health",
      "a",
    ]);
  });
});

/**
 * A COMPUTER REPLACED UNDER A RUNNING SERVER.
 *
 * W2-g (2026-09-14): `docker rm -f` and `docker run` on the same port, and the next four calls through
 * the running server each waited out the 45 s deadline, while `lsof` showed the server holding a socket
 * to the port that Docker's forwarder still held open. Four calls, four keep-alive sockets: fetch
 * writes a request into a pooled socket whose far end will never answer, waits for the whole deadline,
 * and only then lets the socket go.
 *
 * Reproduced here with real sockets and no Docker: a "computer" that answers the first request on a
 * connection and then stops answering on it without closing it — which is what a connection left open
 * by a forwarder looks like from this side — and a replacement listening on the same port.
 */
describe("a computer replaced under a running server", () => {
  const BODY = JSON.stringify({ status: "ok" });
  const ANSWER = `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${BODY.length}\r\nconnection: keep-alive\r\n\r\n${BODY}`;

  /**
   * A listener that answers each new connection's first request and is silent on it afterwards —
   * and, once `retire` is called, stops listening and is silent on everything it accepted, without
   * closing any of it.
   */
  function computerOnPort(port = 0) {
    let retired = false;
    let accepted = 0;
    const listener = Bun.listen<{ answered: boolean }>({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          accepted += 1;
          socket.data = { answered: false };
        },
        data(socket, chunk) {
          if (!String(chunk).includes("\r\n\r\n")) return;
          if (retired || socket.data.answered) return;
          socket.data.answered = true;
          socket.write(ANSWER);
        },
      },
    });
    return {
      port: listener.port,
      accepted: () => accepted,
      retire: () => {
        retired = true;
        listener.stop(false);
      },
      stop: () => listener.stop(true),
    };
  }

  const timedStatus = async (
    client: ReturnType<typeof createComputerClient>,
  ) => {
    const started = Date.now();
    const status = await client.status("bot-1");
    return { ...status, ms: Date.now() - started };
  };

  test("a connection its peer stopped answering does not hold the next call to the deadline", async () => {
    const computer = computerOnPort();
    const client = createComputerClient({
      baseUrl: `http://127.0.0.1:${computer.port}`,
      timeoutMs: 1_500,
    });
    try {
      const calls = [];
      for (let n = 0; n < 3; n += 1) calls.push(await timedStatus(client));
      // Pooled, the second call went out on the first call's socket and came back
      // `laf:computer_timed_out` at the deadline — 1.5 s here, 45 s through the running server.
      expect(calls.map((call) => call.state)).toEqual([
        "ready",
        "ready",
        "ready",
      ]);
      expect(Math.max(...calls.map((call) => call.ms))).toBeLessThan(750);
      // One connection per call: nothing is reused, so nothing can be reused dead.
      expect(computer.accepted()).toBe(3);
    } finally {
      computer.stop();
    }
  });

  test("the first call after the swap is refused at once or answered, and none waits out the deadline", async () => {
    const old = computerOnPort();
    const client = createComputerClient({
      baseUrl: `http://127.0.0.1:${old.port}`,
      timeoutMs: 1_500,
    });
    // Four calls at once leave four connections behind, as the server's four did.
    const warm = await Promise.all([1, 2, 3, 4].map(() => timedStatus(client)));
    expect(warm.map((call) => call.state)).toEqual([
      "ready",
      "ready",
      "ready",
      "ready",
    ]);

    // The old computer goes, leaving what it accepted open, and nothing listens yet.
    old.retire();
    const between = await timedStatus(client);
    // Refused at once, as the fact that nothing is there — never the deadline's fact.
    expect(between).toMatchObject({
      state: "unreachable",
      reason: "laf:computer_unreachable",
    });
    expect(between.ms).toBeLessThan(750);

    // The new computer, on the same port.
    const replacement = computerOnPort(old.port);
    try {
      const after = [];
      for (let n = 0; n < 4; n += 1) after.push(await timedStatus(client));
      expect(after.map((call) => call.state)).toEqual([
        "ready",
        "ready",
        "ready",
        "ready",
      ]);
      expect(Math.max(...after.map((call) => call.ms))).toBeLessThan(750);
    } finally {
      replacement.stop();
      old.stop();
    }
  });

  test("every call keeps out of the pool, whatever else is in the request", async () => {
    const seen: RequestInit[] = [];
    const client = clientWith((_url, init) => {
      if (init) seen.push(init);
      return ok({ computers: [] });
    });
    await client.computers();
    await client.forBot("bot-1").snapshot();
    expect(seen.map((init) => init.keepalive)).toEqual([false, false]);
  });
});
