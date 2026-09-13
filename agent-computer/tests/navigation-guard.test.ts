import { describe, expect, test } from "bun:test";
import { hopVerdict, hostnameOf } from "../src/navigation-guard";

/**
 * The decisions under the navigation guard, without a browser.
 *
 * `browser-boundaries.test.ts` drives it through Chromium; these pin the rules those runs depend on
 * and that a browser run would only show as a flaky miss: which documents the floor judges at all.
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
