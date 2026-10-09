import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  filledBlanker,
  filledTabs,
  forgetFilled,
  HIDDEN,
  holdsFilled,
  patternOf,
  rememberFilled,
  withoutFilledValues,
} from "../src/filled-values";
import { json } from "../src/respond";
import { createSessions } from "../src/sessions";
import { digestOf, keepOwn } from "../src/typed-values";

/**
 * WHAT IS HIDDEN, AND WHAT IT COSTS, WITHOUT A BROWSER.
 *
 * `filled-values-site.test.ts` drives the real computer through a page that shows a value back;
 * this pins the rule itself: how a value is looked for once it may be anywhere in a sentence, what
 * is deliberately left alone — the prices, dates and phone numbers a short number sits inside — and
 * what leaves an answer on its way out.
 */

const PASSWORD = "Tr0ub4dor&3";
const TAB = {} as Page;

let bots = 0;
function sessionWith(values: string[] = []) {
  bots += 1;
  const session = createSessions({
    stateDirectoryFor: (botId) => join(tmpdir(), "laf-filled-values", botId),
  }).sessionFor(`filled-values-bot-${bots}`);
  for (const value of values) rememberFilled(session, TAB, value);
  return session;
}

const hidden = (text: string, values: string[]): string => {
  const blank = filledBlanker(sessionWith(values));
  return blank ? blank(text) : text;
};

describe("a value a page shows back", () => {
  test("is taken out wherever it stands in a sentence, and the sentence stays", () => {
    expect(hidden(`비밀번호 ${PASSWORD} 로 로그인했습니다.`, [PASSWORD])).toBe(
      `비밀번호 ${HIDDEN} 로 로그인했습니다.`,
    );
    expect(hidden(`{"pw":"${PASSWORD}","ok":true}`, [PASSWORD])).toBe(
      `{"pw":"${HIDDEN}","ok":true}`,
    );
    expect(hidden(`${PASSWORD}${PASSWORD}`, [PASSWORD])).toBe(
      `${HIDDEN}${HIDDEN}`,
    );
  });

  test("in whichever case the page writes it, and across whatever white space it breaks it on", () => {
    // A heading styled in capitals reads back in capitals.
    expect(hidden("WELCOME, GIBEOM.KIM", ["gibeom.kim"])).toBe(
      `WELCOME, ${HIDDEN}`,
    );
    expect(hidden("내\n  비밀   문장 입니다", ["내 비밀 문장"])).toBe(
      `${HIDDEN} 입니다`,
    );
  });

  test("with the characters a pattern would read as its own taken as written", () => {
    const odd = "a.b*c(d)[e]{f}|g^h$i+j?k\\l/m-n";
    expect(hidden(`<${odd}>`, [odd])).toBe(`<${HIDDEN}>`);
    // The dot is a dot: another character in its place is another value.
    expect(hidden("gibeomXkim", ["gibeom.kim"])).toBe("gibeomXkim");
  });

  test("the longer of two values first, so the shorter does not leave the other's tail behind", () => {
    expect(hidden("hunter2!! and hunter2", ["hunter2", "hunter2!!"])).toBe(
      `${HIDDEN} and ${HIDDEN}`,
    );
  });
});

describe("a value that is in an address", () => {
  test("is taken out of everything after the site, and the site is left as it is — the gate judges by it", () => {
    expect(
      hidden("https://gibeom.tistory.com:8443/manage/gibeom?u=gibeom#gibeom", [
        "gibeom",
      ]),
    ).toBe(
      `https://gibeom.tistory.com:8443/manage/${HIDDEN}?u=${HIDDEN}#${HIDDEN}`,
    );
    // What is left is still an address the server can read a host from.
    expect(
      new URL(hidden("https://gibeom.tistory.com/gibeom", ["gibeom"])).hostname,
    ).toBe("gibeom.tistory.com");
  });

  test("a name and a password written before the host are not the site", () => {
    expect(
      hidden(`https://gibeom:${PASSWORD}@gibeom.example/home`, [
        "gibeom",
        PASSWORD,
      ]),
    ).toBe(`https://${HIDDEN}:${HIDDEN}@gibeom.example/home`);
  });

  test("an address in a sentence is the page's words, site and all", () => {
    expect(
      hidden("블로그는 https://gibeom.tistory.com 입니다", ["gibeom"]),
    ).toBe(`블로그는 https://${HIDDEN}.tistory.com 입니다`);
  });
});

describe("a value too short to look for in a sentence", () => {
  test("is not looked for: three letters would take ordinary words apart", () => {
    expect(patternOf("kim")).toBeNull();
    expect(patternOf("김밥")).toBeNull();
    expect(hidden("kimchi at kimsclub.example", ["kim"])).toBe(
      "kimchi at kimsclub.example",
    );
  });

  test("from four letters it is, and what that costs is the same letters inside another word", () => {
    expect(hidden("ID: love", ["love"])).toBe(`ID: ${HIDDEN}`);
    expect(hidden("a lovely day", ["love"])).toBe(`a ${HIDDEN}ly day`);
  });

  test("is still a value that was put in: its run keeps no picture and closes its tab", () => {
    const session = sessionWith(["kim"]);
    expect(holdsFilled(session)).toBe(true);
    expect(filledTabs(session)).toEqual([TAB]);
    expect(filledBlanker(session)).toBeNull();
  });
});

describe("a value that is only digits", () => {
  test("is hidden where it is the whole of a number", () => {
    expect(hidden("PIN: 1234", ["1234"])).toBe(`PIN: ${HIDDEN}`);
    expect(hidden("인증번호 123456 확인됨.", ["123456"])).toBe(
      `인증번호 ${HIDDEN} 확인됨.`,
    );
    expect(hidden("12", ["12"])).toBe(HIDDEN);
    expect(hidden("(12)", ["12"])).toBe(`(${HIDDEN})`);
  });

  test("and left alone inside a price, a date, a phone number, an order's number, a word and a ref", () => {
    const page = [
      "12,340원",
      "2026-12-34",
      "010-1234-5678",
      "주문번호 20261234",
      "2026.12.34",
      "12:34",
      "v1234",
      "- textbox [ref=e1234]",
      "1234abc",
    ].join("\n");
    expect(hidden(page, ["1234", "12", "34"])).toBe(page);
  });

  test("one digit is never looked for", () => {
    expect(patternOf("7")).toBeNull();
    expect(hidden("page 7 of 7", ["7"])).toBe("page 7 of 7");
  });

  test("a long one is found with its groups apart, however it was typed, and not inside a longer run", () => {
    const card = "1234567890123456";
    for (const typed of [card, "1234-5678-9012-3456", "1234 5678 9012 3456"]) {
      expect(hidden("카드 1234-5678-9012-3456 로 결제", [typed])).toBe(
        `카드 ${HIDDEN} 로 결제`,
      );
      expect(hidden("카드 1234 5678 9012 3456", [typed])).toBe(
        `카드 ${HIDDEN}`,
      );
      expect(hidden(`카드 ${card}`, [typed])).toBe(`카드 ${HIDDEN}`);
      expect(hidden(`9${card}9`, [typed])).toBe(`9${card}9`);
    }
    expect(hidden("연락처 010-1234-5678", ["01012345678"])).toBe(
      `연락처 ${HIDDEN}`,
    );
  });

  test("a short one with a gap in it is two numbers, and neither is it", () => {
    expect(hidden("1 2 3 4 5", ["12", "1234"])).toBe("1 2 3 4 5");
    expect(hidden("12-34", ["1234"])).toBe("12-34");
  });
});

describe("what the Bot itself typed", () => {
  test("is never hidden, so hiding cannot answer a guess on a page that shows nothing back", () => {
    const session = sessionWith([PASSWORD]);
    expect(filledBlanker(session)?.(`검색어: ${PASSWORD}`)).toBe(
      `검색어: ${HIDDEN}`,
    );
    keepOwn(session, digestOf(PASSWORD));
    expect(filledBlanker(session)).toBeNull();
  });
});

describe("how long a value is held", () => {
  test("until it is let go of, and then nothing about it is left", () => {
    const session = sessionWith([PASSWORD]);
    expect(holdsFilled(session)).toBe(true);
    forgetFilled(session);
    expect(holdsFilled(session)).toBe(false);
    expect(filledTabs(session)).toEqual([]);
    expect(filledBlanker(session)).toBeNull();
  });

  test("a session nothing was put into holds nothing", () => {
    const session = sessionWith();
    expect(holdsFilled(session)).toBe(false);
    expect(filledBlanker(session)).toBeNull();
  });

  test("the session itself, written out whole, has no value in it", () => {
    const session = sessionWith([PASSWORD, "1234567890123456"]);
    const written = JSON.stringify(session);
    expect(written).not.toContain(PASSWORD);
    expect(written).not.toContain("1234567890123456");
  });

  test("the oldest goes when more are held than a run puts in", () => {
    const values = Array.from({ length: 65 }, (_, index) => `value-${index}!`);
    const blank = filledBlanker(sessionWith(values));
    expect(blank?.("value-0! value-1! value-64!")).toBe(
      `value-0! ${HIDDEN} ${HIDDEN}`,
    );
  });
});

describe("an answer on its way out", () => {
  test("has the value taken out of every string in it, and says that something was", async () => {
    const session = sessionWith([PASSWORD]);
    const answer = await withoutFilledValues(
      session,
      json({
        url: `https://shop.example/u/${PASSWORD}/home`,
        title: `${PASSWORD} 님의 주문`,
        text: `환영합니다 ${PASSWORD} 님`,
        elements: [{ ref: "e1", role: "heading", name: `ID ${PASSWORD}` }],
        tabs: [{ index: 0, title: PASSWORD, active: true }],
        notes: [{ code: "laf:dialog", message: `틀렸습니다: ${PASSWORD}` }],
        chars: 42,
        truncated: false,
      }),
    );
    expect(answer.status).toBe(200);
    const text = await answer.text();
    expect(text).not.toContain(PASSWORD);
    expect(JSON.parse(text)).toEqual({
      url: `https://shop.example/u/${HIDDEN}/home`,
      title: `${HIDDEN} 님의 주문`,
      text: `환영합니다 ${HIDDEN} 님`,
      elements: [{ ref: "e1", role: "heading", name: `ID ${HIDDEN}` }],
      tabs: [{ index: 0, title: HIDDEN, active: true }],
      notes: [
        { code: "laf:dialog", message: `틀렸습니다: ${HIDDEN}` },
        { code: "laf:value_hidden" },
      ],
      chars: 42,
      truncated: false,
    });
  });

  test("with nothing of the value in it, goes out as it was and says nothing", async () => {
    const body = { url: "https://shop.example/home", text: "주문 3건" };
    const answer = await withoutFilledValues(
      sessionWith([PASSWORD]),
      json(body),
    );
    expect(await answer.json()).toEqual(body);
  });

  test("from a session that holds nothing, is the very answer that came in, unread", async () => {
    const answer = json({ text: PASSWORD });
    expect(await withoutFilledValues(sessionWith(), answer)).toBe(answer);
  });

  test("a picture's bytes are not read: a short value is in a megabyte of them by chance", async () => {
    const base64 = `AAAA${"love".repeat(3)}BBBB`;
    const answer = await withoutFilledValues(
      sessionWith(["love"]),
      json({ base64, mime: "image/png", url: "https://shop.example/love/" }),
    );
    expect(await answer.json()).toEqual({
      base64,
      mime: "image/png",
      url: `https://shop.example/${HIDDEN}/`,
      notes: [{ code: "laf:value_hidden" }],
    });
  });

  test("a refusal keeps its status, and what is not JSON is not touched", async () => {
    const session = sessionWith([PASSWORD]);
    const refusal = new Response(
      JSON.stringify({ code: "laf:action_failed", detail: PASSWORD }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
    const answer = await withoutFilledValues(session, refusal);
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({
      code: "laf:action_failed",
      detail: HIDDEN,
      notes: [{ code: "laf:value_hidden" }],
    });
    const bytes = new Response(PASSWORD, {
      headers: { "content-type": "application/octet-stream" },
    });
    expect(await withoutFilledValues(session, bytes)).toBe(bytes);
  });
});
