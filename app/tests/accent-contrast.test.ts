import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accentOf } from "../src/lib/avatar/accent";
import { BOT_AVATAR_PALETTES } from "../src/lib/avatar/bot-avatar";

/**
 * THE BOT'S COLOUR IS EVERY BUTTON'S COLOUR, SO EVERY PALETTE HAS TO CLEAR AA IN BOTH THEMES.
 *
 * A person picks the face's colour for how the face looks; they never picked a button colour, and
 * nothing on the profile says "this red will be your 보내기". So the accent a palette becomes is not
 * theirs to get wrong, and a palette that made white text on a button unreadable would be a design
 * decision nobody took. These tests read `styles.css` back — the values the browser will actually
 * use, not a copy of them — and measure every pair a screen puts together:
 *
 *  - the label on a filled control, and on its hover (4.5:1, it is text);
 *  - the same value as text — a link, the name of what the Bot is waiting on — on the page, the
 *    sidebar, a card and the Bot's own bubble, and on the accent's own 8% tint (4.5:1);
 *  - the value as a focus ring or a border against the page (3:1, WCAG 1.4.11).
 *
 * And the words around them: secondary text and the amber of "확인 필요", which were measured here
 * for the first time and were under 4.5 (#c27400 was 3.5:1).
 */

const CSS = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");

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

/** Every surface a control, a link or a line of the Bot's colour can sit on. */
function surfaces(theme: Theme): Record<string, [number, number, number]> {
  const values = palette(theme);
  const page = rgb(values["--sand-bg-base"] as string);
  return {
    page,
    sidebar: rgb(values["--sand-bg-subtle"] as string),
    card: rgb(values["--sand-bg-elevated"] as string),
    bubble: rgb(values["--sand-fill-bubble-agent"] as string),
  };
}

const PALETTE_IDS: string[] = BOT_AVATAR_PALETTES.map((color) => color.id);

function accent(id: string, theme: Theme) {
  const selector =
    theme === "light"
      ? `:root[data-accent="${id}"]`
      : `:root.dark[data-accent="${id}"]`;
  const values = block(selector);
  return {
    fill: rgb(values["--bot-accent"] as string),
    hover: rgb(values["--bot-accent-hover"] as string),
    foreground: rgb(values["--bot-accent-foreground"] as string),
    ink: rgb(values["--bot-accent-ink"] as string),
  };
}

describe("every palette a face can have is an accent the app can be drawn in", () => {
  test("each one has a block for light and a block for dark", () => {
    for (const id of PALETTE_IDS) {
      expect(() => accent(id, "light")).not.toThrow();
      expect(() => accent(id, "dark")).not.toThrow();
    }
    // Black is the one colour a person cannot pick, so it has no accent of its own.
    expect(PALETTE_IDS).not.toContain("black");
  });

  for (const theme of ["light", "dark"] as const) {
    test(`${theme}: the label on a filled control reads at 4.5:1, hovered or not`, () => {
      const short: string[] = [];
      for (const id of PALETTE_IDS) {
        const { fill, hover, foreground } = accent(id, theme);
        if (contrast(fill, foreground) < 4.5) short.push(`${id} fill`);
        if (contrast(hover, foreground) < 4.5) short.push(`${id} hover`);
      }
      expect(short).toEqual([]);
    });

    test(`${theme}: as text it reads at 4.5:1 on the page, the sidebar, a card and the Bot's bubble`, () => {
      const short: string[] = [];
      for (const id of PALETTE_IDS) {
        const { ink, fill } = accent(id, theme);
        const grounds = surfaces(theme);
        for (const [name, ground] of Object.entries(grounds)) {
          if (contrast(ink, ground) < 4.5) short.push(`${id} on ${name}`);
        }
        // The accent's own 8% tint (`bg-primary/8`) — a selected row, the pill — is a surface too.
        const tint = mix(fill, 0.08, grounds.page);
        if (contrast(ink, tint) < 4.5) short.push(`${id} on its tint`);
      }
      expect(short).toEqual([]);
    });

    test(`${theme}: as a ring or a border it stands out 3:1 from the page`, () => {
      const short = PALETTE_IDS.filter(
        (id) => contrast(accent(id, theme).fill, surfaces(theme).page) < 3,
      );
      expect(short).toEqual([]);
    });
  }

  test("the neutral control, before there is a Bot, keeps the same promises", () => {
    for (const theme of ["light", "dark"] as const) {
      const values = palette(theme);
      const fill = rgb(values["--sand-fill-primary"] as string);
      const label = rgb(values["--sand-text-on-primary"] as string);
      expect(contrast(fill, label)).toBeGreaterThanOrEqual(4.5);
      const link = rgb(values["--sand-text-accent"] as string);
      for (const ground of Object.values(surfaces(theme))) {
        expect(contrast(link, ground)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("the palette is read from the seed, and nothing before there is one", () => {
    expect(accentOf("s:egg.orange")).toBe("orange");
    expect(accentOf("s:blob.violet")).toBe("violet");
    expect(accentOf(undefined)).toBeUndefined();
    // Any seed at all lands on a palette that has a block.
    for (const seed of ["f:3.4", "g:0.0", "anything", ""]) {
      expect(PALETTE_IDS).toContain(accentOf(seed) as string);
    }
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
