import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  JOB_PAGES,
  QUIET_PAGES,
  SETTLEMENT_CSV_BODY,
  SETTLEMENT_CSV_NAME,
  serveFixture,
} from "./fixture-site";

/**
 * The job pages, served — without a browser.
 *
 * `korean-sites.test.ts` drives the real computer over the ONE page that carries every browser
 * trap. The job pages are files, and a file can go missing or be renamed without any test noticing
 * until a Bot reads "없는 페이지" and reports the site as down. This walks the list the fixture
 * server exports, at the addresses the launch-plan measurement opens, and checks the quiet-morning
 * switch swaps only the pages that have a quiet sibling.
 */

let fixture: ReturnType<typeof serveFixture>;

beforeAll(() => {
  fixture = serveFixture();
});

afterAll(() => {
  fixture.stop();
});

const page = async (name: string) => {
  const response = await fetch(`${fixture.url}sites/${name}`);
  return { status: response.status, html: await response.text() };
};

describe("the job pages under /sites", () => {
  test("every listed page is on disk", () => {
    expect(fixture.missingPages()).toEqual([]);
  });

  test("each page answers as a Korean HTML document with its own title", async () => {
    for (const name of JOB_PAGES) {
      const served = await page(name);
      expect(served.status).toBe(200);
      expect(served.html).toContain('<html lang="ko">');
      expect(served.html).toMatch(/<title>[^<]+<\/title>/);
    }
  });

  test("a name that is not on the list is a 404, not the site being down", async () => {
    const served = await page("smartstore-nothing");
    expect(served.status).toBe(404);
  });

  test("the quiet morning swaps the pages that have one and leaves the rest alone", async () => {
    const before = await page("smartstore-orders");
    expect(before.html).toContain("신규주문 2");

    fixture.setQuiet(true);
    const quiet = await page("smartstore-orders");
    expect(quiet.html).toContain("신규주문 0");
    expect(quiet.html).not.toContain("2026090612345");

    // No `-quiet` sibling: the same page on both mornings.
    expect(QUIET_PAGES).not.toContain("smartstore-stock");
    const stock = await page("smartstore-stock");
    expect(stock.status).toBe(200);
    expect(stock.html).toContain("품절 1");

    fixture.setQuiet(false);
    const back = await page("smartstore-orders");
    expect(back.html).toContain("신규주문 2");
  });

  test("the quiet switch can be flipped over HTTP by a driver in another process", async () => {
    const on = await fetch(`${fixture.url}__quiet?on=1`);
    expect(await on.json()).toEqual({ quiet: true });
    expect((await page("smartplace-reviews")).html).toContain("답글 미작성 0");

    const off = await fetch(`${fixture.url}__quiet?on=0`);
    expect(await off.json()).toEqual({ quiet: false });
    expect((await page("smartplace-reviews")).html).toContain("답글 미작성 3");
  });

  test("엑셀 다운로드 hands over the settlement CSV with its Korean filename", async () => {
    const response = await fetch(`${fixture.url}downloads/settlement.csv`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    // RFC 5987, the way a real site sends a Korean filename.
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent(SETTLEMENT_CSV_NAME)}`,
    );
    expect(await response.text()).toBe(SETTLEMENT_CSV_BODY);
  });
});
