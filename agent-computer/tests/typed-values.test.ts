import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json } from "../src/respond";
import { createSessions } from "../src/sessions";
import {
  digestOf,
  digestOfBlock,
  keepOwn,
  keepOwnAddress,
  keepTyped,
  typedValueTest,
  withoutTyped,
  withoutTypedAddresses,
} from "../src/typed-values";

/**
 * THE ADDRESS RULES, WITHOUT A BROWSER.
 *
 * `takeover-secret.test.ts` drives the real computer through a form sent by GET (audit R3-03); this
 * pins what is done to an address once a value is known to be a person's: which part is blanked,
 * what is left exactly as it was, and what is never touched — including the one thing blanking must
 * never do, which is answer a Bot's guess.
 */

const PIN = "SEC-GETFORM-7788";

function sessionWith(typed: string[] = []) {
  const session = createSessions({
    stateDirectoryFor: (botId) => join(tmpdir(), "laf-typed-values", botId),
  }).sessionFor("typed-values-bot");
  for (const value of typed) keepTyped(session, digestOf(value));
  return session;
}

const blanked = (address: string, typed: string[] = [PIN]) => {
  const isTyped = typedValueTest(sessionWith(typed));
  if (!isTyped) throw new Error("nothing was kept");
  return withoutTyped(address, isTyped);
};

describe("an address carrying what a person typed", () => {
  test("loses the value and keeps the name, and everything nobody typed stays exactly as written", () => {
    expect(
      blanked(`https://shop.example/landed?step=2&pin=${PIN}&q=a%20b+c&flag`),
    ).toBe("https://shop.example/landed?step=2&pin=&q=a%20b+c&flag");
  });

  test("as a form writes it: encoded, with spaces as plus signs", () => {
    const typed = "내 비밀 1234";
    const form = new URLSearchParams({ pin: typed }).toString();
    expect(blanked(`https://shop.example/landed?${form}`, [typed])).toBe(
      "https://shop.example/landed?pin=",
    );
    expect(
      blanked(
        `https://shop.example/landed?pin=${encodeURIComponent("A+B C")}`,
        ["A+B C"],
      ),
    ).toBe("https://shop.example/landed?pin=");
  });

  test("in the fragment too, as a pair or on its own, and in a hash route's query", () => {
    expect(blanked(`https://shop.example/app#code=${PIN}&tab=1`)).toBe(
      "https://shop.example/app#code=&tab=1",
    );
    expect(blanked(`https://shop.example/app#${PIN}`)).toBe(
      "https://shop.example/app#",
    );
    expect(blanked(`https://shop.example/app#/verify?code=${PIN}`)).toBe(
      "https://shop.example/app#/verify?code=",
    );
  });

  test("the path is left alone, and so is anything that is not a web address", () => {
    expect(blanked(`https://shop.example/orders/${PIN}`)).toBe(
      `https://shop.example/orders/${PIN}`,
    );
    for (const text of [PIN, `pin=${PIN}`, `ftp://x/?pin=${PIN}`, ""]) {
      expect(blanked(text)).toBe(text);
    }
    expect(blanked("https://shop.example/landed")).toBe(
      "https://shop.example/landed",
    );
  });

  test("a value is compared as a look compares it: spaces collapsed, the ends trimmed", () => {
    expect(
      blanked(`https://shop.example/l?pin=%20${PIN}%20%20`, [`  ${PIN}`]),
    ).toBe("https://shop.example/l?pin=");
  });

  test("one character is not worth blanking, and a block of fewer than four is not kept", () => {
    const session = sessionWith(["1"]);
    expect(typedValueTest(session)).toBeNull();
    expect(digestOf("12")).toBeDefined();
    // A finished Korean syllable arrives as a block of one; a pasted code is six.
    expect(digestOfBlock("한")).toBeUndefined();
    expect(digestOfBlock("123")).toBeUndefined();
    expect(digestOfBlock("482913")).toBe(digestOf("482913"));
  });

  test("what the Bot itself sent is never blanked, so a guess cannot be checked against a person's value", () => {
    const session = sessionWith([PIN]);
    keepOwnAddress(session, `https://evil.example/?guess=${PIN}`);
    const isTyped = typedValueTest(session);
    expect(isTyped?.(PIN)).toBe(false);
    expect(
      withoutTyped(
        `https://shop.example/l?pin=${PIN}`,
        isTyped ?? (() => true),
      ),
    ).toBe(`https://shop.example/l?pin=${PIN}`);

    const typedTwice = sessionWith(["ALSO-TYPED-5521"]);
    keepOwn(typedTwice, digestOf("ALSO-TYPED-5521"));
    expect(typedValueTest(typedTwice)?.("ALSO-TYPED-5521")).toBe(false);
  });

  test("the session keeps digests, never the value", () => {
    const session = sessionWith([PIN]);
    expect(JSON.stringify(session.typedDigests)).not.toContain(PIN);
    expect(session.typedDigests).toHaveLength(1);
    // Keeping it again does not keep it twice.
    keepTyped(session, digestOf(PIN));
    expect(session.typedDigests).toHaveLength(1);
  });
});

describe("an answer on its way out", () => {
  test("has every address in it blanked, wherever it sits, with its status and code kept", async () => {
    const session = sessionWith([PIN]);
    const landed = `https://shop.example/landed?step=2&pin=${PIN}`;
    const answer = await withoutTypedAddresses(
      session,
      json({
        url: landed,
        tabs: [{ index: 0, title: "접수 완료", url: landed, active: true }],
        frames: [{ url: `${landed}#frame`, chars: 3 }],
        redirect: { to: landed, from: landed, referer: landed },
        text: `the page says ${PIN}`,
      }),
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/json");
    const body = await answer.json();
    const clean = "https://shop.example/landed?step=2&pin=";
    expect(body).toEqual({
      url: clean,
      tabs: [{ index: 0, title: "접수 완료", url: clean, active: true }],
      frames: [{ url: `${clean}#frame`, chars: 3 }],
      redirect: { to: clean, from: clean, referer: clean },
      // Only a whole string that is an address is touched: page text is the page's.
      text: `the page says ${PIN}`,
    });
  });

  test("from a Bot nobody typed for, is the very answer that came in, unread", async () => {
    const answer = json({ url: `https://shop.example/l?pin=${PIN}` });
    expect(await withoutTypedAddresses(sessionWith(), answer)).toBe(answer);
  });

  test("a refusal keeps its status", async () => {
    const refusal = new Response(
      JSON.stringify({ code: "laf:stale_refs", error: "laf:stale_refs" }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
    const answer = await withoutTypedAddresses(sessionWith([PIN]), refusal);
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({
      code: "laf:stale_refs",
      error: "laf:stale_refs",
    });
  });
});
