import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { refusalText } from "../src/components/plugins/connections";
import { ko } from "../src/lib/i18n-ko";
import {
  beginConnect,
  ConnectRefusedError,
  connectionsQueryOptions,
} from "../src/lib/plugins/queries";
import { stubFetch } from "./support/fetch";

/**
 * The 연결 card: what the press actually sends, and what the person is told when it comes back no.
 *
 * WHY THIS IS A WIRE TEST AND NOT A RENDERED ONE. The only thing the mall-id field does is put a
 * string in the body of one request, and the only thing the server does with an absent one is
 * refuse — so the failure worth catching is the field being drawn and its value going nowhere,
 * which is exactly what a rendered assertion about an `<input>` existing would NOT catch. The card
 * draws the field from `needsInstanceHost`, which the server decides and
 * `server/tests/plugin-relay-connect.test.ts` pins to Cafe24 alone.
 *
 * The refusal half is here for the same reason. A 400 from this endpoint means the shop name was
 * wrong, and that is the one refusal on this screen the person can act on themselves; sending them
 * the generic "try again" in front of it is how a typo looks like a broken button.
 */

let asked: { url: string; method: string; body: unknown }[] = [];
let realFetch: typeof fetch;
let reply: () => Response = () => new Response("{}", { status: 200 });

beforeEach(() => {
  asked = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(async (url, init) => {
    asked.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return reply();
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  reply = () => new Response("{}", { status: 200 });
});

const consented = () =>
  new Response(JSON.stringify({ authorizationUrl: "https://vendor/consent" }), {
    status: 200,
  });

describe("pressing 연결", () => {
  test("a per-instance vendor sends the shop name the person typed", async () => {
    reply = consented;

    const url = await beginConnect("cafe24", "settings", "sunnymart");

    expect(url).toBe("https://vendor/consent");
    expect(asked[0]?.url).toBe(
      "/api/plugins/servers/cafe24/connect?returnTo=settings",
    );
    expect(asked[0]?.method).toBe("POST");
    expect(asked[0]?.body).toEqual({ instanceName: "sunnymart" });
  });

  test("every other vendor sends no name at all, rather than an empty one", async () => {
    reply = consented;

    await beginConnect("google-sheets", "settings");

    // An empty string is a value; the server trims and refuses it for an entry that needs one, and
    // for one that does not it would be a field with nothing behind it.
    expect(asked[0]?.body).toEqual({});
  });

  test("a refusal carries the status, because three of them mean different things", async () => {
    reply = () =>
      new Response(JSON.stringify({ error: "no", code: "x" }), { status: 400 });

    const thrown = await beginConnect("cafe24", "settings", "nope").catch(
      (error: Error) => error,
    );

    expect(thrown).toBeInstanceOf(ConnectRefusedError);
    expect((thrown as ConnectRefusedError).status).toBe(400);
  });
});

describe("what the card says when it did not work", () => {
  const sentenceFor = (status: number) =>
    refusalText(new ConnectRefusedError("server prose", status));

  test("a bad shop name points at the shop, not at an administrator", () => {
    // Under a test runner there is no browser and no `navigator`, so `t()` resolves to English and
    // hands back its own key. Which key it chose is the assertion; that the key has Korean is the
    // second half, and together they are what `i18n-coverage.test.ts` cannot see from a literal.
    expect(sentenceFor(400)).toBe("Check the shop ID and try again.");
    expect(sentenceFor(400) in ko).toBe(true);
  });

  test("the three older refusals still say their own thing", () => {
    // Each of these is a genuinely different situation, and the whole reason the status travels.
    const said = [400, 409, 502, 503].map(sentenceFor);
    expect(new Set(said).size).toBe(4);
  });

  test("anything else is the generic one, and never the server's English", () => {
    const said = refusalText(new Error("A vendor refused this deployment."));
    expect(said).toBe("The connection could not be started. Please try again.");
    expect(said in ko).toBe(true);
    // Server prose does not cross to the surface: the status is the fact, the words are ours.
    expect(said).not.toContain("vendor");
  });
});

describe("the connections query", () => {
  test("re-asks when the window comes back, because the consent finishes elsewhere", () => {
    // In the desktop shell the consent happens in the person's own browser, and the only signal
    // this window gets that it is over is the person returning to it. Without this the card keeps
    // offering 연결 to somebody who has just connected.
    expect(connectionsQueryOptions().refetchOnWindowFocus).toBe(true);
  });
});
