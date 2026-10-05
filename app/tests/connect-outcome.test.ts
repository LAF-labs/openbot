import { afterEach, describe, expect, test } from "bun:test";
import { ko } from "../src/lib/i18n-ko";
import { beginConnect, connectFailureText } from "../src/lib/plugins/queries";

/**
 * Two small decisions the connection layer makes on this side, both of which were wrong.
 *
 * A CONSENT IN THE SHELL. The shell hands the screen to the person's own browser, which has no
 * session for this app, so the callback's ordinary redirect bounced to `/sign` over a connection
 * that had worked. The third name says so before the flow starts.
 *
 * A FAILURE WITH A REASON. `?connected=failed` was one word for five situations with five different
 * next moves.
 */

type WindowWithTauri = typeof globalThis & { __TAURI__?: unknown };

const realFetch = globalThis.fetch;

/** One reply, to whatever is asked next, with the request recorded. */
function answering(status: number, body: unknown) {
  const asked: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    asked.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return asked;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as WindowWithTauri).__TAURI__ = undefined;
});

describe("where a consent is told to come back to", () => {
  test("a browser tab keeps the name the caller chose", async () => {
    const asked = answering(200, { authorizationUrl: "https://vendor/auth" });

    await beginConnect("google-sheets", "settings");

    expect(asked[0]).toContain("returnTo=settings");
  });

  test("the shell asks for its own page instead, whichever screen started it", async () => {
    (globalThis as WindowWithTauri).__TAURI__ = { core: {} };
    const asked = answering(200, { authorizationUrl: "https://vendor/auth" });

    await beginConnect("google-sheets", "settings");
    await beginConnect("google-sheets", "admin");

    // Both, because the destination is about the BROWSER the person is holding rather than the
    // screen they left: the admin page in the shell has exactly the same problem.
    expect(asked.every((url) => url.includes("returnTo=shell"))).toBe(true);
  });
});

describe("what a failed connect is told to say", () => {
  /*
   * Five words with five different next moves, where there used to be one sentence. The keys are
   * the server's — `connected-page.ts` and the branches in `plugins/routes.ts` — and the words are
   * the surface's, which is the arrangement everywhere else in this fork.
   */
  test("every reason the callback can send has its own Korean", () => {
    const said = ["expired", "reused", "denied", "exchange", "mismatch"].map(
      connectFailureText,
    );

    expect(new Set(said).size).toBe(said.length);
    for (const sentence of said) {
      expect({ sentence, korean: sentence in ko }).toEqual({
        sentence,
        korean: true,
      });
    }
  });

  test("a reason this build does not know still says something true", () => {
    // An older server, or a URL somebody typed. The fallback is the sentence that is true of all
    // five rather than nothing at all.
    for (const unknown of ["", null, undefined, "something-else"]) {
      expect(connectFailureText(unknown)).toBe(
        connectFailureText("no-such-reason"),
      );
    }
    expect(connectFailureText(null) in ko).toBe(true);
  });

  test("declining is not phrased as a failure", () => {
    // Nobody did anything wrong, and "연결하지 못했습니다" in front of a person who pressed 취소
    // reads as the product being broken.
    expect(ko[connectFailureText("denied")]).toBe("연결이 취소됐어요.");
  });
});

describe("opening a site's login page", () => {
  /*
   * MEASURED 2026-09-25: the window closed on the login overlay without 다 했어요, the person kept
   * the wheel, and every later 연결 said "허락을 받아야 이 페이지가 열립니다" — a question nobody had
   * asked. The computer said which it was all along; this read the status and not the code.
   */
  test("a person holding the browser is told apart from a question waiting", async () => {
    const { openSite } = await import("../src/lib/sites/queries");
    answering(409, {
      error: "laf:human_has_control",
      code: "laf:human_has_control",
    });
    expect(await openSite("agent_1", "https://ceo.baemin.com")).toEqual({
      ok: false,
      kind: "held",
    });
    answering(409, { code: "laf:approval_pending" });
    expect(await openSite("agent_1", "https://ceo.baemin.com")).toEqual({
      ok: false,
      kind: "awaiting",
    });
  });
});
