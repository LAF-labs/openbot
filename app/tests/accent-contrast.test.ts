import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE ACCENT IS EVERY BUTTON'S COLOUR, SO IT HAS TO CLEAR AA IN BOTH THEMES.
 *
 * One accent, the same for everybody (`--app-accent` in `styles.css`). It was the Bot's — the
 * colour of its face, one of ten palettes, every one measured here — until 2026-10-09, when the Bot
 * stopped having a face; a near-black neutral until 2026-10-11; #2079e7 since (the owner), with a
 * lighter #5b9df2 in the dark. It is four lines per theme, and these tests read `styles.css` back —
 * the values the browser will actually use, not a copy of them — and measure every pair a screen
 * puts together:
 *
 *  - the label on a filled control (`--app-accent-fill`, a step darker than the accent in the
 *    light), and on its hover (4.5:1, it is text);
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
    button: rgb(resolved(values, "--app-accent-fill")),
    hover: rgb(resolved(values, "--app-accent-hover")),
    foreground: rgb(resolved(values, "--app-accent-foreground")),
    ink: rgb(resolved(values, "--app-accent-ink")),
  };
}

describe("the accent, the same for everybody", () => {
  for (const theme of ["light", "dark"] as const) {
    /*
     * THE FILLED CONTROL HAS A VALUE OF ITS OWN (`--app-accent-fill`), a step darker than the
     * accent in the light: white on #2079e7 is 4.24:1, and for a few hours of 2026-10-11 this
     * floor was 4.2 for that one pair. The owner chose a darker fill over the exception, so there
     * is none: 4.5 for the label, hovered or not, in both themes.
     */
    test(`${theme}: the label on a filled control reads at 4.5:1, hovered or not`, () => {
      const { button, hover, foreground } = accent(theme);
      expect(contrast(button, foreground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hover, foreground)).toBeGreaterThanOrEqual(4.5);
    });

    test(`${theme}: as text it reads at 4.5:1 on the page, the sidebar, a card and its own tint`, () => {
      const { ink, fill } = accent(theme);
      const grounds = surfaces(theme);
      const short = Object.entries(grounds)
        .filter(([, ground]) => contrast(ink, ground) < 4.5)
        .map(([name]) => name);
      // The accent's own 8% tint (`bg-primary/8`) — a chosen row, the pill — is a surface too, and
      // it is laid over each of the three: 설정's chosen row is the tint over the sidebar's grey.
      for (const [name, ground] of Object.entries(grounds)) {
        if (contrast(ink, mix(fill, 0.08, ground)) < 4.5)
          short.push(`tint over ${name}`);
      }
      expect(short).toEqual([]);
    });

    test(`${theme}: as a ring or a border it stands out 3:1 from the page`, () => {
      expect(
        contrast(accent(theme).fill, surfaces(theme).page),
      ).toBeGreaterThanOrEqual(3);
    });

    /*
     * A CARD'S ONE THING IS IN THE ACCENT (2026-10-11): the bars of a chart, the fill of a progress
     * bar and a line are marks on a card, and the composer's hairline while it is typed in is a
     * mark on the composer's own fill — the lightest surface in the dark, where #2079e7 itself was
     * 3.29 and the reason the dark accent is a lighter one.
     */
    test(`${theme}: as a mark it stands out 3:1 from a card and from the composer's fill`, () => {
      const { fill } = accent(theme);
      const values = palette(theme);
      expect(contrast(fill, surfaces(theme).card)).toBeGreaterThanOrEqual(3);
      expect(
        contrast(fill, rgb(values["--sand-fill-elevated"] as string)),
      ).toBeGreaterThanOrEqual(3);
    });

    test(`${theme}: a chart's first series is the accent, whatever the accent is`, () => {
      const values = palette(theme);
      expect(values["--chart-1"]).toBe("var(--app-accent)");
      expect(resolved(values, "--chart-1")).toBe(
        resolved(values, "--app-accent"),
      );
    });
  }

  /*
   * ONLY WHAT FLOATS CASTS A SHADOW (the owner, 2026-10-11): a menu, a popover, a dialog, the
   * composer. A card in the conversation had a lift of its own (`shadow-card`) from 2026-09-24;
   * it is a hairline and a fill now, and the token must not come back as a class somebody types.
   */
  test("a card casts no shadow: the sheet has two elevations, and the card's is not one", () => {
    expect(CSS).not.toMatch(/--shadow-card\s*:/);
    expect(CSS).not.toMatch(/--sand-shadow-card\s*:/);
    expect(CSS).toMatch(/--shadow-popover\s*:/);
    expect(CSS).toMatch(/--shadow-composer\s*:/);
    const surface = readFileSync(
      join(import.meta.dir, "../src/components/ui/card-surface.ts"),
      "utf8",
    );
    expect(
      /export const chatCard =\s*"([^"]+)"/.exec(surface)?.[1],
    ).not.toMatch(/shadow/);
  });

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

/*
 * THE RING ON WHAT HAS NO BORDER, AND THE RED THAT IS A BUTTON (2026-10-11, `ui/focus.ts`,
 * `ui/button.tsx`). Two leftovers of the accent's arrival were measured in the browser:
 *
 *  - a row that is a link — a project in the list, 채팅 · 프로젝트, the Bot's name — had only the
 *    house ring's 35% halo to show on focus, 1.58:1 on the page; `focusRingBare` is the accent
 *    solid, and it is the same value as `--app-accent`, so it is measured here as a ring against
 *    every ground a row sits on (3:1, WCAG 1.4.11), the switch's grey included;
 *  - 삭제 in a confirm (`destructive-fill`) is the red filled, with white on it in the light and
 *    the page's near-black in the dark, where white on the coral is 3.0. Both labels at 4.5.
 *    The tinted `destructive` — 연결 끊기, 멈추기 — keeps the red as words on its own wash.
 */
describe("the ring on a bare row, and the red as a fill", () => {
  const focus = readFileSync(
    join(import.meta.dir, "../src/components/ui/focus.ts"),
    "utf8",
  );
  const button = readFileSync(
    join(import.meta.dir, "../src/components/ui/button.tsx"),
    "utf8",
  );

  test("the bare ring is solid: no alpha on its colour, and no border it would need to recolour", () => {
    const bare = /export const focusRingBare =\s*"([^"]+)"/.exec(focus)?.[1];
    expect(bare).toBeDefined();
    expect(bare).toContain("focus-visible:ring-ring");
    expect(bare).not.toMatch(/ring-ring\/\d/);
    expect(bare).not.toContain("border-ring");
  });

  /*
   * The outline variant's own `dark:border-input` sorts after `focus-visible:border-ring` and
   * wins, as `dark:bg-input/30` wins over `aria-pressed:` — measured 2026-10-11, a focused 취소
   * in the dark kept its grey border (1.55:1 on the card). The house ring says it again under
   * `dark:`, as the chosen state does.
   */
  test("the house ring recolours the border under dark: too, where the outline variant restates it", () => {
    const ring = /export const focusRing =\s*"([^"]+)"/.exec(focus)?.[1];
    expect(ring).toContain("dark:focus-visible:border-ring");
    expect(button).toContain("dark:border-input");
  });

  test("the filled destructive declares its dark fill, so nothing is left for a merge to drop", () => {
    const variant = /"destructive-fill":\s*`([^`]+)`/.exec(button)?.[1];
    expect(variant).toBeDefined();
    expect(variant).toContain("bg-destructive ");
    expect(variant).toContain("dark:bg-destructive ");
    expect(variant).toContain("dark:text-background");
  });

  for (const theme of ["light", "dark"] as const) {
    test(`${theme}: the bare ring stands out 3:1 from every ground a row sits on`, () => {
      const { fill } = accent(theme);
      const values = palette(theme);
      const grounds = {
        ...surfaces(theme),
        // The 채팅 · 프로젝트 switch is the grey a chosen row takes; its links sit on it.
        switch: rgb(
          values["--sand-fill-ghost-selected"] as string,
          surfaces(theme).page,
        ),
        hover: rgb(
          values["--sand-fill-ghost-hover"] as string,
          surfaces(theme).page,
        ),
      };
      const short = Object.entries(grounds)
        .filter(([, ground]) => contrast(fill, ground) < 3)
        .map(([name]) => name);
      expect(short).toEqual([]);
    });

    test(`${theme}: the label on a filled destructive reads at 4.5:1`, () => {
      const values = palette(theme);
      const red = rgb(values["--destructive"] as string);
      const label =
        theme === "light"
          ? ([255, 255, 255] as [number, number, number])
          : rgb(values["--sand-bg-base"] as string);
      expect(contrast(red, label)).toBeGreaterThanOrEqual(4.5);
    });

    // The resting wash of the tinted `destructive` button and the focused destructive menu
    // item: 10% of the red in the light, 12% of the coral in the dark (20% was 4.19 on a card).
    test(`${theme}: the red as words on its own wash reads at 4.5:1`, () => {
      const values = palette(theme);
      const red = rgb(values["--destructive"] as string);
      const share = theme === "light" ? 0.1 : 0.12;
      for (const [name, ground] of Object.entries(surfaces(theme))) {
        expect({
          name,
          ok: contrast(red, mix(red, share, ground)) >= 4.5,
        }).toEqual({ name, ok: true });
      }
    });
  }
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
