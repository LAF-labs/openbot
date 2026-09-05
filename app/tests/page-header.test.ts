import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  pageDescriptionClass,
  pageHeaderClass,
  pageTitleClass,
  pageTitleRowClass,
} from "../src/components/ui/page-header";

/**
 * BOTS, ROUTINES AND SKILLS ARE THREE NEIGHBOURS IN THE RAIL, AND THEY HAD THREE HEADINGS.
 *
 * Not three designs — nobody designed them — three accretions. Bots put a `<div>` on the title's
 * baseline (a column holding a ghost button and a paragraph, which made its title row taller than
 * the other two); Routines put a filled `<Button>` there; Skills had no header action at all and
 * pushed 새 스킬 down into a section heading, drawn quietly, where the eye does not look for the
 * thing a page is for.
 *
 * This walks the source rather than rendering, because the property worth holding is structural: the
 * three pages must reach ONE component. A rendering test would pass just as happily on three
 * headers that currently agree, which is exactly the state that produced this.
 */

const APP = join(import.meta.dir, "../src");
const read = (relative: string) => readFileSync(join(APP, relative), "utf8");

/** The three siblings, by the file a person lands in when they press the rail. */
const SIBLINGS = {
  Bots: "routes/_authed/_app/agents/index.tsx",
  Routines: "routes/_authed/_app/routines.tsx",
  Skills: "routes/_authed/_app/skills.tsx",
};

describe("the three sibling pages", () => {
  test("all draw their heading through PageShell", () => {
    const missing = Object.entries(SIBLINGS)
      .filter(([, path]) => !read(path).includes("PageShell"))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  test("none of them writes a page title of its own", () => {
    /*
     * An `<h1>` on the page is the drift this test exists to catch: it is how a screen ends up with
     * a second title, or with the same title at a different size to its neighbours'.
     */
    const guilty = Object.entries(SIBLINGS)
      .filter(([, path]) => /<h1[\s>]/.test(read(path)))
      .map(([name]) => name);
    expect(guilty).toEqual([]);
  });

  test("each gives PageShell one primary action", () => {
    for (const [name, path] of Object.entries(SIBLINGS)) {
      expect(`${name}: ${read(path).includes("action={")}`).toBe(
        `${name}: true`,
      );
    }
  });

  test("and that action is a Button, not a column with a paragraph in it", () => {
    /*
     * Bots reaches its button through `NewBotButton`, which also draws the seats sentence — a
     * `<div>` wrapping a button and a `<p>`, which is what made this title row taller than the
     * other two. `withReason={false}` is the header's contract with it: give me the bare button
     * and let the roster say the rest, where there is room for a sentence.
     */
    expect(read(SIBLINGS.Bots)).toContain("withReason={false}");
    expect(read("components/agents/new-bot-button.tsx")).toContain(
      "if (!withReason) return button;",
    );
    for (const page of [SIBLINGS.Routines, SIBLINGS.Skills]) {
      const source = read(page);
      const at = source.indexOf("action={");
      expect(source.slice(at, at + 400)).toContain("<Button");
    }
  });

  test("PageShell delegates to PageHeader rather than laying out its own", () => {
    const shell = read("components/layout/page-shell.tsx");
    expect(shell).toContain("<PageHeader");
    // The markup moved out; what is left must not be a second copy of it.
    expect(shell).not.toContain('<h1 className="font-semibold text-2xl">');
  });

  test("PageHeader spends the shared tokens instead of respelling them", () => {
    /*
     * `ui/page-header.ts` is where "how big is a page title" is answered, once, for the whole app.
     * A header that hard-codes `text-2xl` agrees with it today and drifts the first time the scale
     * moves — which is the failure this pair of files was split up to prevent.
     */
    const header = read("components/layout/page-header.tsx");
    for (const token of [
      "pageDescriptionClass",
      "pageHeaderClass",
      "pageTitleClass",
      "pageTitleRowClass",
    ]) {
      expect(`${token}: ${header.includes(token)}`).toBe(`${token}: true`);
    }
    expect(header).not.toContain("text-2xl");
  });

  test("the tokens are the ones the design record documents", () => {
    // docs/laf/design-tokens.md §10 prints this table. If a value changes, the doc is now wrong.
    expect(pageHeaderClass).toBe("flex flex-col gap-2");
    expect(pageTitleRowClass).toBe(
      "flex flex-row items-center justify-between gap-4",
    );
    expect(pageTitleClass).toBe("font-semibold text-2xl");
    expect(pageDescriptionClass).toContain("max-w-prose");
  });
});
