/**
 * How a face moves: the animation engine behind `BotAvatar`, ported from Grok Bot's.
 *
 * WHY A FRAME LOOP AND NOT KEYFRAMES. The first generated avatar animated with CSS: a bob, a blink,
 * a glance, four rules. It looked like a screensaver. What makes Grok's Bots read as ALIVE is that
 * nothing repeats: every value on the face is a damped spring chasing a target, the targets are
 * re-drawn from ranges on their own random timers, an expression is a blend between two pairs of
 * eyes rather than a swap, a blink is a five-keyframe event on a schedule, and a spin carries the
 * eyes around the body like marks on a globe. None of that is expressible as a keyframe.
 *
 * Every constant here is Grok's (read from its 0.30.0 bundle on 2026-09-06): the spring stiffness
 * and damping per channel, the ranges each mood draws its rotation, shift, squash and gaze from,
 * the intervals between expression changes and blinks, the gesture choreography. The states this
 * app drives are five (`sleeping`, `idle`, `working`, `notifying`, `happy`); the rest of Grok's
 * moods are kept because the picker and the tests can show them and because a future surface will
 * want `thinking` and `celebrate` the moment it can tell them apart.
 *
 * Time comes in from outside (`now`, `raf`) so a test can step a face by hand and assert what a
 * frame did, without waiting for one.
 */

import {
  alignTo,
  blendEye,
  capTo,
  EXPRESSIONS,
  type Expression,
  type Eye,
  eyeHalfWidth,
  eyePath,
  matchRight,
  REFERENCE,
  widenTo,
} from "./grok-eyes";
import { type BodyShape, CENTRE } from "./grok-shapes";

export const ENGINE_STATES = [
  "sleeping",
  "waking",
  "idle",
  "listening",
  "thinking",
  "searching",
  "working",
  "excited",
  "surprised",
  "suspicious",
  "angry",
  "drowsy",
  "happy",
  "curious",
  "confused",
  "bored",
  "proud",
  "shy",
  "sad",
  "laughing",
  "scared",
  "playful",
  "celebrate",
  "notifying",
  "humming",
] as const;

export type EngineState = (typeof ENGINE_STATES)[number];

export const isEngineState = (value: string): value is EngineState =>
  (ENGINE_STATES as readonly string[]).includes(value);

/** Which expressions a mood cycles through; the first is the one it opens with. */
const EXPRESSION_SETS: Record<EngineState, readonly number[]> = {
  sleeping: [13, 22, 4],
  waking: [13],
  idle: [0, 8],
  listening: [10, 1, 19],
  thinking: [8, 16, 14, 17, 5],
  searching: [15, 9, 3, 20, 12, 18],
  working: [7, 16, 11, 10],
  excited: [2, 17, 21, 3, 11],
  surprised: [3, 21],
  suspicious: [14, 5, 23],
  angry: [7, 16],
  drowsy: [4, 22, 13],
  happy: [2, 11, 17, 19],
  curious: [3, 21, 0, 15],
  confused: [14, 5, 8],
  bored: [4, 22, 0],
  proud: [15, 8, 2],
  shy: [0, 24, 13],
  sad: [4, 13, 22],
  laughing: [2, 11, 17],
  scared: [3, 21],
  playful: [2, 17, 11, 8],
  celebrate: [2, 8, 17],
  notifying: [3, 21, 0],
  humming: [0, 8],
};

/** Milliseconds between one expression and the next, as a range. */
const EXPRESSION_INTERVALS: Record<EngineState, [number, number]> = {
  sleeping: [6000, 10000],
  waking: [800, 800],
  idle: [9000, 16000],
  listening: [2800, 5000],
  thinking: [2000, 3600],
  searching: [1000, 1800],
  working: [1800, 3200],
  excited: [1100, 2000],
  surprised: [2500, 4000],
  suspicious: [2600, 4500],
  angry: [2200, 3800],
  drowsy: [4000, 8000],
  happy: [2500, 4500],
  curious: [1800, 3200],
  confused: [2200, 3800],
  bored: [3500, 6000],
  proud: [3500, 6000],
  shy: [3000, 5500],
  sad: [4000, 7000],
  laughing: [1200, 2400],
  scared: [900, 1800],
  playful: [1500, 3000],
  celebrate: [1400, 2600],
  notifying: [1500, 2600],
  humming: [5000, 9000],
};

/** Milliseconds between blinks, or null for the moods whose eyes are shut or fixed. */
const BLINK_INTERVALS: Record<EngineState, [number, number] | null> = {
  sleeping: null,
  waking: null,
  idle: [6000, 14000],
  listening: [3000, 7000],
  thinking: [3500, 7000],
  searching: [1600, 4000],
  working: [2800, 5500],
  excited: [2000, 4000],
  surprised: [1800, 3500],
  suspicious: [4500, 8000],
  angry: [3500, 7000],
  drowsy: null,
  happy: [2500, 5000],
  curious: [2500, 5500],
  confused: [2800, 5500],
  bored: [4000, 8000],
  proud: [3500, 7000],
  shy: [3000, 6000],
  sad: [4000, 8000],
  laughing: [2500, 5000],
  scared: [1200, 3000],
  playful: [2000, 4500],
  celebrate: [2200, 4500],
  notifying: [2000, 4000],
  humming: [4000, 8000],
};

export type FaceTune = {
  size: number;
  gap: number;
  height: number;
  eyeWidth: number;
  eyeHeight: number;
};

/** The tune a face is drawn with before any mood touches it. */
export const DEFAULT_TUNE: FaceTune = {
  size: 0.86,
  gap: 1.18,
  height: 1,
  eyeWidth: 0.96,
  eyeHeight: 0.92,
};

const MOOD_TUNE: Partial<Record<EngineState, Partial<FaceTune>>> = {
  angry: { gap: 1.28, size: 0.78, eyeWidth: 0.88, eyeHeight: 0.84 },
  suspicious: { gap: 1.24, size: 0.82, eyeWidth: 0.9 },
  confused: { gap: 1.2, size: 0.84, eyeWidth: 0.9 },
  scared: { size: 0.8, eyeWidth: 0.9, eyeHeight: 0.88 },
  surprised: { size: 0.76, eyeWidth: 0.86, eyeHeight: 0.86 },
  excited: { size: 0.78, eyeWidth: 0.88, eyeHeight: 0.88 },
  celebrate: { size: 0.74, eyeWidth: 0.84, eyeHeight: 0.84 },
  happy: { size: 0.76, eyeWidth: 0.86, eyeHeight: 0.84 },
  curious: { size: 0.84 },
  drowsy: { size: 0.92, eyeWidth: 0.96 },
  bored: { size: 0.92, eyeWidth: 0.96 },
  sad: { size: 0.92, eyeWidth: 0.96 },
  playful: { size: 0.84, gap: 1.2 },
};

const WORKING_TUNE = { size: 1.05, eyeWidth: 1.12, eyeHeight: 1.02 };
const MOOD_GAP_FLOOR = 1.14;
const MOOD_SIZE_CEILING = 0.92;

/** The tune a mood asks for, starting from what the face was given. */
export function tuneFor(state: EngineState, base: FaceTune): FaceTune {
  if (state === "idle") return base;
  if (state === "working") {
    return {
      ...base,
      size: base.size * WORKING_TUNE.size,
      eyeWidth: base.eyeWidth * WORKING_TUNE.eyeWidth,
      eyeHeight: base.eyeHeight * WORKING_TUNE.eyeHeight,
    };
  }
  const mood = MOOD_TUNE[state];
  return {
    size: Math.min(mood?.size ?? base.size, MOOD_SIZE_CEILING),
    gap: Math.max(mood?.gap ?? base.gap, MOOD_GAP_FLOOR),
    height: mood?.height ?? base.height,
    eyeWidth: Math.min(mood?.eyeWidth ?? base.eyeWidth, 1),
    eyeHeight: Math.min(mood?.eyeHeight ?? base.eyeHeight, 1),
  };
}

const HEAVY_LIDS = new Set<EngineState>(["drowsy", "bored", "sad"]);
const WIDENED = new Set<EngineState>(["suspicious", "confused", ...HEAVY_LIDS]);
const GESTURING = new Set<EngineState>(["happy", "excited", "proud"]);
const PLAYFUL = new Set<EngineState>(["playful"]);
const WINKING = new Set<EngineState>([
  "idle",
  "happy",
  "excited",
  "curious",
  "playful",
]);
const HEAVY_LID_FLOOR = 0.8;
const WIDEN_TO = 8.6;

/** A damped spring: `x` chases `t`, `v` is its velocity. */
type Spring = { x: number; v: number; t: number };
const spring = (at: number): Spring => ({ x: at, v: 0, t: at });
const step = (s: Spring, stiffness: number, damping: number, dt: number) => {
  s.v +=
    (-2 * damping * stiffness * s.v - stiffness * stiffness * (s.x - s.t)) * dt;
  s.x += s.v * dt;
  if (!Number.isFinite(s.x) || !Number.isFinite(s.v)) {
    s.x = s.t;
    s.v = 0;
  }
};

const SUBSTEP = 1 / 120;
/** A gap between frames longer than this means the tab was hidden, not that a frame was slow. */
const RESUME_AFTER_MS = 1500;
const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));
const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const smooth = (t: number) => t * t * (3 - 2 * t);
/** A per-frame lerp factor that lands at `fraction` per 60th of a second whatever the frame rate. */
const perFrame = (fraction: number, dt: number) =>
  1 - Math.exp(Math.log(1 - fraction) * 60 * dt);

/** The four bounces of a dropped ball: height in units, duration in seconds. */
const BOUNCES = [
  { h: 48, d: 0.5 },
  { h: 28, d: 0.382 },
  { h: 14, d: 0.27 },
  { h: 6, d: 0.177 },
];
const BOUNCE_TOTAL = BOUNCES.reduce((sum, bounce) => sum + bounce.d, 0);

type SpinKind = "spinBounce" | "spinDizzy" | "spinWild";
type Gesture = { kind: SpinKind; t0: number; dir: 1 | -1; turns: number };

export type EngineElements = {
  body: SVGGElement;
  eyes: [SVGPathElement, SVGPathElement];
  badge: SVGCircleElement | null;
};

export type EngineOptions = {
  shape: BodyShape;
  state: EngineState;
  elements: EngineElements;
  reduceMotion: boolean;
  tune?: FaceTune;
  now?: () => number;
  random?: () => number;
  raf?: (callback: (time: number) => void) => number;
  caf?: (handle: number) => void;
};

export type AvatarEngine = {
  setState: (state: EngineState) => void;
  setShape: (shape: BodyShape) => void;
  setPaused: (paused: boolean) => void;
  spin: (turns?: number) => void;
  bounce: () => void;
  /** Advance to `time` and draw. Public for tests; the loop calls it on every frame. */
  frame: (time: number) => void;
  start: () => void;
  stop: () => void;
};

export function createAvatarEngine(options: EngineOptions): AvatarEngine {
  const now = options.now ?? (() => performance.now());
  const random = options.random ?? Math.random;
  const raf = options.raf ?? ((callback) => requestAnimationFrame(callback));
  const caf = options.caf ?? ((handle) => cancelAnimationFrame(handle));
  const between = (low: number, high: number) => low + random() * (high - low);
  const flip = (): 1 | -1 => (random() < 0.5 ? -1 : 1);
  const { elements } = options;
  const reduceMotion = options.reduceMotion;
  const baseTune = options.tune ?? DEFAULT_TUNE;

  let shape = options.shape;
  let state = options.state;
  let stateSince = now();
  let paused = false;
  let handle = 0;
  let lastFrame = now();
  const born = now();

  // The face: what it shows now, what it is turning into, and how far along it is.
  let shown: Expression = REFERENCE;
  let target: Expression = REFERENCE;
  const morph = spring(1);
  let morphStiffness = 7;
  let expression = -1;
  let cycle = 0;

  // Body channels: rotation (degrees), x shift, y shift, vertical squash.
  const rotation = spring(0);
  const shiftX = spring(0);
  const shiftY = spring(0);
  const squash = spring(1);
  // Eye channels: openness, scale, gaze.
  const openness = spring(1);
  const eyeScale = spring(1);
  const gazeX = spring(0);
  const gazeY = spring(0);
  // The badge for a Bot that has stopped to ask.
  const badge = spring(0);

  let tune: FaceTune = tuneFor(state, baseTune);

  // Schedules.
  let previousState: EngineState | null = null;
  let nextExpressionAt = 0;
  let nextBlinkAt = 0;
  let nextSpinAt = 0;
  let moodTimerAt = 0;
  let secondTimerAt = 0;
  let sequenceStartedAt = 0;
  let nextGazeAt = 0;
  let nextWinkAt = 0;
  let winkStartedAt = -1e9;
  let winkingEye = 0;
  let nextGestureAt = born + between(2500, 5000);
  let celebrateSpinAt = 0;
  let angryUntil = 0;
  let beatIndex = -1;
  let blinks: { at: number; v: number }[] = [];
  let resumedAt: number | null = null;

  // Gestures.
  let spinner: Spring | null = null;
  let gesture: Gesture | null = null;
  let bounceStartedAt = -1;

  const scheduleBlink = (at: number) => {
    blinks.push(
      { at, v: 0.05 },
      { at: at + 70, v: 0.05 },
      { at: at + 150, v: 1.08 },
      { at: at + 300, v: 1 },
    );
    if (random() < 0.14)
      blinks.push({ at: at + 370, v: 0.05 }, { at: at + 480, v: 1 });
  };

  const spinOnce = (turns = 1, dir: 1 | -1 = flip()) => {
    if (paused || spinner) return;
    spinner = { x: 0, v: 0, t: turns * Math.PI * 2 * dir };
  };

  const bounceOnce = () => {
    if (reduceMotion || bounceStartedAt >= 0 || paused) return;
    bounceStartedAt = now();
  };

  const startGesture = (kind: SpinKind) => {
    if (reduceMotion || gesture || paused) return;
    const turns =
      kind === "spinDizzy"
        ? Math.round(between(3, 4))
        : kind === "spinWild"
          ? 9
          : 1;
    gesture = { kind, t0: now(), dir: flip(), turns };
  };

  /** Turn toward expression `index`, blending from wherever the face is now. */
  const show = (index: number, stiffness = 7) => {
    if (index === expression && morph.t === 1) return;
    const along = clamp(morph.x, 0, 1);
    shown = [
      blendEye(shown[0], target[0], along),
      blendEye(shown[1], target[1], along),
    ];
    let pair = EXPRESSIONS[index] as Expression;
    if (state === "working") {
      if (EXPRESSION_SETS.angry.includes(index))
        pair = alignTo(pair, REFERENCE);
      pair = matchRight(capTo(pair, REFERENCE));
    }
    target = WIDENED.has(state)
      ? widenTo(pair, HEAVY_LIDS.has(state) ? WIDEN_TO : 0)
      : pair;
    expression = index;
    morph.x = 0;
    morph.v = 0;
    morph.t = 1;
    morphStiffness = stiffness;
  };

  /**
   * What the mood wants this frame: targets for every channel, and the events it fires on its own
   * clocks. `t` is seconds since the engine was made, `since` seconds since the state changed.
   */
  const think = (time: number) => {
    const t = (time - born) / 1000;
    const since = (time - stateSince) / 1000;
    let lidFloor = 1;
    let eyeGrow = 1;

    /*
     * BACK FROM A HIDDEN TAB, EVERY CLOCK IS OVERDUE AT ONCE. The browser stops the frame loop while
     * the tab is hidden; when it returns, every schedule on every face on the page is in the past,
     * and honouring them all in the first frame is a roster that blinks, changes expression and
     * spins in unison — measured, in the screenshots that caught it. Overdue clocks are dealt fresh
     * random offsets instead, so the faces come back the way they left: out of step.
     */
    if (resumedAt !== null) {
      resumedAt = null;
      if (time >= nextBlinkAt) nextBlinkAt = time + between(300, 4000);
      if (time >= nextExpressionAt)
        nextExpressionAt = time + between(500, 5000);
      if (time >= nextSpinAt) nextSpinAt = time + between(1500, 7000);
      if (time >= nextGazeAt) nextGazeAt = time + between(100, 1500);
      if (time >= nextWinkAt) nextWinkAt = time + between(2000, 8000);
      if (time >= nextGestureAt) nextGestureAt = time + between(3000, 12000);
      blinks = [];
    }

    if (previousState !== state) {
      previousState = state;
      expression = -1;
      cycle = 0;
      nextExpressionAt = time + between(...EXPRESSION_INTERVALS[state]);
      nextBlinkAt = time + between(1500, 7000);
      nextSpinAt =
        time +
        (state === "excited"
          ? between(400, 1100)
          : state === "searching"
            ? between(800, 1600)
            : state === "working"
              ? between(1200, 2400)
              : between(6000, 10000));
      moodTimerAt = time + between(500, 1200);
      secondTimerAt = time + between(1200, 2200);
      sequenceStartedAt = 0;
      nextGazeAt = time + between(500, 1400);
      nextWinkAt = time + between(3000, 8000);
      beatIndex = -1;
      if (state === "celebrate") celebrateSpinAt = time + 140;
      if (state !== "waking" && state !== "sleeping") {
        if (state !== "drowsy") scheduleBlink(time);
        show(EXPRESSION_SETS[state][0] as number, state === "excited" ? 10 : 8);
      }
    }

    if (state === "celebrate" && !gesture && time >= celebrateSpinAt) {
      startGesture("spinWild");
      celebrateSpinAt = time + 6200;
    }

    if (time >= nextGestureAt) {
      const lively = GESTURING.has(state);
      const playful = PLAYFUL.has(state);
      if ((lively || playful) && !spinner && bounceStartedAt < 0 && !gesture) {
        const roll = random();
        if (lively) {
          if (roll < 0.55) spinOnce(1);
          else startGesture("spinBounce");
        } else if (roll < 0.34) startGesture("spinBounce");
        else if (roll < 0.62) bounceOnce();
        else if (roll < 0.86) startGesture("spinDizzy");
        else spinOnce(1);
      }
      nextGestureAt = time + between(9000, 18000);
    }

    switch (state) {
      case "sleeping": {
        if (!EXPRESSION_SETS.sleeping.includes(expression)) show(13, 5.8);
        const settle = Math.min(since / 2, 1);
        const sigh = Math.sin(clamp(since / 0.5, 0, 1) * Math.PI);
        rotation.t = 4 * settle + Math.sin(t * 0.25) * 2;
        shiftX.t = -2 * settle;
        shiftY.t = 8 * settle + Math.sin(t * 0.55) * 3 - sigh * 5;
        squash.t = 1 + Math.sin(t * 0.55) * 0.016 + sigh * 0.05;
        break;
      }
      case "waking": {
        if (since < 0.75) {
          show(3, 6.6);
          eyeGrow = 1 + 0.08 * clamp(since / 0.6, 0, 1);
          shiftY.t = 4 - 10 * clamp(since / 0.75, 0, 1);
          shiftX.t = 0;
          rotation.t = 0;
          squash.t = 1.02;
        } else if (since < 1.45) {
          show(0, 7);
          shiftY.t = 0;
          squash.t = 1;
        } else {
          const settle = Math.min((since - 1.45) / 0.65, 1);
          show(0, 7.2);
          rotation.t = Math.sin(settle * Math.PI * 3) * 6 * (1 - settle);
          shiftY.t = Math.sin(t * 0.9) * 2;
        }
        break;
      }
      case "idle": {
        rotation.t = Math.sin(t * 0.5) * 1.5 + Math.sin(t * 0.17) * 0.6;
        shiftX.t = Math.sin(t * 0.27) * 1;
        shiftY.t = Math.sin(t * 0.85) * 1.2;
        squash.t = 1 + Math.sin(t * 0.85) * 0.007;
        break;
      }
      case "listening": {
        rotation.t = 8 + Math.sin(t * 0.5) * 1.5;
        shiftX.t = 2;
        shiftY.t = -2 + Math.sin(t * 0.8) * 0.8;
        squash.t = 1.015;
        if (time >= secondTimerAt) {
          sequenceStartedAt = time + 380;
          secondTimerAt = time + between(1800, 3200);
        }
        if (time < sequenceStartedAt) {
          const nod = 1 - (sequenceStartedAt - time) / 380;
          shiftY.t += Math.sin(nod * Math.PI) * 4.5;
          rotation.t += Math.sin(nod * Math.PI) * 2;
        }
        break;
      }
      case "thinking": {
        rotation.t = -9 + Math.sin(t * 0.35) * 5;
        shiftX.t = Math.sin(t * 0.3) * 5;
        shiftY.t = Math.sin(t * 0.6) * 2.5;
        squash.t = 1;
        break;
      }
      case "searching": {
        const sweep = Math.sin(t * 1.3);
        rotation.t = sweep * 13;
        shiftX.t = sweep * 7;
        shiftY.t = Math.sin(t * 1.7) * 3;
        squash.t = 1;
        if (time >= nextSpinAt) {
          spinOnce();
          nextSpinAt = time + between(4000, 7000);
        }
        break;
      }
      case "working": {
        const beat = Math.sin(t * Math.PI * 2 * 1.6);
        rotation.t = 4 + beat * 2.5;
        shiftX.t = 3;
        shiftY.t = 1.5 + Math.max(0, beat) * 3;
        squash.t = 1 - Math.max(0, beat) * 0.02;
        if (time >= nextSpinAt) {
          spinOnce(1, 1);
          nextSpinAt = time + between(6000, 9000);
        }
        break;
      }
      case "excited": {
        const hop = (t * 2.2) % 1;
        const arc = Math.sin(hop * Math.PI);
        shiftY.t = -arc * 10 + 2;
        squash.t = hop < 0.1 ? 0.92 : hop < 0.3 ? 1.05 : 1;
        shiftX.t = Math.sin(t * 1.1) * 4;
        eyeGrow = 1.06;
        if (time >= nextSpinAt) {
          spinOnce(1);
          nextSpinAt = time + between(2800, 5000);
        }
        rotation.t = Math.sin(t * Math.PI * 2 * 1.1) * 7;
        break;
      }
      case "surprised": {
        const settle = Math.min(since / 1.2, 1);
        shiftX.t = -4 * (1 - settle);
        shiftY.t = -8 * (1 - settle);
        squash.t = since < 0.2 ? 1.08 : 1;
        eyeGrow = 1.15 - settle * 0.08;
        rotation.t = Math.sin(t * 11) * 1.5 * (1 - settle);
        break;
      }
      case "suspicious": {
        rotation.t = -6 + Math.sin(t * 0.3) * 3;
        shiftX.t = Math.sin(t * 0.25) * -4;
        shiftY.t = 1 + Math.sin(t * 0.45) * 1.2;
        squash.t = 1;
        lidFloor = 0.85;
        if (time >= moodTimerAt) {
          rotation.v += 30;
          moodTimerAt = time + between(4000, 7000);
        }
        break;
      }
      case "angry": {
        if (time >= moodTimerAt) {
          angryUntil = time + 420;
          shiftY.v += 70;
          moodTimerAt = time + between(1800, 3200);
        }
        rotation.t = time < angryUntil ? Math.sin(time * 0.05) * 4.5 : 0;
        shiftX.t = 0;
        shiftY.t = 3.5;
        squash.t = 0.975;
        break;
      }
      case "drowsy": {
        rotation.t = Math.sin(t * 0.32) * 2.5;
        shiftX.t = Math.sin(t * 0.2) * 1.5;
        shiftY.t = 6 + Math.sin(t * 0.36) * 2.2;
        squash.t = 1 + Math.sin(t * 0.36) * 0.022;
        lidFloor = 0.34 + Math.sin(t * 0.8) * 0.07;
        if (time >= secondTimerAt && !sequenceStartedAt)
          sequenceStartedAt = time;
        if (sequenceStartedAt) {
          const doze = (time - sequenceStartedAt) / 1000;
          const drop = 1.7;
          const jolt = 0.3;
          const recover = 1.5;
          if (doze < drop) {
            const k = doze / drop;
            const kk = k * k;
            const nod = Math.sin(k * Math.PI * 2.5) * 2.2 * (1 - k);
            shiftY.t = 6 + kk * 19 + nod;
            rotation.t = kk * 10;
            lidFloor = 0.34 - kk * (0.34 - 0.04);
            squash.t = 1 - kk * 0.045;
          } else if (doze < drop + jolt) {
            const k = (doze - drop) / jolt;
            const kick = Math.sin(k * Math.PI);
            shiftY.t = 25 - kick * 7;
            rotation.t = 10 - kick * 4;
            lidFloor = 0.04 + kick * 0.42;
          } else if (doze < drop + jolt + recover) {
            const k = (doze - drop - jolt) / recover;
            const ease = 1 - (1 - k) ** 2.2;
            shiftY.t = 25 + -19 * ease;
            rotation.t = 10 * (1 - ease);
            lidFloor = 0.46 + (0.34 - 0.46) * ease;
            if (k > 0.32 && k < 0.46) lidFloor = 0.05;
          } else {
            sequenceStartedAt = 0;
            secondTimerAt = time + between(1500, 3500);
          }
        }
        break;
      }
      case "happy": {
        const beat = Math.sin(t * 2.4);
        rotation.t = Math.sin(t * 1.2) * 3;
        shiftX.t = Math.sin(t * 1.1) * 2.5;
        shiftY.t = -Math.abs(beat) * 3;
        squash.t = 1 + beat * 0.02;
        eyeGrow = 1.05;
        break;
      }
      case "curious": {
        rotation.t = 10 + Math.sin(t * 0.7) * 6;
        shiftX.t = Math.sin(t * 0.6) * 5;
        shiftY.t = -2 + Math.sin(t * 0.9) * 1.5;
        squash.t = 1.01;
        eyeGrow = 1.08;
        if (time >= secondTimerAt) {
          sequenceStartedAt = time + 440;
          secondTimerAt = time + between(1600, 2800);
        }
        if (time < sequenceStartedAt) {
          const lean = 1 - (sequenceStartedAt - time) / 440;
          shiftX.t += Math.sin(lean * Math.PI) * 8;
          rotation.t += Math.sin(lean * Math.PI) * 5;
        }
        break;
      }
      case "confused": {
        const sway = Math.sin(t * 0.8);
        rotation.t = sway * 12;
        shiftX.t = sway * 3;
        shiftY.t = Math.sin(t * 0.5) * 2;
        squash.t = 1;
        lidFloor = 0.9;
        if (time >= moodTimerAt) {
          rotation.v += 22;
          moodTimerAt = time + between(2600, 4200);
        }
        break;
      }
      case "bored": {
        rotation.t = -3 + Math.sin(t * 0.25) * 4;
        shiftX.t = Math.sin(t * 0.2) * 4;
        shiftY.t = 5 + Math.sin(t * 0.35) * 1.5;
        squash.t = 0.99;
        lidFloor = 0.6;
        eyeGrow = 0.98;
        if (time >= moodTimerAt) {
          sequenceStartedAt = time + 600;
          moodTimerAt = time + between(4000, 7000);
        }
        if (time < sequenceStartedAt) {
          const sigh = 1 - (sequenceStartedAt - time) / 600;
          squash.t = 1 + Math.sin(sigh * Math.PI) * 0.05;
          shiftY.t += Math.sin(sigh * Math.PI) * 3;
        }
        break;
      }
      case "proud": {
        rotation.t = Math.sin(t * 0.4) * 2.5;
        shiftX.t = Math.sin(t * 0.35) * 2;
        shiftY.t = -4 + Math.sin(t * 0.6);
        squash.t = 1.03;
        eyeGrow = 1.02;
        lidFloor = 0.9;
        break;
      }
      case "shy": {
        rotation.t = -8 + Math.sin(t * 0.5) * 3;
        shiftX.t = -3 + Math.sin(t * 0.4) * 2;
        shiftY.t = 3;
        squash.t = 0.98;
        eyeGrow = 0.95;
        lidFloor = 0.85;
        break;
      }
      case "sad": {
        rotation.t = 3 + Math.sin(t * 0.3) * 2;
        shiftX.t = Math.sin(t * 0.25) * 1.5;
        shiftY.t = 7 + Math.sin(t * 0.4);
        squash.t = 0.97;
        lidFloor = 0.7;
        eyeGrow = 0.97;
        break;
      }
      case "laughing": {
        const beat = Math.sin(t * Math.PI * 2 * 3.2);
        rotation.t = beat * 4;
        shiftX.t = Math.sin(t * 2) * 2;
        shiftY.t = -Math.abs(beat) * 5;
        squash.t = 1 + beat * 0.03;
        lidFloor = 0.7;
        break;
      }
      case "scared": {
        rotation.t = Math.sin(time * 0.04) * 2;
        shiftX.t = -2 + Math.sin(time * 0.05) * 1.5;
        shiftY.t = 2 + Math.sin(t * 1.5);
        squash.t = 0.97;
        eyeGrow = 1.12;
        lidFloor = 1.05;
        break;
      }
      case "playful": {
        rotation.t = Math.sin(t * 1.4) * 8;
        shiftX.t = Math.sin(t * 1.1) * 4;
        shiftY.t = -Math.abs(Math.sin(t * 2.2)) * 3;
        squash.t = 1 + Math.sin(t * 2.2) * 0.015;
        eyeGrow = 1.06;
        if (time >= nextSpinAt) {
          spinOnce(1);
          nextSpinAt = time + between(3500, 6000);
        }
        break;
      }
      case "celebrate": {
        rotation.t = 0;
        shiftX.t = 0;
        shiftY.t = -Math.abs(Math.sin(t * 1.6)) * 2.5;
        squash.t = 1;
        eyeGrow = 1.1;
        lidFloor = 1.1;
        break;
      }
      case "notifying": {
        if (beatIndex < 0 && since > 0.12) {
          beatIndex = 0;
          shiftY.v -= 26;
          scheduleBlink(time);
        }
        eyeGrow = 1 + 0.05 * Math.exp(-since * 3);
        rotation.t = 3;
        shiftX.t = 2;
        shiftY.t = -1;
        squash.t = 1;
        break;
      }
      case "humming": {
        rotation.t = Math.sin(t * 0.4) * 2;
        shiftX.t = Math.sin(t * 0.3) * 1.5;
        shiftY.t = Math.sin(t * 0.7) * 1.5;
        squash.t = 1;
        break;
      }
    }

    // Where the eyes look, re-drawn on the mood's own clock.
    if (time >= nextGazeAt) {
      let x = 0;
      let y = 0;
      let low = 2500;
      let high = 5000;
      switch (state) {
        case "idle":
          low = 2500;
          high = 5500;
          break;
        case "listening":
          x = between(-0.3, 0.3) * 15;
          y = between(-0.25, 0.25) * 9;
          low = 2200;
          high = 4200;
          break;
        case "thinking":
          x = flip() * between(0.5, 1) * 15;
          y = -between(0.4, 1) * 9;
          low = 1500;
          high = 2800;
          break;
        case "searching":
          x = flip() * between(0.7, 1) * 15;
          y = between(-1, 1) * 9;
          low = 550;
          high = 1150;
          break;
        case "working":
          x = between(-0.4, 0.4) * 15;
          y = between(0.4, 1) * 9;
          low = 1200;
          high = 2400;
          break;
        case "excited":
          x = between(-1, 1) * 15;
          y = between(-1, 0.3) * 9;
          low = 700;
          high = 1400;
          break;
        case "surprised":
          low = 1600;
          high = 2600;
          break;
        case "suspicious":
          x = flip() * 15;
          y = 0.3 * 9;
          low = 2200;
          high = 4200;
          break;
        case "angry":
          x = between(-0.2, 0.2) * 15;
          y = 0.2 * 9;
          low = 1800;
          high = 3200;
          break;
        case "drowsy":
          x = between(-0.4, 0.4) * 15;
          y = between(0.4, 1) * 9;
          low = 2500;
          high = 4500;
          break;
        case "happy":
          x = between(-0.7, 0.7) * 15;
          y = -between(0, 0.6) * 9;
          low = 1800;
          high = 3400;
          break;
        case "curious":
          x = flip() * between(0.6, 1) * 15;
          y = between(-1, 1) * 9;
          low = 950;
          high = 1900;
          break;
        case "confused":
          x = flip() * between(0.5, 1) * 15;
          y = between(-0.6, 1) * 9;
          low = 1100;
          high = 2300;
          break;
        case "bored":
          x = flip() * between(0.7, 1) * 15;
          y = between(0.4, 0.9) * 9;
          low = 3000;
          high = 6000;
          break;
        case "proud":
          x = between(-0.3, 0.3) * 15;
          y = -between(0.3, 0.7) * 9;
          low = 2600;
          high = 4600;
          break;
        case "shy":
          x = flip() * between(0.6, 1) * 15;
          y = between(0.5, 1) * 9;
          low = 2000;
          high = 4000;
          break;
        case "sad":
          x = between(-0.3, 0.3) * 15;
          y = between(0.6, 1) * 9;
          low = 2800;
          high = 5000;
          break;
        case "laughing":
          x = between(-0.5, 0.5) * 15;
          y = -between(0.2, 0.6) * 9;
          low = 800;
          high = 1700;
          break;
        case "scared":
          x = flip() * between(0.7, 1) * 15;
          y = between(-0.6, 0.6) * 9;
          low = 450;
          high = 1050;
          break;
        case "playful":
          x = flip() * between(0.5, 1) * 15;
          y = -between(0, 0.6) * 9;
          low = 900;
          high = 1800;
          break;
        case "notifying": {
          const toward = random() < 0.72;
          x = (toward ? 0.45 : 0.1) * 15;
          y = -(toward ? 0.3 : 0.05) * 9;
          low = 1200;
          high = 2400;
          break;
        }
        default:
          x = between(-0.4, 0.4) * 15;
          y = between(-0.3, 0.3) * 9;
      }
      gazeX.t = x;
      gazeY.t = y;
      nextGazeAt = time + between(low, high);
    }

    if (WINKING.has(state) && time >= nextWinkAt) {
      winkStartedAt = time;
      winkingEye = random() < 0.5 ? 0 : 1;
      nextWinkAt = time + between(4500, 10000);
    }

    // Change expression on the mood's clock, and blink on its own.
    if (
      state !== "waking" &&
      state !== "sleeping" &&
      time >= nextExpressionAt
    ) {
      const set = EXPRESSION_SETS[state];
      cycle = (cycle + 1 + Math.floor(between(0, set.length - 1))) % set.length;
      show(
        set[cycle] as number,
        state === "searching" || state === "excited" ? 10 : 6,
      );
      nextExpressionAt = time + between(...EXPRESSION_INTERVALS[state]);
    }
    const blinkRange = BLINK_INTERVALS[state];
    if (blinkRange && time >= nextBlinkAt) {
      scheduleBlink(time);
      nextBlinkAt = time + between(blinkRange[0], blinkRange[1]);
    }
    let blinkValue: number | null = null;
    while (blinks.length && time >= (blinks[0] as { at: number }).at) {
      blinkValue = (blinks.shift() as { v: number }).v;
    }
    if (HEAVY_LIDS.has(state)) lidFloor = Math.max(lidFloor, HEAVY_LID_FLOOR);
    if (state === "working") {
      const aside = smooth(clamp((-gazeX.x - 0.5) / 4.5, 0, 1));
      const down = smooth(clamp((gazeY.x - 3) / 6, 0, 1));
      eyeGrow *= 1 + 0.14 * aside * down;
    }
    openness.t = blinkValue ?? (blinks.length ? openness.t : lidFloor);
    eyeScale.t = eyeGrow;
  };

  /** The choreography of a spin gesture this frame: extra rotation, shifts, and eye tweaks. */
  const choreograph = (time: number) => {
    const out = {
      spin: null as number | null,
      rot: 0,
      dx: 0,
      dy: 0,
      extraRot: 0,
      gx: 0,
      gy: 0,
      lid: null as number | null,
      grow: null as number | null,
    };
    if (!gesture) return out;
    const elapsed = (time - gesture.t0) / 1000;
    const { kind, dir, turns } = gesture;
    if (kind === "spinDizzy") {
      const windup = 0.55 + turns * 0.16;
      const wobble = 1.5;
      if (elapsed < windup) {
        const k = elapsed / windup;
        out.spin = turns * Math.PI * 2 * dir * (k * k);
      } else if (elapsed < windup + wobble) {
        const w = elapsed - windup;
        const fade = (1 - w / wobble) ** 1.3;
        out.rot = Math.sin(w * 10) * 17 * dir * fade;
        out.dx = Math.cos(w * 10) * 10 * dir * fade;
        out.dy = Math.sin(w * 20) * 3 * fade;
        out.lid = 0.46 + 0.14 * Math.sin(w * 21);
        out.grow = 1.03;
      } else gesture = null;
    } else if (kind === "spinWild") {
      const cruise = 2;
      const backswing = 0.5;
      const turn = Math.PI * 2;
      const total = 0.24 + 2.3 + 1.25;
      const rate = (turns * turn + backswing) / (0.3 / 2 + cruise + 1.25 / 4);
      if (elapsed < total + 1.7) {
        let angle: number;
        if (elapsed < 0.24)
          angle = (-backswing * (1 - Math.cos((elapsed / 0.24) * Math.PI))) / 2;
        else if (elapsed < 0.24 + 0.3) {
          const go = elapsed - 0.24;
          angle = -backswing + (rate * go * go) / (2 * 0.3);
        } else if (elapsed < 0.24 + 2.3)
          angle = -backswing + rate * (0.3 / 2 + (elapsed - 0.24 - 0.3));
        else if (elapsed < total) {
          const go = (elapsed - 0.24 - 2.3) / 1.25;
          angle =
            -backswing +
            rate * (0.3 / 2 + cruise) +
            (rate * 1.25 * (1 - (1 - go) ** 4)) / 4;
        } else angle = turns * turn;
        out.spin = angle * dir;
        let settle = 0;
        if (elapsed > 0.24 + 2.3) {
          const go = Math.min((elapsed - 0.24 - 2.3) / 1.25, 1);
          settle = go < 0.4 ? 0 : ((go - 0.4) / 0.6) ** 2;
          if (elapsed >= total) settle = (1 - (elapsed - total) / 1.7) ** 1.6;
        }
        const late = Math.max(elapsed - 0.24 - 2.3, 0);
        out.extraRot = (angle / (turns * turn)) * 3 * 360 * dir;
        out.rot = Math.sin(late * 9.2) * 11 * dir * settle;
        out.dx = (Math.cos(late * 9.2) - 1) * 6 * dir * settle;
        out.dy = Math.sin(late * 18.4) * 2.6 * settle;
        out.gx = Math.sin(late * 11.5) * 13 * dir * settle;
        out.gy = (Math.cos(late * 9) - 1) * 3.5 * settle;
        out.lid = 1.14 - 0.44 * settle + 0.1 * Math.sin(late * 16) * settle;
        out.grow = 1.12 - 0.09 * settle;
      } else gesture = null;
    } else if (kind === "spinBounce") {
      if (elapsed < 0.7)
        out.spin = turns * Math.PI * 2 * dir * easeInOutCubic(elapsed / 0.7);
      else {
        bounceOnce();
        gesture = null;
      }
    }
    return out;
  };

  const bounceOffset = (time: number) => {
    if (bounceStartedAt < 0) return 0;
    const elapsed = (time - bounceStartedAt) / 1000;
    if (elapsed >= BOUNCE_TOTAL) {
      bounceStartedAt = -1;
      return 0;
    }
    let start = 0;
    let index = 0;
    while (
      index < BOUNCES.length &&
      !(elapsed < start + (BOUNCES[index] as { d: number }).d)
    ) {
      start += (BOUNCES[index] as { d: number }).d;
      index += 1;
    }
    const { h, d } = BOUNCES[index] as { h: number; d: number };
    const k = (elapsed - start) / d;
    return -4 * h * k * (1 - k);
  };

  const eyeShown = (index: 0 | 1): Eye => {
    const along = clamp(morph.x, 0, 1);
    return blendEye(shown[index], target[index], along);
  };

  /** Draw the face as it is right now. */
  const draw = (time: number, dt: number) => {
    const dance = choreograph(time);
    if (dance.lid !== null) openness.t = dance.lid;
    if (dance.grow !== null) eyeScale.t = dance.grow;

    let spinAngle: number | null = null;
    if (spinner) {
      spinAngle = spinner.x;
      if (
        Math.abs(spinner.t - spinner.x) < 0.004 &&
        Math.abs(spinner.v) < 0.015
      ) {
        spinner = null;
        spinAngle = null;
      }
    }
    if (dance.spin !== null) spinAngle = (spinAngle ?? 0) + dance.spin;

    const wanted = tuneFor(state, baseTune);
    const k = perFrame(0.13, dt);
    tune = {
      size: tune.size + (wanted.size - tune.size) * k,
      gap: tune.gap + (wanted.gap - tune.gap) * k,
      height: tune.height + (wanted.height - tune.height) * k,
      eyeWidth: tune.eyeWidth + (wanted.eyeWidth - tune.eyeWidth) * k,
      eyeHeight: tune.eyeHeight + (wanted.eyeHeight - tune.eyeHeight) * k,
    };

    const face = {
      x: shape.face.x,
      y: shape.face.y,
      sx: shape.face.sx * tune.gap,
      sy: shape.face.sy * tune.height,
      eye: shape.face.eye * tune.size,
      leftDX: shape.face.leftDX,
    };
    const eyes: [Eye, Eye] = [eyeShown(0), eyeShown(1)];
    const halfWidths = [eyeHalfWidth(eyes[0]), eyeHalfWidth(eyes[1])];
    const gap = Math.abs(eyes[1].cx - (eyes[0].cx + face.leftDX)) * face.sx;
    const spread = (halfWidths[0] as number) + (halfWidths[1] as number);
    const fit = spread > 0.5 ? clamp((gap - 5) / spread, 0.35, 4) : 4;

    // On a flat-topped body a spin would carry the eyes into each other; keep them apart.
    const separation = [0, 0];
    if (
      state === "working" &&
      spinAngle !== null &&
      (shape.id === "pebble" || shape.id === "tablet" || shape.id === "cloud")
    ) {
      const placed = eyes.map((eye, index) => {
        const cx = eye.cx + (index === 0 ? face.leftDX : 0);
        const y = clamp(
          CENTRE + face.y + (eye.cy - CENTRE) * face.sy,
          shape.top + 2,
          shape.bottom - 2,
        );
        const [left, right] = shape.spanAt(y);
        const belt = Math.max((right - left) / 2, 12);
        const middle = (left + right) / 2;
        const along =
          Math.asin(clamp(((cx - CENTRE) * face.sx) / belt, -1, 1)) + spinAngle;
        return {
          x: middle + belt * Math.sin(along),
          visible: Math.cos(along) > 0.02,
        };
      });
      const [first, second] = placed as [
        { x: number; visible: boolean },
        { x: number; visible: boolean },
      ];
      if (first.visible && second.visible) {
        const apart = second.x - first.x;
        if (apart < gap) {
          separation[0] = -(gap - apart) / 2;
          separation[1] = (gap - apart) / 2;
        }
      }
    }

    for (let index = 0 as 0 | 1; index < 2; index = (index + 1) as 0 | 1) {
      const element = elements.eyes[index];
      const eye = eyes[index];
      let open = Math.max(openness.x, 0.04);
      if (index === winkingEye && time < winkStartedAt + 320) {
        const along = (time - winkStartedAt) / 320;
        const shut = along < 0.42 ? 1 - along / 0.42 : (along - 0.42) / 0.58;
        open = Math.max(open * shut, 0.04);
      }
      element.setAttribute("d", eyePath(eye));

      const cx = eye.cx + (index === 0 ? face.leftDX : 0);
      let centreX = CENTRE + face.x;
      let offsetX = (cx - CENTRE) * face.sx;
      let squashX = 1;
      let visible = true;
      let clampMix = 1;
      const restY = clamp(
        CENTRE + face.y + (eye.cy - CENTRE) * face.sy,
        shape.top + 2,
        shape.bottom - 2,
      );
      if (spinAngle !== null) {
        const [left, right] = shape.spanAt(restY);
        const belt = Math.max((right - left) / 2, 12);
        centreX = (left + right) / 2;
        const rest = Math.asin(clamp(offsetX / belt, -1, 1));
        const turned = rest + spinAngle;
        const facing = Math.cos(turned);
        visible = facing > 0.02;
        squashX = Math.max(facing, 0.02) / Math.max(Math.cos(rest), 0.02);
        offsetX = belt * Math.sin(turned);
        clampMix = smooth(clamp(facing / 0.5, 0, 1));
      }

      // Small wander so two eyes never sit perfectly still, then the mood's gaze on top.
      let lookX =
        Math.sin(time * 42e-5 + index) * 1.4 +
        Math.sin(time * 0.001 + index * 2) * 0.5;
      let lookY = Math.sin(time * 58e-5 + index) * 0.9;
      lookX += gazeX.x + dance.gx;
      lookY += gazeY.x + dance.gy;
      const attention = clamp(badge.x, 0, 1);
      lookX -= 10 * attention;
      lookY += 7 * attention;

      const size = Math.min(clamp(eyeScale.x, 0.2, 2) * face.eye, fit);
      const width = Math.min(size * clamp(tune.eyeWidth, 0.2, 3), fit);
      const height = size * clamp(tune.eyeHeight, 0.2, 3);
      const scaleX = clamp(squashX * width, 0.02, 2.4);
      const scaleY = clamp(open * height, 0.02, 2.4);

      element.style.display = visible ? "" : "none";
      const margin = 21 * scaleY + 2;
      const y = clamp(
        restY + lookY * face.sy,
        shape.top + margin,
        shape.bottom - margin,
      );

      // The skin: the eye's own outline, scaled, must fit between the body's edges on every row.
      let lowest = Number.NEGATIVE_INFINITY;
      let highest = Number.POSITIVE_INFINITY;
      const outline = stadiumSample(eye);
      for (const [px, py] of outline) {
        const dx = px * scaleX;
        const [left, right] = shape.spanAt(y + py * scaleY);
        if (left - dx > lowest) lowest = left - dx;
        if (right - dx < highest) highest = right - dx;
      }
      const wanted =
        centreX + offsetX + (separation[index] as number) + lookX * face.sx;
      const kept =
        lowest <= highest
          ? clamp(wanted, lowest, highest)
          : (lowest + highest) / 2;
      const x = kept + (wanted - kept) * (1 - clampMix);
      element.setAttribute(
        "transform",
        `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scaleX.toFixed(4)} ${scaleY.toFixed(4)})`,
      );
    }

    const dx = shiftX.x + dance.dx;
    const dy = shiftY.x + bounceOffset(time) + dance.dy;
    const rot = rotation.x * shape.tiltScale + dance.rot + dance.extraRot;
    elements.body.setAttribute(
      "transform",
      `translate(${(CENTRE + dx).toFixed(2)} ${(CENTRE + dy).toFixed(2)}) rotate(${rot.toFixed(2)}) scale(1 ${squash.x.toFixed(4)}) translate(${-CENTRE} ${-CENTRE})`,
    );

    badge.t = state === "notifying" ? 1 : 0;
    if (elements.badge) {
      const amount = clamp(badge.x, 0, 1.4);
      // `visibility`, not `display`: the circle starts hidden by attribute, and an attribute is
      // what the engine can flip without fighting a stylesheet rule.
      if (amount <= 0.01) elements.badge.setAttribute("visibility", "hidden");
      else {
        const y = shape.top + (shape.bottom - shape.top) * 0.22;
        const [, right] = shape.spanAt(y);
        elements.badge.setAttribute("visibility", "visible");
        elements.badge.setAttribute("cx", right.toFixed(1));
        elements.badge.setAttribute("cy", y.toFixed(1));
        elements.badge.setAttribute("r", (20 * amount).toFixed(2));
      }
    }
  };

  const outlineCache = new Map<string, [number, number][]>();
  /** Every other point of the eye's outline, for the skin clamp; keyed so a still face costs nothing. */
  const stadiumSample = (eye: Eye): [number, number][] => {
    const key = `${eye.angle.toFixed(1)}|${eye.halfLen.toFixed(1)}|${eye.halfW.toFixed(1)}`;
    const cached = outlineCache.get(key);
    if (cached) return cached;
    const points = eyePathPoints(eye);
    if (outlineCache.size > 64) outlineCache.clear();
    outlineCache.set(key, points);
    return points;
  };

  const rest = () => {
    for (const channel of [rotation, shiftX, shiftY, gazeX, gazeY]) {
      channel.x = 0;
      channel.v = 0;
      channel.t = 0;
    }
    for (const channel of [squash, openness, eyeScale]) {
      channel.x = 1;
      channel.v = 0;
      channel.t = 1;
    }
    blinks = [];
    winkStartedAt = -1e9;
  };

  const frame = (time: number) => {
    const away = time - lastFrame;
    const dt = Math.min(Math.max(away / 1000, 0), 0.1);
    lastFrame = time;
    if (away > RESUME_AFTER_MS) resumedAt = time;
    if (reduceMotion) {
      show(EXPRESSION_SETS[state][0] as number);
      morph.x = 1;
      morph.v = 0;
      rest();
      badge.x = state === "notifying" ? 1 : 0;
    } else {
      think(time);
      const substeps = Math.max(1, Math.ceil(dt / SUBSTEP));
      const piece = dt / substeps;
      for (let index = 0; index < substeps; index += 1) {
        step(morph, morphStiffness, 1, piece);
        if (spinner) step(spinner, 6.2, 1, piece);
        step(rotation, 5, 0.9, piece);
        step(shiftX, 3.5, 1, piece);
        step(shiftY, 4, 1, piece);
        step(squash, 10, 0.8, piece);
        step(openness, 26, 1, piece);
        step(eyeScale, 9, 0.85, piece);
        step(badge, 9, 0.55, piece);
        step(gazeX, 13, 1, piece);
        step(gazeY, 13, 1, piece);
      }
    }
    draw(time, dt);
  };

  const loop = (time: number) => {
    handle = 0;
    frame(time);
    if (reduceMotion) return;
    if (paused && !gesture && !spinner && bounceStartedAt < 0) {
      rest();
      morph.x = 1;
      morph.v = 0;
      draw(time, 0);
      return;
    }
    handle = raf(loop);
  };

  return {
    setState: (next) => {
      if (next === state) return;
      state = next;
      stateSince = now();
      if (reduceMotion && handle === 0) frame(now());
    },
    setShape: (next) => {
      shape = next;
      outlineCache.clear();
      if (reduceMotion && handle === 0) frame(now());
    },
    setPaused: (next) => {
      paused = next;
      if (!next && handle === 0 && !reduceMotion) {
        lastFrame = now();
        handle = raf(loop);
      }
    },
    spin: (turns = 1) => spinOnce(turns),
    bounce: bounceOnce,
    frame,
    start: () => {
      if (handle !== 0) return;
      lastFrame = now();
      if (reduceMotion) {
        frame(now());
        return;
      }
      handle = raf(loop);
    },
    stop: () => {
      if (handle !== 0) caf(handle);
      handle = 0;
    },
  };
}

/** Every other outline point of an eye, centred on the origin. */
function eyePathPoints(eye: Eye): [number, number][] {
  const path = eyePath(eye);
  const numbers = path.match(/-?\d*\.?\d+/g) ?? [];
  const points: [number, number][] = [];
  for (let index = 0; index + 1 < numbers.length; index += 4) {
    points.push([
      Number.parseFloat(numbers[index] as string),
      Number.parseFloat(numbers[index + 1] as string),
    ]);
  }
  return points;
}
