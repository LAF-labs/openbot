import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PARTNER_CARD_IDS,
  partnerRefusalText,
} from "../src/components/partners/partner-connections";
import { ko } from "../src/lib/i18n-ko";
import {
  confirmAlimtalkCode,
  disconnectPartner,
  partnersQueryOptions,
  requestAlimtalkCode,
} from "../src/lib/partners/queries";
import { stubFetch } from "./support/fetch";

/**
 * The 알림톡 card: what a press actually sends, and what a person is told when it comes back no.
 *
 * WHY THIS IS A WIRE TEST AND NOT A RENDERED ONE, the same reason `connect-card.test.ts` is. The
 * only thing every field on this card does is put a string in the body of one request, so the
 * failure worth catching is a field that is drawn and whose value goes nowhere — which an assertion
 * that an `<input>` exists would not catch.
 *
 * AND THE REFUSALS ARE HALF THE FEATURE. Every one of these comes back as a `laf:` code, because
 * the server sends facts and this surface owns the words. A code with no Korean behind it renders
 * as "그게 잘 되지 않았습니다" for something the person could have fixed in five seconds, so the
 * mapping is walked rather than trusted.
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

describe("what the cards ask for", () => {
  test("a deployment with no partner routes is an empty list, not a red line", async () => {
    reply = () => new Response("", { status: 404 });
    const cards = await partnersQueryOptions().queryFn?.({} as never);
    // A machine set up without either account genuinely has no partner services. An error here
    // would draw a failure across somebody's settings screen for a correct deployment.
    expect(cards).toEqual([]);
  });

  test("a real failure still throws, so a broken deployment is not an empty one", async () => {
    reply = () => new Response("", { status: 500 });
    await expect(
      partnersQueryOptions().queryFn?.({} as never),
    ).rejects.toThrow();
  });

  test("the code request carries the channel id and the manager's phone, and nothing else", async () => {
    reply = () => new Response(JSON.stringify({ searchId: "@미소상회" }));
    await requestAlimtalkCode("@미소상회", "010-5555-4444");

    expect(asked[0]?.url).toBe("/api/partners/kakao-alimtalk/code");
    expect(asked[0]?.method).toBe("POST");
    expect(asked[0]?.body).toEqual({
      searchId: "@미소상회",
      phone: "010-5555-4444",
    });
  });

  test("the connect carries the code back with what it was asked for", async () => {
    reply = () => new Response(JSON.stringify({ status: { connected: true } }));
    await confirmAlimtalkCode("@미소상회", "01055554444", "778899");

    expect(asked[0]?.url).toBe("/api/partners/kakao-alimtalk/connect");
    expect(asked[0]?.body).toEqual({
      searchId: "@미소상회",
      phone: "01055554444",
      code: "778899",
    });
  });

  test("a disconnect names the provider in the path and sends no body of its own", async () => {
    reply = () => new Response(JSON.stringify({ disconnected: true }));
    for (const id of PARTNER_CARD_IDS) {
      await disconnectPartner(id);
    }
    expect(asked.map((call) => call.url)).toEqual([
      "/api/partners/kakao-alimtalk/disconnect",
    ]);
  });
});

describe("what a person is told when it comes back no", () => {
  test("a refusal carries the server's fact and nothing of its prose", async () => {
    reply = () =>
      new Response(JSON.stringify({ code: "laf:alimtalk_code_refused" }), {
        status: 400,
      });
    const outcome = await confirmAlimtalkCode("@가게", "01055554444", "000000");
    expect(outcome).toEqual({ ok: false, code: "laf:alimtalk_code_refused" });
  });

  test("a server that answered nothing at all is still a code", async () => {
    reply = () => new Response("not json", { status: 502 });
    const outcome = await requestAlimtalkCode("@가게", "01055554444");
    expect(outcome).toEqual({ ok: false, code: "laf:partner_unreachable" });
  });

  test("every fact the server can send has Korean behind it", () => {
    /*
     * WALKED RATHER THAN TRUSTED. These reach `t()` through a table lookup, which
     * `i18n-coverage.test.ts` cannot see — the same blind spot the presets and the catalogue copy
     * have. A code the server sends and this screen has no words for renders as the general line,
     * which is how a typo somebody could fix in five seconds looks like a broken button.
     *
     * The list is the server's own vocabulary for this connector, kept here rather than imported so
     * that a code REMOVED on the server does not silently stop being covered.
     */
    const codes = [
      "laf:alimtalk_search_id_invalid",
      "laf:alimtalk_phone_invalid",
      "laf:alimtalk_code_invalid",
      "laf:alimtalk_code_refused",
      "laf:alimtalk_not_connected",
      "laf:kakao-alimtalk_not_configured",
      "laf:alimtalk_vendor_failed",
      "laf:partner_unreachable",
      "laf:partner_unknown",
    ];

    for (const code of codes) {
      const said = partnerRefusalText(code);
      expect(said).not.toBe("");
      /*
       * Asserted against the dictionary's KEYS, not its values. `t()` answers with the English
       * under a test runner — there is no navigator and the locale resolves to `en` — so a check
       * that the returned string is Korean would pass on nothing and fail on everything. The real
       * property is that the sentence this screen chose has a Korean entry waiting for it.
       */
      expect(said in ko).toBe(true);
    }
  });

  test("the three that are not the person's fault are said differently", () => {
    const notHere = partnerRefusalText("laf:kakao-alimtalk_not_configured");
    const vendor = partnerRefusalText("laf:alimtalk_vendor_failed");
    const theirTypo = partnerRefusalText("laf:alimtalk_phone_invalid");

    // "이 서비스는 아직 준비되지 않았습니다" in front of a typo, or "다시 확인해 주세요" in front of
    // a machine that was never given the account, is how a working feature looks broken and a
    // missing one looks like the person's mistake.
    expect(notHere).not.toBe(vendor);
    expect(vendor).not.toBe(theirTypo);
    expect(theirTypo).not.toBe(notHere);
  });
});
