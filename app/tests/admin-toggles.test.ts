import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A ROW OF BUTTONS WHERE THE FILL IS THE STATE SAYS NOTHING TO A SCREEN READER.
 *
 * Four of them shipped: the audit trail's filters, the plugin page's three tabs, the per-Bot grants
 * on a component and the data functions under them. Each drew the chosen one darker and announced,
 * to anybody not looking at it, a list of identical buttons — five Bot names with no indication
 * which of them held the component.
 *
 * The fix is one attribute, and the reason this test exists is that it is one attribute: nothing
 * about a missing `aria-pressed` shows up in a typecheck, a screenshot or a click-through, so the
 * next group added will be built by copying one of these and will copy whatever is there.
 *
 * WHY NOT `role="tab"`. Two of these choose which panel is shown, which is what a tablist is for.
 * That role also promises arrow-key navigation and a roving tabindex; announcing "tab 2 of 3" in
 * front of controls that only answer to Tab and Enter is a worse lie than no role. They are toggle
 * buttons, and they say so.
 *
 * Source-walking rather than rendering, for the same reason `i18n-coverage.test.ts` walks source:
 * these live inside route components behind a router and four queries, and a test that had to boot
 * all of that to read one attribute would be a test people delete.
 */

const SOURCE = join(import.meta.dir, "../src");

/** Every set of buttons in admin where exactly one, or some, are chosen. */
const GROUPS: { file: string; near: string; least: number }[] = [
  {
    file: "routes/_authed/admin/audit.tsx",
    near: "FILTERS.map((filter) => (",
    least: 1,
  },
  {
    file: "routes/_authed/admin/plugins.tsx",
    near: '["catalogue", t("Catalogue")]',
    least: 1,
  },
  {
    file: "routes/_authed/admin/plugins.tsx",
    near: "bots.map((bot) => {",
    least: 2,
  },
  {
    file: "routes/_authed/admin/components.tsx",
    near: "bots.map((bot) => {",
    least: 1,
  },
  {
    file: "routes/_authed/admin/components.tsx",
    near: "dataFunctions.map((fn) => {",
    least: 1,
  },
];

function read(file: string): string {
  return readFileSync(join(SOURCE, file), "utf8");
}

describe("the admin toggle groups", () => {
  test("every one of them is still where this test thinks it is", () => {
    // A group renamed or reshaped would otherwise make the assertions below pass on nothing.
    const missing = GROUPS.filter(
      ({ file, near, least }) => read(file).split(near).length - 1 < least,
    ).map(({ file, near }) => `${file}: ${near}`);
    expect(missing).toEqual([]);
  });

  test("says which are chosen, and not only in the fill", () => {
    /*
     * Counted per group rather than per file: `plugins.tsx` has two grant strips and one tab strip,
     * and a file-level count would go green with one of the three left bare.
     */
    const bare: string[] = [];
    for (const { file, near } of GROUPS) {
      const text = read(file);
      for (const [index, part] of text.split(near).entries()) {
        if (index === 0) continue;
        // The button element opened by this map, up to its closing bracket.
        const button = part.slice(0, part.indexOf("</Button>"));
        if (!button.includes("aria-pressed=")) {
          bare.push(`${file}: the group at ${near} has no aria-pressed`);
        }
      }
    }
    expect(bare).toEqual([]);
  });

  test("the chosen treatment comes from one place, not from a swapped variant", () => {
    /*
     * `variant={chosen ? "default" : "outline"}` was how all four said it, and `default` is the
     * PRIMARY fill — the same treatment as the one button on a page you are meant to press. So a
     * strip of five grants read as five calls to action, and a chosen-and-focused one said chosen
     * twice in two different greys. `Button` draws it from `aria-pressed` now
     * (`components/ui/focus.ts`), so a swapped variant beside the attribute is two answers.
     */
    const doubled: string[] = [];
    for (const { file, near } of GROUPS) {
      const text = read(file);
      for (const [index, part] of text.split(near).entries()) {
        if (index === 0) continue;
        const button = part.slice(0, part.indexOf("</Button>"));
        if (/variant=\{[^}]*\?[^}]*"default"/.test(button)) {
          doubled.push(`${file}: the group at ${near} still swaps its variant`);
        }
      }
    }
    expect(doubled).toEqual([]);
  });
});
