import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Bugbot reviews by `.cursor/BUGBOT.md` and by every Markdown file it links, each loaded whole as
// one rule — measured on #211 with `bugbot run verbose=true`, which listed CLAUDE.md beside it.
// A rule longer than 30,000 characters is cut there and the review says nothing about it
// (cursor.com/docs/bugbot, "Rule limits"): the end of CLAUDE.md — "Rules", "Conventions" — would
// stop being reviewed against while every review still came back clean.
const RULE_LIMIT = 30_000;
const COMBINED_LIMIT = 100_000;

const root = resolve(import.meta.dir, "..");
const entry = join(root, ".cursor", "BUGBOT.md");

function rulesBugbotLoads(): { path: string; length: number }[] {
  const text = readFileSync(entry, "utf8");
  const linked = [...text.matchAll(/\]\(([^)#\s]+\.md)\)/g)].map((match) =>
    resolve(dirname(entry), match[1] ?? ""),
  );
  return [entry, ...new Set(linked)].map((path) => ({
    path: path.slice(root.length + 1),
    length: readFileSync(path, "utf8").length,
  }));
}

test("the reviewer's rules send it to CLAUDE.md", () => {
  expect(rulesBugbotLoads().map((rule) => rule.path)).toEqual([
    ".cursor/BUGBOT.md",
    "CLAUDE.md",
  ]);
});

test("no rule Bugbot loads is long enough to be cut", () => {
  const rules = rulesBugbotLoads();
  // When this fails, move history out of CLAUDE.md into `docs/laf/` — do not raise the number,
  // it is Cursor's.
  expect(rules.filter((rule) => rule.length > RULE_LIMIT)).toEqual([]);
  expect(rules.reduce((sum, rule) => sum + rule.length, 0)).toBeLessThanOrEqual(
    COMBINED_LIMIT,
  );
});
