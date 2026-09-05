import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A RATCHET ON THE FIVE WAYS THIS APP WRITES A VALUE INSTEAD OF NAMING ONE.
 *
 * Measured on 2026-09-06, before any of this was fixed: 17 distinct corner radii where the ladder
 * has 8 rungs, 8 font sizes that are not on a scale of 6, 7 elevations of which exactly one came
 * from the token that was written for it, 44 raw `--sand-*` variables in class strings where an
 * alias already existed, and the house focus ring copied out by hand in seven primitives and
 * missing from five more.
 *
 * None of that is visible from a typecheck or a screenshot. `rounded-[3px]` next to `rounded-sm`
 * looks fine; it is only wrong in aggregate, which is why it accumulates and why the count is the
 * thing worth guarding rather than any single line.
 *
 * The rule here is one-way. A file may carry no more than the allowance below, an unlisted file may
 * carry none, and a file that reaches zero must LOSE its line — so the allowance can only shrink.
 * `docs/laf/design-tokens.md` says what to write instead, rung by rung.
 */

const SOURCE = join(import.meta.dir, "../src");

type Rule = {
  readonly name: string;
  readonly pattern: RegExp;
  readonly advice: string;
  /** Files that are allowed to contain the pattern because they DEFINE it. */
  readonly definedIn?: RegExp;
};

const RULES: readonly Rule[] = [
  {
    name: "radius",
    pattern: /\brounded(?:-[a-z]{1,2})?-\[/g,
    advice:
      "an arbitrary corner. The ladder is rounded-xs/sm/md/lg/xl/2xl/3xl plus rounded-bubble and rounded-bubble-joined.",
  },
  {
    name: "type",
    pattern: /\btext-\[[0-9.]/g,
    advice:
      "an arbitrary font size. The scale is text-xs 11 / sm 13 / base 14 / lg 17 / xl 22 / 2xl 26.",
  },
  {
    name: "shadow",
    pattern: /\bshadow-\[/g,
    advice:
      "an arbitrary elevation. This design has two: shadow-popover and shadow-composer.",
  },
  {
    name: "sand",
    pattern: /-\[var\(--sand-/g,
    advice:
      "a raw palette variable. Nearly all of them have an alias — bg-accent, bg-muted, bg-sidebar-accent, border-ring, bg-bubble-user, text-on-color, bg-mark, text-link.",
  },
  {
    name: "ring",
    pattern:
      /focus-(?:visible|within):(?:border-ring|ring-ring|ring-[1-9]|ring-foreground)/g,
    advice:
      "the house focus ring written out by hand. Import focusRing / focusRingInset / focusRingWithin from @/components/ui/focus.",
    definedIn: /^components\/ui\/focus\.ts$/,
  },
];

/**
 * WHAT WAS ALREADY THERE ON 2026-09-06, file by file.
 *
 * Every entry is a screen. The primitives under `components/ui/` were drained in the same change
 * that added this test and are deliberately absent — see the last test in this file, which is what
 * keeps them absent.
 */
const ALLOWED: Record<string, Record<string, number>> = {
  radius: {
    "components/agents/agent-profile.tsx": 1,
    "components/channels/composer/composer.tsx": 1,
    "components/gallery/cards.tsx": 1,
    "components/gallery/charts.tsx": 2,
  },
  type: {
    "components/agents/bot-intro-card.tsx": 1,
    "components/agents/roster-strip.tsx": 1,
    "components/channels/bot-panel.tsx": 2,
    "components/channels/chat-transcript.tsx": 1,
    "components/gallery/cards.tsx": 1,
    "routes/_authed/_app/channel/new.tsx": 4,
    "routes/_authed/_app/index.tsx": 4,
  },
  shadow: {
    "components/channels/composer/composer.tsx": 2,
  },
  sand: {
    "components/agents/agent-card.tsx": 1,
    "components/agents/agent-profile.tsx": 1,
    "components/app-sidebar/bot-row.tsx": 5,
    "components/app-sidebar/bot-sidebar.tsx": 9,
    "components/avatar/bot-avatar-picker.tsx": 1,
    "components/channels/chat-transcript.tsx": 3,
    "components/channels/composer/composer.tsx": 6,
    "components/layout/shell-titlebar.tsx": 2,
    "routes/_authed/_app/channel/$channelId.tsx": 1,
    "routes/_authed/_app/channel/new.tsx": 2,
  },
  ring: {},
};

/**
 * Comments are not class strings.
 *
 * A comment explaining why `text-[0.8rem]` was wrong is not an instance of it, and a rule that
 * cannot tell the difference punishes the person documenting the fix. Block comments go entirely;
 * `//` is stripped only where it opens a line, because a `//` in the middle of one is far more
 * likely to be inside a URL than to start a comment worth reading.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (/\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

/** Rule name -> relative path -> how many times the pattern appears today. */
function measure(): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const rule of RULES) counts[rule.name] = {};

  for (const path of sourceFiles(SOURCE)) {
    const file = relative(SOURCE, path);
    // Generated: the route tree is written by the router plugin, the app config by a script.
    if (file === "routeTree.gen.ts" || file.startsWith("lib/generated/")) {
      continue;
    }
    const text = withoutComments(readFileSync(path, "utf8"));
    for (const rule of RULES) {
      if (rule.definedIn?.test(file)) continue;
      const hits = text.match(rule.pattern);
      if (hits) {
        (counts[rule.name] as Record<string, number>)[file] = hits.length;
      }
    }
  }
  return counts;
}

const counted = measure();

describe("the design tokens", () => {
  for (const rule of RULES) {
    const allowed = ALLOWED[rule.name] ?? {};
    const actual = counted[rule.name] ?? {};

    test(`no new ${rule.name} drift`, () => {
      const grown: string[] = [];
      for (const [file, count] of Object.entries(actual)) {
        const budget = allowed[file] ?? 0;
        if (count > budget) {
          grown.push(
            `  ${file}: ${count} (allowed ${budget}) — ${rule.advice}`,
          );
        }
      }
      expect(grown.join("\n")).toBe("");
    });

    test(`the ${rule.name} allowance has shrunk where it could`, () => {
      const stale = Object.keys(allowed)
        .filter((file) => !(file in actual))
        .map(
          (file) =>
            `  ${file} is clean now — delete its line from ALLOWED.${rule.name} so the count cannot climb back.`,
        );
      expect(stale.join("\n")).toBe("");
    });
  }

  /**
   * The primitives are the one place a value gets named, so they are the one place that may not
   * spell one out. Everything under `components/ui/` was drained on 2026-09-06; this is what says
   * it stays drained rather than quietly earning an allowlist line of its own.
   */
  test("no primitive spells a value out", () => {
    const offenders: string[] = [];
    for (const rule of RULES) {
      for (const file of Object.keys(counted[rule.name] ?? {})) {
        if (file.startsWith("components/ui/")) {
          offenders.push(`  ${file} (${rule.name}) — ${rule.advice}`);
        }
      }
    }
    expect(offenders.join("\n")).toBe("");
  });
});
