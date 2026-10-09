import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE ACCENT IS EVERY BUTTON'S COLOUR, SO IT HAS TO CLEAR AA IN BOTH THEMES.
 *
 * One accent, the same for everybody (`--app-accent` in `styles.css`). It was the Bot's — the
 * colour of its face, one of ten palettes, every one measured here — until 2026-10-09, when the Bot
 * stopped having a face. The neutral control is what is left, and a brand colour, when there is
 * one, is a change to four lines that these tests measure the moment it is made. They read
 * `styles.css` back — the values the browser will actually use, not a copy of them — and measure
 * every pair a screen puts together:
 *
 *  - the label on a filled control, and on its hover (4.5:1, it is text);
 *  - the same value as text — a link, the name of what the Bot is waiting on — on the page, the
 *    sidebar and a card, and on the accent's own 8% tint (4.5:1);
 *  - the value as a focus ring or a border against the page (3:1, WCAG 1.4.11).
 *
 * And the words around them: secondary text and the amber of "확인 필요", which were measured here
 * for the first time and were under 4.5 (#c27400 was 3.5:1).
 */

const CSS = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");
const HTML = readFileSync(join(import.meta.dir, "../index.html"), "utf8");

type Theme = "light" | "dark";

/** The declarations inside the first block whose selector is exactly `selector`. */
function block(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (!match) throw new Error(`no block for ${selector} in styles.css`);
  const values: Record<string, string> = {};
  for (const line of (match[1] as string).matchAll(
    /(--[a-z0-9-]+):\s*([^;]+);/g,
  )) {
    values[line[1] as string] = (line[2] as string).trim();
  }
  return values;
}

const root = block(":root");
const dark = { ...root, ...block(".dark") };
const palette = (theme: Theme) => (theme === "light" ? root : dark);

/** A `#rrggbb` or `#rrggbbaa` value, composited over `ground` when it has alpha. */
function rgb(value: string, ground?: [number, number, number]) {
  const hex = value.replace("#", "");
  const channels = [0, 2, 4].map((at) =>
    Number.parseInt(hex.slice(at, at + 2), 16),
  ) as [number, number, number];
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1;
  if (alpha === 1 || !ground) return channels;
  return channels.map(
    (channel, index) =>
      channel * alpha + (ground[index] as number) * (1 - alpha),
  ) as [number, number, number];
}

function mix(
  top: [number, number, number],
  share: number,
  ground: [number, number, number],
): [number, number, number] {
  return top.map(
    (channel, index) =>
      channel * share + (ground[index] as number) * (1 - share),
  ) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const [light, darker] = [luminance(a), luminance(b)].sort(
    (x, y) => y - x,
  ) as [number, number];
  return (light + 0.05) / (darker + 0.05);
}

/**
 * Every surface a control, a link or a line in the accent can sit on.
 *
 * There was a fourth, the grey of the Bot's own bubble (`--sand-fill-bubble-agent`). The Bot has
 * had no bubble since 2026-10-04 — its answers and its greeting are words on the page — and the
 * token went with it (`components/ui/bubble.tsx`).
 */
function surfaces(theme: Theme): Record<string, [number, number, number]> {
  const values = palette(theme);
  const page = rgb(values["--sand-bg-base"] as string);
  return {
    page,
    sidebar: rgb(values["--sand-bg-subtle"] as string),
    card: rgb(values["--sand-bg-elevated"] as string),
  };
}

/** A value as the theme resolves it: `var(--x)` followed through the theme's own declarations. */
function resolved(values: Record<string, string>, name: string): string {
  let value = values[name];
  for (let hop = 0; value?.startsWith("var(") && hop < 8; hop += 1) {
    value = values[value.slice(4, -1).trim()];
  }
  if (!value?.startsWith("#")) throw new Error(`${name} does not resolve`);
  return value;
}

function accent(theme: Theme) {
  const values = palette(theme);
  return {
    fill: rgb(resolved(values, "--app-accent")),
    hover: rgb(resolved(values, "--app-accent-hover")),
    foreground: rgb(resolved(values, "--app-accent-foreground")),
    ink: rgb(resolved(values, "--app-accent-ink")),
  };
}

describe("the accent, the same for everybody", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`${theme}: the label on a filled control reads at 4.5:1, hovered or not`, () => {
      const { fill, hover, foreground } = accent(theme);
      expect(contrast(fill, foreground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hover, foreground)).toBeGreaterThanOrEqual(4.5);
    });

    test(`${theme}: as text it reads at 4.5:1 on the page, the sidebar, a card and its own tint`, () => {
      const { ink, fill } = accent(theme);
      const grounds = surfaces(theme);
      const short = Object.entries(grounds)
        .filter(([, ground]) => contrast(ink, ground) < 4.5)
        .map(([name]) => name);
      // The accent's own 8% tint (`bg-primary/8`) — a selected row, the pill — is a surface too.
      if (contrast(ink, mix(fill, 0.08, grounds.page)) < 4.5)
        short.push("tint");
      expect(short).toEqual([]);
    });

    test(`${theme}: as a ring or a border it stands out 3:1 from the page`, () => {
      expect(
        contrast(accent(theme).fill, surfaces(theme).page),
      ).toBeGreaterThanOrEqual(3);
    });
  }

  /*
   * NO PALETTE PER BOT, AND NONE PUT BACK BEFORE THE FIRST PAINT (2026-10-09). The sheet mapped
   * `data-accent` on <html> to ten palettes per theme, and `index.html` put the last one back from
   * storage before React ran. A value an older build left in somebody's storage must not paint an
   * old colour, so nothing may read it, and nothing in the sheet may answer it if something did.
   */
  test("is one: no palette per Bot in the sheet, and no Bot's colour read back before the first paint", () => {
    expect(CSS).not.toMatch(/\[data-accent/);
    expect(CSS).not.toMatch(/\.bot-avatar/);
    expect(CSS).not.toContain("--bot-accent");
    expect(HTML).not.toMatch(/getItem\(\s*["']laf-accent/);
    expect(HTML).not.toMatch(
      /dataset\.accent|setAttribute\(\s*["']data-accent/,
    );
  });
});

describe("the words around the accent", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`${theme}: secondary text reads at 4.5:1 wherever it is drawn`, () => {
      const values = palette(theme);
      for (const [name, ground] of Object.entries(surfaces(theme))) {
        const text = rgb(values["--sand-text-secondary"] as string, ground);
        expect({ name, ratio: contrast(text, ground) >= 4.5 }).toEqual({
          name,
          ratio: true,
        });
      }
    });

    test(`${theme}: the amber of "확인 필요" and the red of a refusal are words, at 4.5:1`, () => {
      const values = theme === "light" ? root : { ...root, ...block(".dark") };
      for (const token of ["--warning", "--destructive", "--success"]) {
        const colour = rgb(values[token] as string);
        for (const [name, ground] of Object.entries(surfaces(theme))) {
          expect({ token, name, ok: contrast(colour, ground) >= 4.5 }).toEqual({
            token,
            name,
            ok: true,
          });
        }
      }
    });
  }
});
