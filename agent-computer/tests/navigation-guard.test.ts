import { describe, expect, test } from "bun:test";
import { judgedLabelOf, nameToMatch } from "../src/label-hold";
import { hopVerdict, hostnameOf } from "../src/navigation-guard";

/**
 * The decisions under the two browser boundaries, without a browser.
 *
 * `browser-boundaries.test.ts` drives them through Chromium; these pin the rules those runs depend on
 * and that a browser run would only show as a flaky miss: which documents the floor judges at all,
 * and which name the role engine is asked for.
 */

describe("the floor, per hop", () => {
  test("a document made inside the browser contacts nobody, and passes", () => {
    for (const url of [
      "about:blank",
      "about:srcdoc",
      "chrome-error://chromewebdata/",
      "data:text/html,<h1>x</h1>",
      "blob:https://shop.example/7c1e0f5a-5d1b-4a8e-9a53-2d4f7b3c6e01",
    ]) {
      expect([url, hopVerdict(url, false).allowed]).toEqual([url, true]);
    }
  });

  test("an address with a host is the server's floor, opt-in and all", () => {
    expect(hopVerdict("https://bit.ly/3xYz", false).allowed).toBe(true);
    expect(hopVerdict("http://127.0.0.1:4100/health", false).allowed).toBe(
      false,
    );
    expect(hopVerdict("http://127.0.0.1:4100/health", true).allowed).toBe(true);
    expect(hopVerdict("http://agent-computer:4100/", false).allowed).toBe(
      false,
    );
    // The metadata endpoint is refused whatever a deployment opted into.
    expect(hopVerdict("http://169.254.169.254/", true).allowed).toBe(false);
    expect(hopVerdict("http://metadata.google.internal./", true).allowed).toBe(
      false,
    );
  });

  test("this container's own disk is not a web address", () => {
    expect(hopVerdict("file:///profiles/other-bot/Cookies", true).allowed).toBe(
      false,
    );
  });

  test("hosts compare the way the floor normalises them", () => {
    expect(hostnameOf("https://WWW.Coupang.com./x")).toBe("www.coupang.com");
    expect(hostnameOf("not a url")).toBe("");
  });
});

describe("the name a control is held to", () => {
  test("is the judged name exactly, in the ordinary case", () => {
    expect(nameToMatch("결제하기")).toBe("결제하기");
    expect(nameToMatch('say "hi"')).toBe('say "hi"');
  });

  test("is a prefix when the server may have cut it", () => {
    const judged = `${"가".repeat(190)}(1+1)[a]?.`;
    expect(judged.length).toBe(200);
    const pattern = nameToMatch(judged);
    expect(pattern).toBeInstanceOf(RegExp);
    expect((pattern as RegExp).test(`${judged} 그리고 더 긴 이름`)).toBe(true);
    // Regex characters in a label are the label's, not the pattern's.
    expect((pattern as RegExp).test(`${"가".repeat(190)}11a.`)).toBe(false);
  });

  test("covers only the names a snapshot renders as none, when none was judged", () => {
    const pattern = nameToMatch("") as RegExp;
    expect(pattern.test("")).toBe(true);
    expect(pattern.test("/api/")).toBe(true);
    expect(pattern.test("x".repeat(901))).toBe(true);
    // An unnamed icon that grew a money word is not the control that was judged.
    expect(pattern.test("결제하기")).toBe(false);
  });

  test("is nothing at all when the caller judged nothing usable", () => {
    expect(judgedLabelOf(undefined)).toBeNull();
    expect(judgedLabelOf({ role: "", name: "저장" })).toBeNull();
    expect(judgedLabelOf({ role: "button", name: 3 })).toBeNull();
    expect(judgedLabelOf({ role: "button", name: "" })).toEqual({
      role: "button",
      name: "",
    });
  });
});
