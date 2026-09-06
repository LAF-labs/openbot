import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCREEN_PROBLEM_SAID,
  SCREEN_UNAVAILABLE,
  SCREEN_UNREACHABLE,
  screenProblemText,
} from "../src/lib/computer/screen-problems";
import { ko } from "../src/lib/i18n-ko";

/**
 * The words the screen pane has for not being able to show the screen.
 *
 * MEASURED 2026-09-06: the pane printed "The assistant's computer did not respond in time." and,
 * once, a Playwright call log — the server's `error` body and the container's socket `error`,
 * shown as they came under a Korean heading. Both send a fact code now, and the sentence is made
 * in one table the pane reads through `t(variable)`, which `i18n-coverage.test.ts` cannot see.
 * So the table is walked here, the way the presets and the tool-result codes are.
 */

const COMPONENTS = join(import.meta.dir, "../src/components");

/**
 * Every code the two senders can put in front of this table.
 *
 * Listed here, by hand, against the server (`codeFor` in `server/src/computer/routes.ts`) and the
 * container's `{type:"error"}` socket messages: a code dropped from the table would otherwise
 * fall to the generic line and nothing would say so.
 */
const SENT_BY_THE_SERVER = [
  "laf:bot_id_invalid",
  "laf:page_timeout",
  "laf:human_has_control",
  "laf:computer_unavailable",
  "laf:snapshot_stale",
  "laf:computer_failed",
];
const SENT_BY_THE_COMPUTER = [
  "laf:screen_not_started",
  "laf:take_control_first",
  "laf:input_not_applied",
];

const GENERIC = "The screen is not available right now.";

describe("what the screen pane says", () => {
  test("every code has a sentence, and every sentence has Korean", () => {
    expect(Object.keys(SCREEN_PROBLEM_SAID).length).toBeGreaterThan(0);
    const missing = Object.entries(SCREEN_PROBLEM_SAID)
      .filter(([, sentence]) => !(sentence in ko))
      .map(([code, sentence]) => `${code}: ${sentence}`);
    expect(missing).toEqual([]);
    expect(GENERIC in ko).toBe(true);
  });

  test("every code either sender can send is in the table", () => {
    const unsaid = [...SENT_BY_THE_SERVER, ...SENT_BY_THE_COMPUTER].filter(
      (code) => !(code in SCREEN_PROBLEM_SAID),
    );
    expect(unsaid).toEqual([]);
    // And the pane's own two, for an answer that carried no code.
    expect(SCREEN_UNAVAILABLE in SCREEN_PROBLEM_SAID).toBe(true);
    expect(SCREEN_UNREACHABLE in SCREEN_PROBLEM_SAID).toBe(true);
  });

  test("a code nobody has words for gets the generic line, never the code", () => {
    // Under test the locale resolves to English, so the sentence is the key itself.
    expect(screenProblemText("laf:something_new")).toBe(GENERIC);
    expect(screenProblemText("")).toBe(GENERIC);
    expect(screenProblemText(null)).toBe(GENERIC);
    expect(screenProblemText(undefined)).toBe(GENERIC);
    // And a sentence arriving where a code should be is not passed through either.
    expect(screenProblemText("The assistant's computer is not running.")).toBe(
      GENERIC,
    );
  });

  test("no reader is ever shown an identifier", () => {
    for (const code of [...Object.keys(SCREEN_PROBLEM_SAID), "laf:unknown"]) {
      const said = screenProblemText(code);
      expect({ code, said: said.startsWith("laf:") }).toEqual({
        code,
        said: false,
      });
      // The Korean for it, read directly, is also a sentence and not a placeholder.
      const korean = ko[SCREEN_PROBLEM_SAID[code] ?? GENERIC];
      expect({ code, korean: korean?.startsWith("laf:") }).toEqual({
        code,
        korean: false,
      });
    }
  });

  test("every sentence is Korean in Korean", () => {
    for (const sentence of [...Object.values(SCREEN_PROBLEM_SAID), GENERIC]) {
      const hangul = [...(ko[sentence] ?? "")].filter((character) =>
        /[가-힣]/.test(character),
      ).length;
      expect({ sentence, hangul: hangul > 3 }).toEqual({
        sentence,
        hangul: true,
      });
    }
  });
});

/**
 * The three places a problem is rendered, held to reading the table.
 *
 * Read from the source rather than rendered, because what was wrong was not a class list: it was
 * `body?.error` in the poll and `message.error` on the socket, each a sentence somebody else wrote,
 * and `{problem}` in JSX printing it. A green render would not have said which of those came back.
 */
describe("the panes read the table, not the wire", () => {
  const view = readFileSync(
    join(COMPONENTS, "computer/computer-view.tsx"),
    "utf8",
  );
  const live = readFileSync(
    join(COMPONENTS, "computer/live-screen.tsx"),
    "utf8",
  );
  const handoff = readFileSync(join(COMPONENTS, "sites/handoff.tsx"), "utf8");

  test("the screenshot poll takes the code and never the server's sentence", () => {
    expect(view).toContain("body?.code");
    expect(view).not.toMatch(/body\??\.error/);
    expect(view).toContain("SCREEN_UNAVAILABLE");
  });

  test("the live socket takes the code and never the container's sentence", () => {
    expect(live).toContain("message.code");
    expect(live).not.toMatch(/message\??\.error/);
    expect(live).toContain("SCREEN_UNREACHABLE");
    // No English literal handed up as a reason: the two this replaced were exactly that.
    expect(live).not.toMatch(/onProblem\?\.\(\s*"/);
  });

  test("wherever a problem is drawn, it is drawn through the table", () => {
    for (const source of [view, handoff]) {
      expect(source).toContain("screenProblemText(problem)");
      expect(source).not.toMatch(/\{problem\}/);
    }
  });
});
