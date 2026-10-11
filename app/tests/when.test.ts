import { describe, expect, test } from "bun:test";
import { activeLocale } from "../src/lib/i18n";
import { dayAndMinute } from "../src/lib/when";

/**
 * THE ONE FORM 만든 것 AND 소식 SAY A TIME IN, pinned to what each said before they shared it: the
 * date and the minute, from `toLocaleString` in the app's own language. Written against the
 * runtime's own clock, as `home-cards.test.ts` pins `cardWhen`, so the test says the same thing on
 * every machine.
 */
describe("the date and the minute", () => {
  const spelled = (at: Date) =>
    at.toLocaleString(activeLocale, {
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  test.each([
    ["a morning this month", new Date(2026, 9, 10, 6, 30)],
    ["an afternoon", new Date(2026, 9, 6, 17, 5)],
    ["midnight", new Date(2026, 0, 1, 0, 0)],
    ["last year", new Date(2025, 11, 31, 23, 59)],
  ])("%s is the date and the minute, as the callers spelled it", (_, at) => {
    const said = dayAndMinute(at.toISOString());
    expect(said).toBe(spelled(at));
    // The date and the time both, and never the year the callers never asked for.
    expect(said).not.toBe("");
    expect(said).not.toContain(String(at.getFullYear()));
  });

  test("nothing for a time that is not one", () => {
    expect(dayAndMinute("")).toBe("");
    expect(dayAndMinute("soon")).toBe("");
  });
});
