import { afterEach, describe, expect, test } from "bun:test";
import { toolResultText } from "../../shared/prompt/tool-results.ko";
import { ko } from "../src/lib/i18n-ko";
import {
  beginConnect,
  callPluginTool,
  connectFailureText,
} from "../src/lib/plugins/queries";

/**
 * Three small decisions the connection layer makes on this side, all of which were wrong.
 *
 * A REFUSAL THE BOT READS. `PluginRefusedError` has carried a `laf:` code beside its sentence since
 * the redesign, and `/api/plugins/call` has been sending it — but this file read `body.error`, so
 * only the refusals whose sentence IS the code were ever translated. Every connection refusal
 * carries the code in `code` and an English placeholder in `error`, which is what a Korean-speaking
 * person's Bot was reading out.
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

/** One reply from `/api/plugins/call`, with the request recorded. */
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

describe("what a refused tool call says to the Bot", () => {
  test("reads the fact code, not the sentence beside it", async () => {
    answering(403, {
      // What the connection layer really sends: the code, and an English placeholder for the words
      // the surface owns.
      code: "laf:not_connected",
      error: "You have not connected your Google Sheets account.",
      rule: null,
    });

    const outcome = await callPluginTool(
      "google-sheets/read_sheet_values",
      {},
      "bot-1",
    );

    expect(outcome).toEqual({
      ok: false,
      refused: true,
      reason: toolResultText("laf:not_connected"),
      rule: null,
    });
    // The English never reaches the Bot, which is the whole regression.
    expect(outcome).not.toMatchObject({
      reason: "You have not connected your Google Sheets account.",
    });
  });

  test("a lapsed connection reaches the Bot as the Korean for reconnecting", async () => {
    answering(403, {
      code: "laf:needs_reconnect",
      error: "Your Google Sheets connection has stopped working.",
      rule: null,
    });

    const outcome = await callPluginTool(
      "google-sheets/read_sheet_values",
      {},
      "bot-1",
    );

    expect(outcome).toMatchObject({
      refused: true,
      reason: toolResultText("laf:needs_reconnect"),
    });
    // And that Korean says the one thing that helps.
    expect((outcome as { reason: string }).reason).toContain("설정 › 연결");
  });

  /*
   * The boundary's own refusals put the code in `error` and send no `code` field, because their
   * message IS the fact. Reading `code` first must not have broken them.
   */
  test("a refusal whose message is the code still works", async () => {
    answering(403, { error: "laf:policy_denied", rule: "deny.write" });

    expect(
      await callPluginTool("google-sheets/append_sheet_row", {}, "bot-1"),
    ).toEqual({
      ok: false,
      refused: true,
      reason: toolResultText("laf:policy_denied"),
      rule: "deny.write",
    });
  });

  /*
   * An English sentence from somewhere upstream is a regression, and it should be visible rather
   * than swallowed into a generic line.
   */
  test("a sentence with no code behind it passes through unchanged", async () => {
    answering(403, { error: "Something upstream wrote this.", rule: null });

    expect(
      await callPluginTool("google-sheets/read_sheet_values", {}, "bot-1"),
    ).toMatchObject({ reason: "Something upstream wrote this." });
  });
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
    expect(ko[connectFailureText("denied")]).toBe("연결이 취소됐습니다.");
  });
});
