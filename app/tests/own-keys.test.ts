/**
 * A TABLE WITH STRING KEYS IS READ BY ITS OWN KEYS (the second read of #114, 2026-10-06).
 *
 * The app keeps its words in tables and finds them by a word that arrives from somewhere else: the
 * code a response or a tool's result carries, the name a model gave a tool call, an event's name,
 * a word in the address. `TABLE[word]` answers for more names than the table was given —
 * `constructor` with a function — so that word "had a sentence", and a component was given a
 * function to draw; `t()` read its own dictionary the same way.
 *
 * The first version of this change swept the lookups whose key was called `code` and its test
 * walked for those names. A reader who had not written it found the same hole under seven other
 * names, and in `t()`. So the rule is by TYPE, and has no list of names: a table declared with
 * `string` keys in `src/` is never read bare.
 *
 * What the walk does NOT see (the third read): a table typed by one of this app's own unions and
 * indexed by a model's unchecked argument (a gallery card's `tone` — read through `own()` now,
 * and held by a test of its own below), a table declared in `shared/`, and a record handed in as
 * a parameter or a prop. `lib/own.ts` says the same.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { refusalForCode } from "@/lib/auth/sign-in-refusal";
import { turnFailureSentence } from "@/lib/channels/turn-failure";
import { refusalSaid } from "@/lib/components/queries";
import { labelForCode } from "@/lib/computer/browsing";
import { fileCardSaid } from "@/lib/computer/files";
import { outcomeLabel } from "@/lib/computer/outcome-labels";
import { screenProblemText } from "@/lib/computer/screen-problems";
import { failureReason } from "@/lib/computer/task-state";
import { stepLineOf } from "@/lib/copilot/step-labels";
import { turnNotice } from "@/lib/copilot/stopped-turn";
import { koreanFor, t } from "@/lib/i18n";
import { ko } from "@/lib/i18n-ko";
import { kindLabel } from "@/lib/made/queries";
import { summonKeysOf } from "@/lib/notifications/shell";
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
      // The same under the other names a word from outside goes by (the second read of #120):
      // a tool call the model named this, an event of this name, a word in the sign-in address,
      // a made thing's tool, a shortcut's id.
      expect(typeof stepLineOf(code).label).toBe("string");
      expect(stepLineOf(code)).toEqual(stepLineOf("a_tool_nobody_has"));
      expect(stepLineOf(code, true)).toEqual(stepLineOf("a_tool_nobody_has"));
      expect(turnNotice(code)).toBeNull();
      expect(refusalForCode(code)).toBe("unknown");
      expect(kindLabel(code)).toBe("");
      expect(summonKeysOf(code, true)).toBeNull();
    }
    // And a code the tables do hold is still said.
    expect(outcomeLabel("laf:stopped")).toBe("Stopped");
    expect(failureReason("laf:person_declined")).toBe(t("You said no"));
  });

  test("t() finds Korean only where the dictionary holds it: a word from outside is said as it came", () => {
    // What made `?connected=constructor` say "function Object() { [native code] }에 연결했어요".
    expect(typeof (ko as Record<string, unknown>).constructor).toBe("function");
    for (const word of INHERITED) {
      // The Korean path's one read, asked directly: this runner's language is English, where
      // `t()` never opens the dictionary and would pass whatever it did.
      expect(koreanFor(word)).toBeUndefined();
      expect(t(word)).toBe(word);
    }
    // A sentence the dictionary holds is still found.
    const known = Object.keys(ko)[0] ?? "";
    expect(known).not.toBe("");
    expect(koreanFor(known)).toBe(ko[known]);
  });

  test("no table declared with string keys is read bare anywhere in src/", async () => {
    const root = `${import.meta.dir}/../src`;
    const files: Array<[string, string]> = [];
    for await (const file of new Glob("**/*.{ts,tsx}").scan(root)) {
      files.push([file, await Bun.file(`${root}/${file}`).text()]);
    }
    /*
     * Every `const NAME: Record<string, …>` (Readonly, Partial, or an index signature) — module
     * tables and local ones alike. The annotation is the criterion: it is what lets TypeScript
     * index the table with any string at all.
     */
    const tables = new Map<string, string>();
    for (const [file, text] of files) {
      for (const pattern of [
        /\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:Readonly<\s*)?(?:Partial<\s*)?Record<\s*string\s*,/g,
        /\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{\s*(?:readonly\s+)?\[[A-Za-z]+:\s*string\]/g,
      ]) {
        for (const match of text.matchAll(pattern)) {
          tables.set(match[1] ?? "", file);
        }
      }
    }
    // The walk is looking at something: the dictionary, the labels, the refusals.
    expect(tables.size).toBeGreaterThan(40);
    for (const name of [
      "ko",
      "OUTCOME_LABELS",
      "STEP_LABELS",
      "TURN_NOTICES",
    ]) {
      expect(tables.has(name)).toBe(true);
    }
    const bare: string[] = [];
    for (const [file, text] of files) {
      // The helper is where `table[key]` is said once, behind the check.
      if (file === "lib/own.ts") continue;
      text.split("\n").forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, "");
        if (/^\s*\*/.test(code)) return;
        for (const name of tables.keys()) {
          // NAME[…] with anything but a literal inside, and not a write (`NAME[key] = value`).
          const read = new RegExp(
            `(?<![A-Za-z0-9_.])${name}\\??\\.?\\[(?!["'\`0-9])[^\\]]*\\](?!\\s*=(?!=))`,
          );
          if (read.test(code)) bare.push(`${file}:${index + 1} ${name}`);
        }
      });
    }
    expect(bare).toEqual([]);

    // The dictionary's own read stays in the one module: everything else says `t("…")`, which is
    // what the i18n coverage test reads.
    const askers = files
      .filter(([, text]) => /\bkoreanFor\(/.test(text))
      .map(([file]) => file);
    expect(askers).toEqual(["lib/i18n.ts"]);
  });

  test("a card's tone is a model's argument: one the tables do not hold draws no badge and no class of its own", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { Badge } = await import("@/components/gallery/frame");
    const badge = (tone: string) =>
      renderToStaticMarkup(
        // The type says one of four; a model's arguments are not checked to be.
        createElement(Badge, { tone: tone as never, children: "word" }),
      );
    for (const tone of INHERITED) {
      expect(badge(tone)).not.toContain("native code");
      expect(badge(tone)).not.toContain("[object");
      // The plain badge's own classes, as for a tone nobody named.
      expect(badge(tone)).toBe(badge("neutral"));
    }
    expect(badge("positive")).toContain("text-success");
  });
});
