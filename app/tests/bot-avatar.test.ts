import { describe, expect, test } from "bun:test";
import {
  BOT_AVATAR_PALETTES,
  BOT_AVATAR_SHAPES,
  botAvatarBackground,
  botAvatarParams,
  botAvatarSeed,
  DEFAULT_SHAPE_IDS,
  dealColor,
  dealShape,
  randomBotAvatarSeed,
  SHAPE_IDS,
} from "../src/lib/avatar/bot-avatar";
import {
  createAvatarEngine,
  DEFAULT_TUNE,
  ENGINE_STATES,
  type EngineElements,
  type EngineState,
  tuneFor,
} from "../src/lib/avatar/grok-engine";
import {
  blendEye,
  EXPRESSIONS,
  eyeHalfWidth,
  eyePath,
  REFERENCE,
  stadiumPoints,
} from "../src/lib/avatar/grok-eyes";
import { bodyShape, CENTRE, flattenPath } from "../src/lib/avatar/grok-shapes";

/**
 * THE FACE, MEASURED.
 *
 * Three layers, three kinds of promise. The seed grammar: every string is a face, a chosen face
 * survives a round trip, an old seed keeps its colour. The bodies: eighteen paths that are the size
 * they claim, centred, and that know where their own skin is. The engine: a frame loop that a test
 * can step by hand — no waiting on real frames — and that never writes NaN into the DOM.
 */

const inRange = (params: { shape: string; palette: string }) =>
  (SHAPE_IDS as readonly string[]).includes(params.shape) &&
  BOT_AVATAR_PALETTES.some((colour) => colour.id === params.palette);

describe("the seed grammar", () => {
  test("every body and colour round-trips through a seed", () => {
    for (const shape of BOT_AVATAR_SHAPES) {
      for (const colour of BOT_AVATAR_PALETTES) {
        const seed = botAvatarSeed({ shape: shape.id, palette: colour.id });
        expect(botAvatarParams(seed)).toEqual({
          shape: shape.id,
          palette: colour.id,
        });
      }
    }
    expect(BOT_AVATAR_SHAPES.length).toBe(18);
    expect(BOT_AVATAR_PALETTES.length).toBe(10);
  });

  test("the eight default bodies lead the picker's row", () => {
    expect(BOT_AVATAR_SHAPES.slice(0, 8).map((shape) => shape.id)).toEqual([
      ...DEFAULT_SHAPE_IDS,
    ]);
  });

  /**
   * THE FACES THAT CAME BEFORE KEEP THEIR COLOUR. The numbered grammars named a palette by
   * position; the position maps onto the nearest of Grok's colours, so a Bot that was violet
   * yesterday is violet today. Its body lands on one of the eight defaults by the same position.
   */
  test("a numbered seed maps onto a named one", () => {
    expect(botAvatarParams("f:0.5.0.1")).toEqual({
      shape: "blob",
      palette: "violet",
    });
    expect(botAvatarParams("g:2.4.1")).toEqual({
      shape: "squircle",
      palette: "blue",
    });
    expect(botAvatarParams("f:999.999.999.999")).toEqual(
      botAvatarParams("f:999.999.999.999"),
    );
    expect(inRange(botAvatarParams("f:999.999.999.999"))).toBe(true);
  });

  test("anything else is dealt a face, the way Grok deals one, and always the same one", () => {
    const seeds = ["r4c5", "", "고양이", "bot-01", "Sandy", undefined];
    for (const seed of seeds) {
      const params = botAvatarParams(seed);
      expect(inRange(params)).toBe(true);
      expect(botAvatarParams(seed)).toEqual(params);
      expect(DEFAULT_SHAPE_IDS).toContain(params.shape);
    }
    expect(dealShape("Sandy")).toBe(botAvatarParams("Sandy").shape);
    expect(dealColor("Sandy")).toBe(botAvatarParams("Sandy").palette);
    expect(botAvatarParams("s:blob.black").palette).not.toBe("black");
  });

  test("a hundred names do not all land on the same face", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      seen.add(botAvatarSeed(botAvatarParams(`bot-${index}`)));
    }
    expect(seen.size).toBeGreaterThan(30);
  });

  test("the shuffle is deterministic under an injected generator and never out of range", () => {
    const sequence = () => {
      const values = [0.1, 0.6, 0.3, 0.9];
      let at = 0;
      return () => values[at++ % values.length] as number;
    };
    expect(randomBotAvatarSeed(sequence())).toBe(
      randomBotAvatarSeed(sequence()),
    );
    expect(inRange(botAvatarParams(randomBotAvatarSeed(() => 1)))).toBe(true);
    expect(inRange(botAvatarParams(randomBotAvatarSeed(() => 0)))).toBe(true);
  });

  test("the background is the colour's light value", () => {
    expect(botAvatarBackground("s:cloud.green")).toBe("#00C972");
    expect(botAvatarBackground(undefined)).toMatch(/^#[0-9A-F]{6}$/);
  });
});

describe("the bodies", () => {
  test("every body is centred and spans the canvas", () => {
    for (const id of SHAPE_IDS) {
      const shape = bodyShape(id);
      const points = flattenPath(shape.path);
      expect(points.length).toBeGreaterThan(20);
      let minX = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const [x, y] of points) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      const span = Math.max(maxX - minX, maxY - minY);
      expect(Math.abs(span - 228.44)).toBeLessThan(2.5);
      expect(Math.abs((minX + maxX) / 2 - CENTRE)).toBeLessThan(1.5);
      expect(Math.abs((minY + maxY) / 2 - CENTRE)).toBeLessThan(1.5);
      expect(shape.top).toBeLessThan(shape.bottom);
      expect(shape.radius).toBeGreaterThan(100);
      expect(shape.path).not.toContain("NaN");
    }
  });

  test("a body knows its own width on every row, and the face sits inside it", () => {
    for (const id of SHAPE_IDS) {
      const shape = bodyShape(id);
      const y = CENTRE + shape.face.y;
      const [left, right] = shape.spanAt(y);
      expect(left).toBeLessThan(CENTRE + shape.face.x);
      expect(right).toBeGreaterThan(CENTRE + shape.face.x);
      expect(shape.face.sx).toBeGreaterThanOrEqual(0.3);
      expect(shape.face.sx).toBeLessThanOrEqual(1);
      expect(shape.face.eye).toBeGreaterThanOrEqual(0.64);
      expect(shape.face.eye).toBeLessThanOrEqual(1);
      expect(shape.tiltScale).toBeGreaterThanOrEqual(0.15);
      expect(shape.tiltScale).toBeLessThanOrEqual(1);
    }
  });

  test("the wedge's left eye is nudged away from the apex", () => {
    expect(bodyShape("wedge").face.leftDX).toBe(-6);
    expect(bodyShape("blob").face.leftDX).toBe(0);
  });
});

describe("the eyes", () => {
  test("twenty-five expressions, each a pair of slits with a size", () => {
    expect(EXPRESSIONS.length).toBe(25);
    for (const pair of EXPRESSIONS) {
      for (const eye of pair) {
        expect(eye.halfLen).toBeGreaterThan(0);
        expect(eye.halfW).toBeGreaterThan(0);
        expect(eye.halfLen).toBeGreaterThanOrEqual(eye.halfW - 0.01);
      }
    }
  });

  test("a stadium is symmetric about its centre and as long as it says", () => {
    const points = stadiumPoints(0, 20, 6);
    expect(points.length).toBe(48);
    const maxX = Math.max(...points.map(([x]) => x));
    const maxY = Math.max(...points.map(([, y]) => y));
    expect(Math.abs(maxX - 20)).toBeLessThan(0.5);
    expect(Math.abs(maxY - 6)).toBeLessThan(0.5);
    const upright = stadiumPoints(90, 20, 6);
    expect(Math.max(...upright.map(([, y]) => y))).toBeGreaterThan(19);
    expect(
      eyeHalfWidth({ cx: 0, cy: 0, angle: 90, halfLen: 20, halfW: 6 }),
    ).toBeLessThan(7);
  });

  test("a blend goes the short way round and keeps the slit's straight part", () => {
    const from = { cx: 0, cy: 0, angle: 170, halfLen: 20, halfW: 5 };
    const to = { cx: 10, cy: 4, angle: 10, halfLen: 30, halfW: 10 };
    const half = blendEye(from, to, 0.5);
    // 170° to 10° is a 20° turn through 180°, not a 160° swing back through 90°.
    expect(Math.abs(((half.angle % 180) + 180) % 180)).toBeCloseTo(0, 0);
    expect(half.halfW).toBeCloseTo(7.5, 5);
    expect(half.halfLen).toBeCloseTo(7.5 + (15 + 20) / 2, 5);
    expect(blendEye(from, to, 0)).toBe(from);
    expect(blendEye(from, to, 1)).toBe(to);
  });

  test("an eye path is a closed polygon with no script in it", () => {
    const path = eyePath(REFERENCE[0]);
    expect(path.startsWith("M")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
    expect(path).not.toMatch(/[<>]/);
  });
});

/** A DOM stand-in the engine can write attributes into, so a frame's output can be read back. */
class FakeElement {
  attributes = new Map<string, string>();
  style = { display: "" };
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
}

const fakeElements = (): EngineElements & { all: FakeElement[] } => {
  const body = new FakeElement();
  const left = new FakeElement();
  const right = new FakeElement();
  const badge = new FakeElement();
  return {
    body: body as unknown as SVGGElement,
    eyes: [
      left as unknown as SVGPathElement,
      right as unknown as SVGPathElement,
    ],
    badge: badge as unknown as SVGCircleElement,
    all: [body, left, right, badge],
  };
};

const noNaN = (elements: { all: FakeElement[] }) => {
  for (const element of elements.all) {
    for (const [name, value] of element.attributes) {
      expect(`${name}=${value}`).not.toContain("NaN");
      expect(`${name}=${value}`).not.toContain("Infinity");
    }
  }
};

/** A deterministic random so a run is the same run twice. */
const seededRandom = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
};

describe("the engine", () => {
  test("every mood can be stepped for ten seconds without writing a bad number", () => {
    for (const state of ENGINE_STATES) {
      const elements = fakeElements();
      let clock = 0;
      const engine = createAvatarEngine({
        shape: bodyShape("blob"),
        state,
        elements,
        reduceMotion: false,
        now: () => clock,
        random: seededRandom(7),
        raf: () => 0,
        caf: () => {},
      });
      for (let frame = 0; frame < 600; frame += 1) {
        clock += 16.7;
        engine.frame(clock);
      }
      noNaN(elements);
      expect(elements.body.getAttribute("transform")).toMatch(/^translate\(/);
      expect(elements.eyes[0].getAttribute("d")).toMatch(/^M.*Z$/);
    }
  });

  test("the eyes are cut from the body and stay inside it whatever the shape", () => {
    for (const id of SHAPE_IDS) {
      const shape = bodyShape(id);
      const elements = fakeElements();
      let clock = 0;
      const engine = createAvatarEngine({
        shape,
        state: "searching",
        elements,
        reduceMotion: false,
        now: () => clock,
        random: seededRandom(3),
        raf: () => 0,
        caf: () => {},
      });
      for (let frame = 0; frame < 300; frame += 1) {
        clock += 16.7;
        engine.frame(clock);
        for (const eye of elements.eyes) {
          const transform = eye.getAttribute("transform") ?? "";
          const match = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(transform);
          expect(match).not.toBeNull();
          const x = Number.parseFloat((match as RegExpExecArray)[1] as string);
          const y = Number.parseFloat((match as RegExpExecArray)[2] as string);
          expect(y).toBeGreaterThanOrEqual(shape.top);
          expect(y).toBeLessThanOrEqual(shape.bottom);
          const [left, right] = shape.spanAt(y);
          expect(x).toBeGreaterThanOrEqual(left - 30);
          expect(x).toBeLessThanOrEqual(right + 30);
        }
      }
    }
  });

  test("a blink closes the eyes and opens them again", () => {
    const elements = fakeElements();
    let clock = 0;
    const engine = createAvatarEngine({
      shape: bodyShape("pebble"),
      state: "idle",
      elements,
      reduceMotion: false,
      now: () => clock,
      random: seededRandom(11),
      raf: () => 0,
      caf: () => {},
    });
    const heights: number[] = [];
    for (let frame = 0; frame < 120; frame += 1) {
      clock += 8;
      engine.frame(clock);
      const transform = elements.eyes[0].getAttribute("transform") ?? "";
      const match = /scale\(([-\d.]+) ([-\d.]+)\)/.exec(transform);
      heights.push(Number.parseFloat((match as RegExpExecArray)[2] as string));
    }
    // Idle opens with a blink: the eye's height dips well under its open value and recovers.
    const open = Math.max(...heights);
    const shut = Math.min(...heights);
    expect(shut).toBeLessThan(open * 0.5);
    expect(heights[heights.length - 1]).toBeGreaterThan(open * 0.8);
  });

  test("a spin carries an eye behind the body and hides it there", () => {
    const elements = fakeElements();
    let clock = 0;
    const engine = createAvatarEngine({
      shape: bodyShape("blob"),
      state: "idle",
      elements,
      reduceMotion: false,
      now: () => clock,
      random: seededRandom(5),
      raf: () => 0,
      caf: () => {},
    });
    engine.frame(16);
    engine.spin(1);
    let hidden = false;
    for (let frame = 0; frame < 200; frame += 1) {
      clock += 16.7;
      engine.frame(clock);
      if (
        elements.eyes.some(
          (eye) => (eye as unknown as FakeElement).style.display === "none",
        )
      ) {
        hidden = true;
      }
    }
    expect(hidden).toBe(true);
    expect(
      elements.eyes.every(
        (eye) => (eye as unknown as FakeElement).style.display === "",
      ),
    ).toBe(true);
  });

  test("a Bot that has stopped to ask grows a badge, and loses it when it is answered", () => {
    const elements = fakeElements();
    let clock = 0;
    const engine = createAvatarEngine({
      shape: bodyShape("cloud"),
      state: "notifying",
      elements,
      reduceMotion: false,
      now: () => clock,
      random: seededRandom(2),
      raf: () => 0,
      caf: () => {},
    });
    for (let frame = 0; frame < 120; frame += 1) {
      clock += 16.7;
      engine.frame(clock);
    }
    const badge = elements.badge as unknown as FakeElement;
    expect(badge.style.display).toBe("");
    expect(Number.parseFloat(badge.getAttribute("r") ?? "0")).toBeGreaterThan(
      10,
    );
    engine.setState("idle");
    for (let frame = 0; frame < 240; frame += 1) {
      clock += 16.7;
      engine.frame(clock);
    }
    expect(badge.getAttribute("visibility")).toBe("hidden");
  });

  test("reduced motion draws one still frame in the mood's opening expression", () => {
    const elements = fakeElements();
    let frames = 0;
    const engine = createAvatarEngine({
      shape: bodyShape("hex"),
      state: "sleeping",
      elements,
      reduceMotion: true,
      now: () => 1000,
      random: seededRandom(1),
      raf: () => {
        frames += 1;
        return 1;
      },
      caf: () => {},
    });
    engine.start();
    expect(frames).toBe(0);
    expect(elements.body.getAttribute("transform")).toContain("rotate(0.00)");
    expect(elements.eyes[0].getAttribute("d")).toMatch(/^M/);
    noNaN(elements);
  });

  test("a mood's tune stays within the bounds Grok gives it", () => {
    for (const state of ENGINE_STATES) {
      const tune = tuneFor(state as EngineState, DEFAULT_TUNE);
      expect(tune.size).toBeGreaterThan(0);
      expect(tune.gap).toBeGreaterThan(0);
      if (state !== "idle" && state !== "working") {
        expect(tune.size).toBeLessThanOrEqual(0.92);
        expect(tune.gap).toBeGreaterThanOrEqual(1.14);
      }
    }
    expect(tuneFor("working", DEFAULT_TUNE).size).toBeGreaterThan(
      DEFAULT_TUNE.size,
    );
  });
});
