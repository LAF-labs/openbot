/**
 * A TABLE OF SENTENCES IS READ BY ITS OWN KEYS (the second read of #114, 2026-10-06).
 *
 * The app keeps its words in tables and finds them by the code a response, a tool's result or a
 * connected service's answer carries. `TABLE[code]` answers for more names than the table was
 * given — `constructor` with a function — so a code from outside "had a sentence", `t()` handed the
 * function back, and a component was given a function to draw. Twenty-one lookups read that way.
 *
 * Two halves: the words every reader answers a hostile code with, and a walk of `src/` so that the
 * next table indexed bare by a code fails here rather than in somebody's console.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { turnFailureSentence } from "@/lib/channels/turn-failure";
import { refusalSaid } from "@/lib/components/queries";
import { labelForCode } from "@/lib/computer/browsing";
import { fileCardSaid } from "@/lib/computer/files";
import { outcomeLabel } from "@/lib/computer/outcome-labels";
import { screenProblemText } from "@/lib/computer/screen-problems";
import { failureReason } from "@/lib/computer/task-state";
import { t } from "@/lib/i18n";
import { own } from "@/lib/own";
import {
  catalogueCanKey,
  catalogueMark,
  catalogueSummaryKey,
} from "@/lib/plugins/catalogue-copy";
import { refusalText } from "@/lib/refusals";

/** Names every plain object answers to without having been given them. */
const INHERITED = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__proto__",
  "isPrototypeOf",
];

describe("a code from outside finds only what the table was given", () => {
  test("own(): what was put there, and nothing an object merely answers to", () => {
    const table = { "laf:known": "A sentence" };
    expect(own(table, "laf:known")).toBe("A sentence");
    for (const key of [...INHERITED, "laf:unknown", ""]) {
      expect(own(table, key)).toBeUndefined();
    }
    expect(own(table, null)).toBeUndefined();
    expect(own(table, undefined)).toBeUndefined();
    // The hole it closes, said once: the bare index answers with a function.
    expect(typeof (table as Record<string, unknown>).constructor).toBe(
      "function",
    );
  });

  test("every reader answers an inherited name as it answers a code it has never heard of", () => {
    for (const code of INHERITED) {
      // Each is a string or undefined — never a function, which is what a bare index returned.
      expect(outcomeLabel(code)).toBeUndefined();
      expect(failureReason(code)).toBeUndefined();
      expect(labelForCode(code, undefined)).toBeUndefined();
      expect(labelForCode(code, "the server's own line")).toBe(
        "the server's own line",
      );
      expect(refusalText({ "laf:x": "X" }, code, "fallback")).toBe("fallback");
      expect(screenProblemText(code)).toBe(screenProblemText("laf:unheard_of"));
      expect(fileCardSaid(code)).toBe(fileCardSaid("laf:unheard_of"));
      expect(turnFailureSentence(code)).toBe(
        turnFailureSentence("laf:turn_failed"),
      );
      // A reason that is not a `laf:` code is the server's own words and is said as it came.
      expect(refusalSaid(`laf:${code}`)).toBe(refusalSaid("laf:unheard_of"));
      // A connector an administrator named `constructor` gets the plain mark and its own line.
      expect(typeof catalogueMark(code)).toBe("string");
      expect(catalogueMark(code)).toBe(catalogueMark("nobody-has-this-key"));
      expect(catalogueSummaryKey(code, "theirs")).toBe("theirs");
      expect(catalogueCanKey(code, "theirs")).toBe("theirs");
    }
    // And a code the tables do hold is still said.
    expect(outcomeLabel("laf:stopped")).toBe("Stopped");
    expect(failureReason("laf:person_declined")).toBe(t("You said no"));
  });

  test("no table in src/ is indexed bare by a code that arrived from outside", async () => {
    const root = `${import.meta.dir}/../src`;
    /*
     * An UPPER_CASE table (or the generic `table` / `said` / `unavailable` a helper is handed)
     * indexed by one of the names a code from outside goes by here. A lookup by a closed union
     * of this app's own (`ICONS[kind]`, `WORK_LINES[kind]`, `PRESENCE_LABELS[kind]`) is not this.
     */
    const bare =
      /\b(?:[A-Z][A-Z0-9_]{3,}|table|said|unavailable\??\.?)\[(?:code|body\??\.code|failure\.code|reason|key)\]/;
    const allowed = new Set([
      // The helper itself, which is where `table[key]` is said once, behind `Object.hasOwn`.
      "lib/own.ts",
      // The shelf's own four keys, a closed list this file iterates.
      "routes/_authed/_app/made.tsx",
    ]);
    const found: string[] = [];
    for await (const file of new Glob("**/*.{ts,tsx}").scan(root)) {
      if (allowed.has(file) || file.startsWith("lib/i18n")) continue;
      const lines = (await Bun.file(`${root}/${file}`).text()).split("\n");
      lines.forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, "");
        if (/^\s*\*/.test(code)) return;
        if (bare.test(code)) found.push(`${file}:${index + 1}`);
      });
    }
    expect(found).toEqual([]);
  });
});
