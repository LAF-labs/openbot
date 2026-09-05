import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ko } from "../src/lib/i18n-ko";
import { clockLabel, hourLabel } from "../src/lib/routines/queries";

/**
 * THE ROUTINE FORM: the order it asks in, the chips that used to do nothing, and one clock.
 *
 * Three findings from the browser, all of them visible on the screen and none of them visible to a
 * green gate:
 *
 * - 루틴 만들기 opened DISABLED, mid-grey, skipped by the tab order, with nothing saying what it
 *   wanted. A disabled primary action is a question with its answer hidden.
 * - Seven day chips sat under 매일 with none lit and no effect on anything.
 * - Three time formats in one product: 매일 07:30 in the form, 평일 09:00 on a row, 오전 1:15 in the
 *   panel beside a conversation.
 *
 * `clockLabel` is a function and is tested as one. The rest is a source walk, because the property
 * that matters is the ORDER of the fields and the CONDITION on the chips — both of which are facts
 * about the file, and both of which a rendering test would have to reconstruct by reading the DOM
 * in the same order anyway.
 */

const ROUTINES = join(
  import.meta.dir,
  "../src/routes/_authed/_app/routines.tsx",
);
const source = readFileSync(ROUTINES, "utf8");

describe("one clock, in the reader's own language", () => {
  test("a wall-clock time is written the way the language writes it", () => {
    // The `activeLocale` under the test runner is English; the Korean side is exercised through the
    // dictionary and in the browser. What matters here is that it is FORMATTED, not printed raw.
    expect(clockLabel("07:30")).not.toBe("07:30");
    expect(clockLabel("07:30")).toMatch(/7:30/);
    expect(clockLabel("19:30")).toMatch(/7:30/);
    expect(clockLabel("00:05")).toMatch(/12:05|0:05/);
  });

  test("an hour on its own is a label too, for the picker", () => {
    expect(hourLabel(7)).toMatch(/7/);
    expect(hourLabel(19)).toMatch(/7/);
  });

  test("a malformed stored time is still shown rather than thrown over", () => {
    /*
     * ONE BAD ROW MUST NOT TAKE THE SCREEN DOWN — the rule `scheduleLabel` already records, after a
     * routine with `daily_days: {}` took the whole page out through an error boundary.
     */
    expect(clockLabel("")).toBe("");
    expect(clockLabel("nonsense")).toBe("nonsense");
    expect(clockLabel("25:00")).toBe("25:00");
    expect(clockLabel("07:99")).toBe("07:99");
  });

  test("the form does not use a native time input, whose format the browser owns", () => {
    // Measured: `<input type="time">` rendered 07:30 AM in a Chrome running in English, directly
    // above this form's own Korean summary. The app renders the hour and the minute itself.
    // The comment recording why is allowed to name it; a JSX prop is not.
    expect(source).not.toContain('<Input\n            type="time"');
    expect(source.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain(
      'type="time"',
    );
  });
});

describe("the fields, in the order the question is asked", () => {
  const at = (needle: string) => source.indexOf(needle);

  test("이름 → 무엇을 → 어느 봇이 → 언제, and the button after all of them", () => {
    const name = at('{t("Name")}</FieldLabel>');
    const what = at('{t("What should it do?")}');
    const which = at('{t("Which Bot")}</FieldLabel>');
    const when = at('{t("When")}</FieldLabel>');
    const submit = at('t("Create routine")');

    expect([name, what, which, when, submit].every((index) => index > 0)).toBe(
      true,
    );
    expect(name).toBeLessThan(what);
    expect(what).toBeLessThan(which);
    expect(which).toBeLessThan(when);
    // The day chips used to be BELOW this, so the last decision was offered after the press that
    // ends the form.
    expect(when).toBeLessThan(submit);
  });

  test("the day chips are inside the 언제 field and above the button", () => {
    expect(at("weekdayNames().map")).toBeGreaterThan(
      at('{t("When")}</FieldLabel>'),
    );
    expect(at("weekdayNames().map")).toBeLessThan(at('t("Create routine")'));
  });
});

describe("the day chips", () => {
  test("are drawn only when 특정 요일 is the repeat", () => {
    // `repeat === "weekly" ? …` is the whole fix: they used to be drawn for every daily routine,
    // with none of them lit, which is a control offered in a state that means nothing.
    const chips = source.indexOf("weekdayNames().map");
    const guard = source.lastIndexOf('repeat === "weekly" ? (', chips);
    expect(guard).toBeGreaterThan(0);
    expect(chips - guard).toBeLessThan(600);
  });

  test("an empty selection under 특정 요일 is refused, with a sentence", () => {
    expect(source).toContain('found.days = t("Pick at least one day.")');
    expect(ko["Pick at least one day."]).toBeTruthy();
  });

  test("every day is still the ABSENCE of a restriction, never an empty list", () => {
    // The server refuses an empty `days` on purpose, so 매일 has to send no `days` key at all.
    expect(source).toContain(
      '...(repeat === "weekly" && days.length > 0 ? { days } : {}),',
    );
  });
});

describe("the button that makes it", () => {
  test("is never disabled for want of a field", () => {
    /*
     * `disabled={create.isPending}` and nothing else. The old `!canCreate ||` is what made the
     * button open grey and unpressable with no way to find out why.
     */
    expect(source).toContain("disabled={create.isPending}");
    expect(source).not.toContain("disabled={!canCreate");
  });

  test("says what is missing, per field, on the press", () => {
    for (const sentence of [
      "Pick a Bot first.",
      "Give the routine a name.",
      "Say what the routine should do each time.",
      "Five minutes is the shortest gap.",
    ]) {
      expect(`${sentence}: ${source.includes(sentence)}`).toBe(
        `${sentence}: true`,
      );
      expect(`${sentence}: ${sentence in ko}`).toBe(`${sentence}: true`);
    }
  });

  test("nothing is red before anybody has pressed anything", () => {
    // `problems` starts empty and is only ever filled by `check()`, which runs in the submit
    // handler. A form that greets you in red has told you off for not having started.
    expect(source).toContain("useState<Problems>({})");
    expect(source).toContain("if (!check()) return;");
  });
});

describe("the row", () => {
  test("shows both timings the server has been sending all along", () => {
    expect(source).toContain('t("Next {when}"');
    expect(source).toContain('t("Last {when}"');
    expect(source).toContain('t("Not run yet")');
  });

  test("names its switch for the routine, not for a state it may not be in", () => {
    // It read "'재고 확인' 켜짐" whether it was on or off.
    expect(source).toContain('t("Scheduled runs for {name}"');
    expect(source).not.toContain('t("{name} is on"');
  });

  test("keeps the destructive verb behind the ⋯ menu", () => {
    const menu = source.indexOf('<DropdownMenuContent align="end">');
    const del = source.indexOf('variant="destructive"', menu);
    expect(menu).toBeGreaterThan(0);
    expect(del - menu).toBeLessThan(400);
    // And no bare trash icon beside the switch any more.
    expect(source).not.toContain("IconTrash");
  });

  test("answers 지금 실행 while it is running", () => {
    expect(source).toContain('t("Running now…")');
    expect(source).toContain('t("Started. The answer lands below.")');
  });
});
