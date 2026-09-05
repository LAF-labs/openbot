import { describe, expect, test } from "bun:test";
import { ko } from "../src/lib/i18n-ko";
import {
  CATALOGUE_COPY,
  catalogueSummaryKey,
} from "../src/lib/plugins/catalogue-copy";

/**
 * The catalogue copy table is a place `t()` is called on a variable, so `i18n-coverage.test.ts`
 * cannot see it — the same blind spot the presets table has, closed the same way: the table is
 * checked in and finite, so it is simply walked. A vendor summary added without Korean fails HERE
 * rather than rendering an English line on a Korean screen.
 */
describe("the catalogue copy", () => {
  test("every summary in the table has Korean", () => {
    const missing = Object.entries(CATALOGUE_COPY)
      .map(([, copy]) => copy.summary)
      .filter((summary) => !(summary in ko));
    expect(missing).toEqual([]);
  });

  test("every entry says what the Bot can do with it, in Korean", () => {
    /*
     * `can` is what replaced the scope string on the 연결 row. Missing Korean here is not an English
     * line in a corner: it is the one sentence explaining what turning the switch on will let a Bot
     * do, which is the whole basis on which somebody decides to.
     */
    const missing = Object.entries(CATALOGUE_COPY)
      .filter(([, copy]) => !(copy.can in ko))
      .map(([key]) => key);
    expect(missing).toEqual([]);
  });

  test("the table matches what the server actually ships", async () => {
    // The server's catalogue is the source of truth for WHICH keys exist; this table only owns the
    // words. Imported directly rather than duplicated, so a vendor added there fails here until
    // its summary is written — and one removed there is pruned here rather than lingering.
    const { CATALOGUE } = await import("../../server/src/plugins/catalogue");
    const serverKeys = CATALOGUE.map((entry) => entry.key).sort();
    expect(Object.keys(CATALOGUE_COPY).sort()).toEqual(serverKeys);
    // And the English keys are the server's own sentences, so the fallback and the translated
    // path read identically to a deployment that has not translated a new entry yet.
    for (const entry of CATALOGUE) {
      expect(CATALOGUE_COPY[entry.key]?.summary).toBe(entry.summary);
    }
  });

  test("every vendor name the server ships is readable in Korean", async () => {
    /*
     * The 연결 screen draws `t(entry.title)` — `t()` on a variable, invisible to
     * `i18n-coverage.test.ts` for the same reason the summaries are. A brand name is not exempt:
     * "Google Business Profile" on a screen for a shop owner who does not write software is four
     * English words where "구글 비즈니스 프로필" is the thing they have actually seen.
     */
    const { CATALOGUE } = await import("../../server/src/plugins/catalogue");
    const missing = CATALOGUE.map((entry) => entry.title).filter(
      (title) => !(title in ko),
    );
    expect(missing).toEqual([]);
  });

  test("an unknown key falls back to the sentence the server sent", () => {
    expect(catalogueSummaryKey("brand-new-vendor", "What it does.")).toBe(
      "What it does.",
    );
    expect(
      catalogueSummaryKey(
        "notion",
        "Pages and databases of whoever is asking.",
      ),
    ).toBe("Pages and databases of whoever is asking.");
  });
});
