import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BotAvatar,
  type BotAvatarState,
} from "../src/components/avatar/bot-avatar";
import {
  BOT_AVATAR_ACCESSORIES,
  BOT_AVATAR_EYES,
  BOT_AVATAR_PALETTES,
  BOT_AVATAR_SHAPES,
  type BotAvatarParams,
  botAvatarBackground,
  botAvatarParams,
  botAvatarSeed,
  randomBotAvatarSeed,
} from "../src/lib/avatar/bot-avatar";
import { AGENT_PRESETS } from "../src/lib/agents/presets";
import { ko } from "../src/lib/i18n-ko";

/**
 * The generated faces: the grammar, the fallback, and the markup that comes out.
 *
 * WHAT THIS IS GUARDING. A Bot's face is its identity in a roster, and the two ways to lose that
 * are silent: a seed that stops parsing (every Bot changes face at once, and nothing throws), and a
 * hash that drifts (the same Bot is a different colleague on the next deploy). Both are arithmetic,
 * so both can be pinned down here without a browser.
 */

const STATES: BotAvatarState[] = ["idle", "working", "blocked", "done"];

const render = (
  seed: string | undefined,
  size: number,
  state?: BotAvatarState,
): string =>
  renderToStaticMarkup(
    createElement(BotAvatar, {
      seed,
      size,
      ...(state ? { state } : {}),
    }),
  );

const inRange = (params: BotAvatarParams): boolean =>
  Number.isInteger(params.shape) &&
  params.shape >= 0 &&
  params.shape < BOT_AVATAR_SHAPES.length &&
  Number.isInteger(params.palette) &&
  params.palette >= 0 &&
  params.palette < BOT_AVATAR_PALETTES.length &&
  Number.isInteger(params.eyes) &&
  params.eyes >= 0 &&
  params.eyes < BOT_AVATAR_EYES.length &&
  Number.isInteger(params.accessory) &&
  params.accessory >= 0 &&
  params.accessory < BOT_AVATAR_ACCESSORIES.length;

describe("the seed grammar", () => {
  test("every face in the space round-trips through its own seed", () => {
    const broken: string[] = [];
    for (let shape = 0; shape < BOT_AVATAR_SHAPES.length; shape += 1) {
      for (
        let palette = 0;
        palette < BOT_AVATAR_PALETTES.length;
        palette += 1
      ) {
        for (let eyes = 0; eyes < BOT_AVATAR_EYES.length; eyes += 1) {
          for (
            let accessory = 0;
            accessory < BOT_AVATAR_ACCESSORIES.length;
            accessory += 1
          ) {
            const params = { shape, palette, eyes, accessory };
            const seed = botAvatarSeed(params);
            if (
              JSON.stringify(botAvatarParams(seed)) !== JSON.stringify(params)
            ) {
              broken.push(seed);
            }
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("an index past the end of a table folds back in rather than failing", () => {
    // A build that grows a seventh shape and then meets a seed written by a build that had nine has
    // to draw something, and the same something every time.
    const folded = botAvatarParams("f:999.999.999.999");
    expect(inRange(folded)).toBe(true);
    expect(botAvatarParams("f:999.999.999.999")).toEqual(folded);
  });
});

describe("a seed that is not in the grammar", () => {
  /*
   * The legacy tile ids, the shape a Bot created before any of this wore. Nothing in the app writes
   * these any more; every account that predates the generator is full of them.
   */
  const LEGACY = ["r0c0", "r2c4", "r4c5", "r3c1", "r1c6"];
  const FREE = ["", "고양이", "night-shift", "agent_01H8XK", "🙂", "f:1.2.3"];

  test("lands somewhere real, every time", () => {
    for (const seed of [...LEGACY, ...FREE]) {
      expect(inRange(botAvatarParams(seed))).toBe(true);
    }
    expect(inRange(botAvatarParams(undefined))).toBe(true);
  });

  test("lands on the SAME face every time — this is the whole promise", () => {
    /*
     * PINNED VALUES, NOT A SELF-COMPARISON. `params(x) === params(x)` passes for any hash,
     * including one that changed this morning. These four are what the FNV-1a in the module
     * produces today, and a change to the hash — or to the number of shapes, or to the order of the
     * palettes — moves them, which is exactly the day every existing Bot silently gets a new face.
     */
    expect(botAvatarSeed(botAvatarParams("r0c0"))).toBe("f:5.3.2.1");
    expect(botAvatarSeed(botAvatarParams("r4c5"))).toBe("f:0.4.1.3");
    expect(botAvatarSeed(botAvatarParams(""))).toBe("f:2.8.3.0");
    expect(botAvatarSeed(botAvatarParams("고양이"))).toBe("f:3.9.0.0");
  });

  test("spreads across the space instead of piling onto one face", () => {
    // A hash that correlated the four axes would show up here as a handful of faces for a hundred
    // ids — which is what slicing the bits of one FNV word off different offsets actually does.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(botAvatarSeed(botAvatarParams(`bot-${i}`)));
    }
    expect(seen.size).toBeGreaterThan(150);
  });

  test("a colour comes back for anything, including nothing", () => {
    expect(botAvatarBackground(undefined)).toMatch(/^#[0-9a-f]{6}$/);
    expect(botAvatarBackground("r0c0")).toMatch(/^#[0-9a-f]{6}$/);
    expect(botAvatarBackground("f:0.0.0.0")).toBe(BOT_AVATAR_PALETTES[0]?.fill);
  });
});

describe("a face nobody chose", () => {
  test("is a function of the randomness it was handed, not of the ambient kind", () => {
    const sequence = () => {
      const values = [0.1, 0.62, 0.4, 0.95, 0.03, 0.5];
      let index = 0;
      return () => {
        const value = values[index % values.length] as number;
        index += 1;
        return value;
      };
    };
    expect(randomBotAvatarSeed(sequence())).toBe(
      randomBotAvatarSeed(sequence()),
    );
    expect(randomBotAvatarSeed(sequence())).toBe("f:0.6.1.6");
  });

  test("never falls off the end of a table, even at the top of the range", () => {
    // `Math.floor(0.9999999 * 6)` is 5, but a generator that returns exactly 1 is not forbidden by
    // anything, and `BOT_AVATAR_SHAPES[6]` is undefined — a blank avatar, from one bad number.
    expect(inRange(botAvatarParams(randomBotAvatarSeed(() => 1)))).toBe(true);
    expect(inRange(botAvatarParams(randomBotAvatarSeed(() => 0)))).toBe(true);
  });
});

describe("the presets", () => {
  test("wear thirty-two distinct faces, all of them in range", () => {
    const seeds = AGENT_PRESETS.map((preset) => preset.avatarSeed);
    expect(new Set(seeds).size).toBe(seeds.length);
    expect(seeds.filter((seed) => !inRange(botAvatarParams(seed)))).toEqual([]);
  });
});

describe("what comes out of the component", () => {
  test("is markup that could not run anything", () => {
    /*
     * The set this replaced was a table of markup strings set with `dangerouslySetInnerHTML`, and
     * the comment defending that had to argue the strings were checked in. These are elements: the
     * only way a script could appear is if somebody wrote one, so this is the check that says
     * nobody did — across every shape, palette, eye and accessory, since accessories are the part
     * built out of template strings.
     */
    const suspicious: string[] = [];
    for (let shape = 0; shape < BOT_AVATAR_SHAPES.length; shape += 1) {
      for (
        let accessory = 0;
        accessory < BOT_AVATAR_ACCESSORIES.length;
        accessory += 1
      ) {
        for (const state of STATES) {
          const html = render(
            botAvatarSeed({ shape, palette: 3, eyes: 1, accessory }),
            64,
            state,
          );
          if (/<script|<foreignObject|javascript:|onload=/i.test(html)) {
            suspicious.push(`${shape}.${accessory}.${state}`);
          }
        }
      }
    }
    expect(suspicious).toEqual([]);
  });

  test("draws every state at every size it is used at, without throwing", () => {
    for (const size of [20, 24, 32, 36, 48, 56, 80, 128, 144]) {
      for (const state of STATES) {
        for (const seed of [undefined, "r4c5", "f:5.9.3.6"]) {
          const html = render(seed, size, state);
          expect(html).toContain('viewBox="0 0 96 96"');
          expect(html).toContain(`width="${size}"`);
        }
      }
    }
  });

  /**
   * THE STAR IS ON THE HEAD, AND NOT IN THE CORNER THE MARK OWNS.
   *
   * It was `translate(79 15)` — a fixed point with no idea what shape was under it. Measured in the
   * browser: on a triangle it sat a third of a box from the apex and read as a badge pinned to the
   * roster card; on a blocked Bot the amber mark at (76,18) covered it completely. Both are things
   * a typecheck and every test here were perfectly happy with, so this is the check that asks where
   * it actually lands: on the far side of the face from the mark, and inside the circle a
   * `rounded-full` wrapper clips to.
   */
  test("the star sits on the head, clear of the blocked mark's corner", () => {
    /** Half the star's own height, plus its stroke — how far it reaches from its anchor. */
    const REACH = 9.75;
    for (let shape = 0; shape < BOT_AVATAR_SHAPES.length; shape += 1) {
      const html = render(
        botAvatarSeed({ shape, palette: 3, eyes: 1, accessory: 6 }),
        96,
      );
      const placed = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(html);
      expect(placed).not.toBeNull();
      const x = Number(placed?.[1]);
      const y = Number(placed?.[2]);
      const body = BOT_AVATAR_SHAPES[
        shape
      ] as (typeof BOT_AVATAR_SHAPES)[number];
      // Left of centre: the top right is where `bot-avatar-mark` is drawn on a blocked Bot.
      expect(x).toBeLessThan(48);
      // Above the eyes, in the headroom the bodies leave for exactly this.
      expect(y).toBeLessThan(body.eyeY - 20);
      // Not clipped away by the screens that wrap a face in `rounded-full overflow-hidden`.
      expect(Math.hypot(x - 48, y - 48) + REACH).toBeLessThanOrEqual(48);
    }
  });

  test("is hidden from a screen reader, which the name beside it is not", () => {
    expect(render("f:0.0.0.0", 36)).toContain('aria-hidden="true"');
  });

  test("stops moving below 28 pixels and moves at or above it", () => {
    // The floor is not decoration: six 20px avatars animating in a header read as a page that is
    // broken, and the state is unreadable at that size anyway.
    expect(render("f:0.0.0.0", 20, "working")).not.toContain("data-bot-state");
    expect(render("f:0.0.0.0", 27, "working")).not.toContain("data-bot-state");
    expect(render("f:0.0.0.0", 28, "working")).toContain(
      'data-bot-state="working"',
    );
  });

  test("still says a Bot is blocked at a size that cannot animate", () => {
    // The raised brows and the mark are drawn, not animated, so the one state with something urgent
    // to say survives the floor above and `prefers-reduced-motion` alike.
    const small = render("f:0.0.0.0", 20, "blocked");
    expect(small).toContain("#ff9f2e");
    expect(render("f:0.0.0.0", 20, "idle")).not.toContain("#ff9f2e");
  });

  test("gives each face its own clip id, or one silhouette swallows the page", () => {
    // Two avatars sharing `url(#id)` puts every face on the page inside the first one's outline.
    const pair = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(BotAvatar, { key: "a", seed: "f:0.0.0.0", size: 36 }),
        createElement(BotAvatar, { key: "b", seed: "f:3.5.2.1", size: 36 }),
      ),
    );
    const ids = [...pair.matchAll(/<clipPath id="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  test("carries one of the five idle phases, so a roster does not blink in unison", () => {
    expect(render("f:0.0.0.0", 36)).toMatch(/bot-avatar-phase-[0-4]/);
  });
});

describe("the picker's words", () => {
  test("every option a person can read has Korean", () => {
    // `t(option.name)` is invisible to `i18n-coverage.test.ts`, the same blind spot the presets
    // have. Four tables, walked.
    const missing: string[] = [];
    for (const table of [
      BOT_AVATAR_SHAPES,
      BOT_AVATAR_PALETTES,
      BOT_AVATAR_EYES,
      BOT_AVATAR_ACCESSORIES,
    ]) {
      for (const option of table) {
        if (!(option.name in ko)) missing.push(option.name);
      }
    }
    expect(missing).toEqual([]);
  });

  test("no two options in a table share a name", () => {
    for (const table of [
      BOT_AVATAR_SHAPES,
      BOT_AVATAR_PALETTES,
      BOT_AVATAR_EYES,
      BOT_AVATAR_ACCESSORIES,
    ]) {
      const names = table.map((option) => option.name);
      expect(new Set(names).size).toBe(names.length);
      const ids = table.map((option) => option.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("the geometry", () => {
  /**
   * Points ON a body's outline, not the numbers in its path data.
   *
   * The first version of the check below read the path as a list of coordinate pairs, which is
   * wrong twice over: `H` and `V` carry one number each and shift every pair after them, and a
   * cubic's control points sit outside the curve they bend — so it failed on five bodies that were
   * all comfortably inside. Evaluating the curves is the only honest way to ask where a shape
   * actually goes.
   */
  const outlineOf = (d: string): [number, number][] => {
    const tokens = d.match(/[MLHVCQZ]|-?\d+(?:\.\d+)?/g) ?? [];
    const points: [number, number][] = [];
    let index = 0;
    let x = 0;
    let y = 0;
    let startX = 0;
    let startY = 0;
    const next = () => Number(tokens[index++]);
    const sample = (at: (t: number) => [number, number]) => {
      for (let step = 1; step <= 16; step += 1) points.push(at(step / 16));
    };

    while (index < tokens.length) {
      switch (tokens[index++]) {
        case "M":
          x = next();
          y = next();
          startX = x;
          startY = y;
          points.push([x, y]);
          break;
        case "L":
          x = next();
          y = next();
          points.push([x, y]);
          break;
        case "H":
          x = next();
          points.push([x, y]);
          break;
        case "V":
          y = next();
          points.push([x, y]);
          break;
        case "C": {
          const [x1, y1, x2, y2, ex, ey] = [
            next(),
            next(),
            next(),
            next(),
            next(),
            next(),
          ];
          const [fromX, fromY] = [x, y];
          sample((t) => {
            const u = 1 - t;
            return [
              u ** 3 * fromX +
                3 * u * u * t * x1 +
                3 * u * t * t * x2 +
                t ** 3 * ex,
              u ** 3 * fromY +
                3 * u * u * t * y1 +
                3 * u * t * t * y2 +
                t ** 3 * ey,
            ];
          });
          x = ex;
          y = ey;
          break;
        }
        case "Q": {
          const [x1, y1, ex, ey] = [next(), next(), next(), next()];
          const [fromX, fromY] = [x, y];
          sample((t) => {
            const u = 1 - t;
            return [
              u * u * fromX + 2 * u * t * x1 + t * t * ex,
              u * u * fromY + 2 * u * t * y1 + t * t * ey,
            ];
          });
          x = ex;
          y = ey;
          break;
        }
        default:
          x = startX;
          y = startY;
      }
    }
    return points;
  };

  /**
   * EVERY BODY FITS INSIDE THE INSCRIBED CIRCLE.
   *
   * Half the screens in this app wrap an avatar in `rounded-full overflow-hidden`, and they are
   * entitled to: it is what a roster of round avatars looks like. 48 is not a margin somebody
   * chose, it is where that clip actually falls — half of a 96-unit box — so an outline past it is
   * a shape with a bite taken out, invisible on the screen it was designed against and obvious on
   * the one it was not.
   */
  test("no body reaches past the circle a rounded-full wrapper clips to", () => {
    const outside: string[] = [];
    for (const shape of BOT_AVATAR_SHAPES) {
      for (const [x, y] of outlineOf(shape.d)) {
        const radius = Math.hypot(x - 48, y - 48);
        if (radius > 48) outside.push(`${shape.id}: ${radius.toFixed(1)}`);
      }
    }
    expect(outside).toEqual([]);
  });

  /**
   * AND EVERY BODY IS BIG ENOUGH TO BE ONE.
   *
   * The bound above has a trivial way to pass — draw everything tiny — which would give a roster of
   * six faces floating in the middle of their own boxes. This is the other half: each body has to
   * reach at least most of the way out.
   */
  test("no body is so small it floats in the middle of its box", () => {
    for (const shape of BOT_AVATAR_SHAPES) {
      const reach = Math.max(
        ...outlineOf(shape.d).map(([x, y]) => Math.hypot(x - 48, y - 48)),
      );
      expect(reach).toBeGreaterThan(36);
    }
  });

  test("every body is one closed path with no lowercase (relative) commands", () => {
    for (const shape of BOT_AVATAR_SHAPES) {
      expect(shape.d).toMatch(/^M/);
      expect(shape.d).toMatch(/Z$/);
      expect(shape.d).not.toMatch(/[a-z]/);
    }
  });

  test("the eyes sit inside the head, not on the edge of the box", () => {
    for (const shape of BOT_AVATAR_SHAPES) {
      expect(shape.eyeGap).toBeGreaterThan(14);
      expect(shape.eyeY).toBeGreaterThan(shape.crownY + 20);
      expect(shape.eyeY).toBeLessThan(80);
    }
  });

  test("every palette is six hex digits, and the ink is darker than the body", () => {
    const luminance = (hex: string): number => {
      const value = Number.parseInt(hex.slice(1), 16);
      // Rough, and enough: the question is only "is one of these clearly the dark one".
      return (
        ((value >> 16) & 255) * 0.299 +
        ((value >> 8) & 255) * 0.587 +
        (value & 255) * 0.114
      );
    };
    for (const palette of BOT_AVATAR_PALETTES) {
      for (const colour of [
        palette.fill,
        palette.shade,
        palette.accent,
        palette.ink,
      ]) {
        expect(colour).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(luminance(palette.ink)).toBeLessThan(luminance(palette.shade));
      expect(luminance(palette.shade)).toBeLessThan(luminance(palette.fill));
      /*
       * MID-LIGHT, ON PURPOSE. The app's ground is #fcfcfc in one theme and #070707 in the other,
       * and a face has to be legible on both without being repainted — so nothing here may be so
       * pale it disappears in light mode or so dark it disappears in dark mode.
       */
      expect(luminance(palette.fill)).toBeGreaterThan(120);
      expect(luminance(palette.fill)).toBeLessThan(230);
    }
  });
});
