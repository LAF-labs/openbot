import { describe, expect, test } from "bun:test";
import { siteOf } from "../src/screencast";

/**
 * WHAT A CAST FRAME SAYS ABOUT ITS PAGE: THE HOST, OR THAT THERE IS NO PAGE, AND NOTHING ELSE.
 *
 * The live view closes on "no page" rather than draw a white box, and names the site above the
 * picture. The frames go out over a socket that does not pass the filter every HTTP answer passes on
 * its way out (`typed-values.ts`), so the one thing this must never do is carry a path or a query: a
 * form sent by GET puts what a person typed there.
 */
describe("the site a frame names", () => {
  test("a browser sent nowhere has no site", () => {
    expect(siteOf("about:blank")).toBeNull();
    expect(siteOf("")).toBeNull();
    expect(siteOf("   ")).toBeNull();
  });

  test("a page is its host, port included, and nothing after it", () => {
    expect(siteOf("https://weather.naver.com/today?where=seoul")).toBe(
      "weather.naver.com",
    );
    expect(siteOf("http://localhost:3000/login")).toBe("localhost:3000");
  });

  test("what a person typed into a form sent by GET never leaves in it", () => {
    const site = siteOf(
      "https://shop.example/search?password=hunter2&q=%EB%B9%84%EB%B0%80#pin=4321",
    );
    expect(site).toBe("shop.example");
    expect(site).not.toContain("hunter2");
    expect(site).not.toContain("4321");
  });

  test("a browser's own page is a page, named by its scheme", () => {
    expect(siteOf("chrome-error://chromewebdata/")).toBe("chromewebdata");
    expect(siteOf("data:text/html,<p>hi</p>")).toBe("data");
  });

  test("something that is not an address is not a page", () => {
    expect(siteOf("not a url")).toBeNull();
  });
});
