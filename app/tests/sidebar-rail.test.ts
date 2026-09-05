import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ko } from "../src/lib/i18n-ko";

/**
 * The roster's column, walked as source rather than rendered.
 *
 * WHY SOURCE. `BotSidebar` is four `useQuery` calls, a router `Link` in every row and a context menu
 * around each one, so standing it up means a QueryClient, a memory router with the whole route tree
 * and a seeded cache — and what would then be asserted is a class list, which is what is asserted
 * here for a hundredth of the setup. The thing a render WOULD have caught, the measured width, was
 * measured in the browser instead: 64px at an 800px viewport and 280px above `lg`, with
 * `getBoundingClientRect()`.
 *
 * So this file guards the decisions a refactor can quietly undo — the two widths, the breakpoint the
 * JavaScript reads, the one row layout, the locale on every format, the focus ring's provenance.
 */

const componentsDir = join(import.meta.dir, "..", "src", "components");
const readComponent = (...parts: string[]) =>
  readFileSync(join(componentsDir, ...parts), "utf8");

const sidebar = readComponent("app-sidebar", "bot-sidebar.tsx");
const botRow = readComponent("app-sidebar", "bot-row.tsx");
const groupRow = readComponent("app-sidebar", "group-row.tsx");
const focus = readComponent("ui", "focus.ts");

describe("the roster collapses to a rail", () => {
  test("64px below lg, the full column above it", () => {
    expect(sidebar).toContain('const RAIL_WIDTH = "4rem"');
    expect(sidebar).toContain(
      'const SIDEBAR_WIDTH = "var(--sand-sidebar-width)"',
    );
    expect(sidebar).toContain("isRail ? RAIL_WIDTH : SIDEBAR_WIDTH");
  });

  /*
   * `lg` is 1024px because a media query resolves `rem` against the INITIAL root font size, not this
   * app's 14px root. Reading a different query in JavaScript than `lg:` compiles to in CSS would put
   * the rail and everything else that is responsive on either side of a 128px no-man's-land.
   */
  test("reads the same breakpoint Tailwind's lg compiles to", () => {
    expect(sidebar).toContain('"(min-width: 64rem)"');
  });

  test("the person can open the full list at a narrow width too", () => {
    expect(sidebar).toContain("isRailExpanded");
    expect(sidebar).toContain("!isWide && !isRailExpanded");
    expect(sidebar).toContain('t("Expand the sidebar")');
    expect(sidebar).toContain('t("Collapse the sidebar")');
    expect(ko["Expand the sidebar"]).toBeTruthy();
    expect(ko["Collapse the sidebar"]).toBeTruthy();
  });

  /*
   * TAILWIND CLASSES ONLY, WITH ONE EXPLAINED EXCEPTION: the width.
   *
   * `--sand-sidebar-width` is the token that decides how wide the open column is, and written into
   * a class it is `w-[var(--sand-…)]` — a raw palette variable in a class string, which is what
   * `design-tokens.test.ts` counts as drift. So the width stays a value, exactly as this file
   * expressed it before the rail existed, and it is the ONLY style in the column.
   */
  test("the width is the one value in the column, and the rows carry none", () => {
    expect(sidebar.match(/style=\{\{/g) ?? []).toHaveLength(1);
    expect(sidebar).toContain(
      "style={{ width: isRail ? RAIL_WIDTH : SIDEBAR_WIDTH }}",
    );
    expect(botRow).not.toContain("style={{");
    expect(groupRow).not.toContain("style={{");
  });

  /*
   * A face with no words beside it is a link with no accessible name, so the rail hands every row an
   * `aria-label` and a tooltip. Losing either turns the whole column into unlabelled graphics.
   */
  test("a face in the rail still has a name, on screen and in the tree", () => {
    for (const source of [botRow, groupRow]) {
      expect(source).toContain("ROSTER_RAIL_ROW_CLASS");
      expect(source).toContain("aria-label=");
      expect(source).toContain("TooltipContent");
    }
  });
});

describe("one row layout", () => {
  /*
   * The frame and the two lines live in `bot-row.tsx` and are imported. When they were a copy in
   * each file the copies had already drifted: a Bot row drew name + role + time and a room row drew
   * name + time, so the second line of the roster meant something different above the groups than
   * below them.
   */
  test("a room row is the colleague row's markup, not a copy of it", () => {
    expect(botRow).toContain("export const ROSTER_ROW_CLASS");
    expect(botRow).toContain("export const RosterRowLines");
    expect(groupRow).toContain('from "@/components/app-sidebar/bot-row"');
    expect(groupRow).toContain("ROSTER_ROW_CLASS");
    expect(groupRow).toContain("RosterRowLines");
    // The frame is defined once. A second `--sand-row-height` here would be the copy coming back.
    expect(groupRow).not.toContain("--sand-row-height");
  });

  test("that layout is name, last line and time", () => {
    const lines = botRow.slice(botRow.indexOf("export const RosterRowLines"));
    expect(lines).toContain("{name}");
    expect(lines).toContain("{subtitle}");
    expect(lines).toContain("{time}");
  });

  /*
   * A colleague's time now comes from the same `coalesce(last_message_at, created_at)` a room's does
   * — the server's own rule — so the two kinds of row are never one with a time and one without.
   */
  test("a colleague's time is coalesced the way a room's is", () => {
    // The room's rule, and the colleague's — the second one is what used to be a bare `?? null`.
    expect(sidebar).toContain("channel.lastMessageAt ?? channel.createdAt,");
    expect(sidebar).toContain(
      "channel ? (channel.lastMessageAt ?? channel.createdAt) : null",
    );
  });

  /* A room whose last message is its own title would otherwise have a blank second line. */
  test("a room with nothing said in it still has a second line", () => {
    expect(sidebar).toContain('t("{count} Bots in this room"');
    expect(ko["{count} Bots in this room"]).toBeTruthy();
  });
});

describe("the roster's controls", () => {
  /*
   * THE RING IS IMPORTED, NOT COPIED — which is the whole point of `ui/focus.ts`.
   *
   * These rows first borrowed the utilities out of `ui/button.tsx` by hand, and that file has since
   * stopped spelling them out: it imports `focusRing` like everything else. A test that went on
   * matching class strings would have passed on a stale copy forever, which is the failure the
   * shared constant exists to prevent.
   */
  test("the app has one spelling of the focus ring", () => {
    expect(focus).toContain("export const focusRing");
    expect(focus).toContain("focus-visible:ring-3");
  });

  test("every roster row and footer link borrows it rather than copying it", () => {
    for (const source of [botRow, sidebar]) {
      expect(source).toContain('from "@/components/ui/focus"');
      expect(source).toContain("focusRing");
      // A hand-written ring beside the imported one is how the two drift apart again.
      expect(source).not.toContain("focus-visible:ring-3");
      expect(source).not.toContain("focus-visible:border-ring");
    }
  });

  test("the + button is named and tipped", () => {
    expect(sidebar).toContain('aria-label={t("Start a new channel")}');
    expect(sidebar).toContain('{t("Start a new channel")}');
    expect(ko["Start a new channel"]).toBeTruthy();
  });

  /* A lightning bolt named no part of this product; the page it opens is a list of colleagues. */
  test("the Bots nav item is people, not a lightning bolt", () => {
    expect(sidebar).not.toContain("IconBolt");
    expect(sidebar).toContain("icon: IconUsers");
  });
});

describe("the roster speaks the app's language", () => {
  /*
   * `toLocaleTimeString()` with no argument answers in the BROWSER's locale, so a Korean app on an
   * en-US machine printed "Sat" and "9/6" down a column of Korean names — the app's own language
   * setting reaching nothing, in the one place on the roster that formats anything.
   */
  test("every locale-sensitive format is handed activeLocale", () => {
    const calls = sidebar.match(/\.toLocale\w+\([^)]*/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) {
      expect(call).toContain("activeLocale");
    }
  });

  /*
   * `t(label)` is invisible to `i18n-coverage.test.ts`, which only sees a literal `t("…")`. The
   * footer's three labels are read that way, so the table is walked here.
   */
  test("the footer's labels are all translated", () => {
    const table = sidebar.slice(
      sidebar.indexOf("const FOOTER_LINKS"),
      sidebar.indexOf("] as const"),
    );
    const labels = [...table.matchAll(/label: "([^"]+)"/g)].map(
      (match) => match[1] as string,
    );
    expect(labels.length).toBe(3);
    for (const label of labels) {
      expect(ko[label]).toBeTruthy();
    }
  });
});
