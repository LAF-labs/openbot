/**
 * The eyes: twenty-five expressions, each two rounded slits.
 *
 * Grok Bot draws an eye as a stadium — a segment of length `2·halfLen` with round ends of radius
 * `halfW`, turned by `angle` — and an expression as a pair of them at particular places on the
 * face. The pair is what carries the feeling: two verticals is attention, two slants leaning in is
 * a frown, two low horizontals is sleep, one eye a different size is a squint. The bundle keeps its
 * expressions as point lists; these are the five numbers each of those lists fits to (Grok's own
 * fit, `fd`, run over its own data on 2026-09-06), which is what its morphing code reduces them to
 * before every blend anyway.
 *
 * Coordinates are canvas units around `CENTRE`; the face placement in `grok-shapes.ts` scales and
 * shifts them onto a body. An expression is not centred on purpose: where the pair sits IS part of
 * the look (the default pair sits up and to the right — the Bot is looking at something), and the
 * skin clamp in the engine keeps the eyes on the body whatever the shape.
 */

import { CENTRE } from "./grok-shapes";

export type Eye = {
  cx: number;
  cy: number;
  /** Degrees; the long axis of the slit. 90 is a vertical slit, 0 a horizontal one. */
  angle: number;
  halfLen: number;
  halfW: number;
};

export type Expression = readonly [Eye, Eye];

const eye = (
  cx: number,
  cy: number,
  angle: number,
  halfLen: number,
  halfW: number,
): Eye => ({
  cx,
  cy,
  angle,
  halfLen,
  halfW,
});

/** Index 0 is the reference pair everything else is measured against. */
export const EXPRESSIONS: readonly Expression[] = [
  [
    eye(136.62, 66.73, 63.2, 22.62, 10.65),
    eye(185.69, 57.21, 62.7, 22.94, 7.39),
  ],
  [
    eye(90.94, 153.8, 77.6, 29.41, 12.57),
    eye(150.71, 142.18, 80.4, 29.48, 12.58),
  ],
  [
    eye(97.51, 147.69, 104.4, 44.41, 19.58),
    eye(165.19, 159.1, 107.3, 44.62, 18.1),
  ],
  [
    eye(45.86, 131.22, 76, 28.24, 21.79),
    eye(114.78, 111.87, 19.3, 28.24, 28.16),
  ],
  [
    eye(112.72, 110.16, 11.3, 28.22, 6.9),
    eye(174.46, 123.12, 12.7, 23.75, 6.92),
  ],
  [
    eye(85.71, 160.25, 75.3, 30.5, 13.61),
    eye(148.51, 148.89, 162.1, 26.46, 6.31),
  ],
  [
    eye(118.92, 124.42, 101.3, 19.26, 11.49),
    eye(171.63, 133.17, 102.2, 19.29, 10.02),
  ],
  [eye(118.99, 98.79, 50.1, 30.98, 11.52), eye(173, 92.41, 105, 28.91, 11.01)],
  [
    eye(52.58, 106.89, 125.1, 26.9, 9.67),
    eye(107.81, 120.65, 74.4, 28.15, 10.33),
  ],
  [
    eye(108.79, 157.8, 7.5, 23.82, 21.86),
    eye(174.65, 140.96, 113.9, 12.49, 10.22),
  ],
  [
    eye(99.89, 108.62, 103, 30.99, 12.63),
    eye(158.61, 122.31, 102.8, 31, 12.08),
  ],
  [
    eye(53.21, 137.29, 73.1, 47.03, 17.57),
    eye(118.16, 119.21, 73.4, 47.01, 19.41),
  ],
  [
    eye(102.55, 155.69, 16.1, 28.27, 25.98),
    eye(173.75, 166, 130.9, 28.29, 19.88),
  ],
  [eye(68, 140.62, 173, 25.29, 7.06), eye(131.55, 128.7, 166.6, 28.06, 7)],
  [
    eye(77.62, 97.72, 101.9, 32.52, 13.39),
    eye(140.16, 109.72, 12.7, 26.51, 6.38),
  ],
  [
    eye(170.56, 104.8, 79.7, 19.36, 10.13),
    eye(209.75, 97.22, 79.7, 19.29, 6.29),
  ],
  [
    eye(44.51, 134.84, 75.4, 31.03, 9.65),
    eye(96.98, 150.37, 132.1, 29.16, 11.57),
  ],
  [
    eye(109.48, 115.06, 105.7, 28.19, 10.31),
    eye(166.46, 102.42, 53.7, 27.68, 9.89),
  ],
  [
    eye(90.97, 99.88, 121.8, 23.81, 23.07),
    eye(158.04, 114.64, 89.9, 12.56, 11.56),
  ],
  [
    eye(63.2, 142.21, 76.3, 30.66, 11.62),
    eye(121.33, 131.67, 77.4, 30.61, 12.62),
  ],
  [
    eye(106.18, 161.46, 107.1, 42.4, 19.63),
    eye(172.4, 168.95, 110.4, 43.44, 17.04),
  ],
  [
    eye(55.03, 139.39, 67.2, 28.2, 22.97),
    eye(126.64, 123.38, 127.4, 28.27, 27.92),
  ],
  [eye(91.48, 88.83, 8.1, 27.48, 6.99), eye(155.68, 102.03, 15.4, 26.57, 7)],
  [eye(109.35, 147.29, 80, 31.34, 13.83), eye(170.56, 134.4, 161, 24.29, 6.44)],
  [
    eye(98.51, 140.18, 96.9, 18.71, 11.54),
    eye(153.71, 145.91, 101.4, 18.83, 10.99),
  ],
];

export const REFERENCE: Expression = EXPRESSIONS[0] as Expression;

const HALF_TURN = Math.PI;
const wrapAngle = (radians: number) => {
  let value = radians;
  while (value > HALF_TURN / 2) value -= HALF_TURN;
  while (value < -HALF_TURN / 2) value += HALF_TURN;
  return value;
};
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

/**
 * The outline of a stadium around the origin: a segment of `halfLen - halfW` capped by half circles
 * of `halfW`, turned by `angle`. Forty-eight points, the same count Grok samples.
 */
export function stadiumPoints(
  angle: number,
  halfLen: number,
  halfW: number,
  count = 48,
): [number, number][] {
  const straight = Math.max(0, halfLen - halfW);
  const ux = Math.cos(toRadians(angle));
  const uy = Math.sin(toRadians(angle));
  const points: [number, number][] = [];
  for (let index = 0; index < count; index += 1) {
    const theta = (index / count) * Math.PI * 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    // Direction in the slit's own frame: (along, across).
    const along = cos;
    const across = sin;
    let radius: number;
    const capRadius = halfW / Math.max(Math.abs(across), 1e-6);
    if (
      capRadius * Math.abs(along) <= straight + 1e-6 &&
      Number.isFinite(capRadius)
    ) {
      radius = capRadius;
    } else {
      const signed = (along >= 0 ? 1 : -1) * straight * along;
      radius =
        signed +
        Math.sqrt(
          Math.max(0, signed * signed - straight * straight + halfW * halfW),
        );
    }
    const x = radius * along;
    const y = radius * across;
    points.push([x * ux - y * uy, x * uy + y * ux]);
  }
  return points;
}

/** The path of one eye, centred on the origin, so a transform can place and squash it. */
export function eyePath(eye: Eye): string {
  const points = stadiumPoints(eye.angle, eye.halfLen, eye.halfW);
  const first = points[0] as [number, number];
  let d = `M${first[0].toFixed(2)} ${first[1].toFixed(2)}`;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index] as [number, number];
    d += `L${point[0].toFixed(2)} ${point[1].toFixed(2)}`;
  }
  return `${d}Z`;
}

/** How far the slit reaches left and right of its centre, for keeping two eyes apart. */
export function eyeHalfWidth(eye: Eye): number {
  let widest = 0;
  for (const [x] of stadiumPoints(eye.angle, eye.halfLen, eye.halfW, 24)) {
    widest = Math.max(widest, Math.abs(x));
  }
  return widest;
}

/** One eye part way from `from` to `to`, the way Grok morphs: angle by the short way, size linearly. */
export function blendEye(from: Eye, to: Eye, mix: number): Eye {
  const t = mix <= 0 ? 0 : mix >= 1 ? 1 : mix;
  if (t <= 0) return from;
  if (t >= 1) return to;
  const fromAngle = toRadians(from.angle);
  const delta = wrapAngle(toRadians(to.angle) - fromAngle);
  const halfW = Math.max(0.35, from.halfW + (to.halfW - from.halfW) * t);
  const straight =
    Math.max(0, from.halfLen - from.halfW) * (1 - t) +
    Math.max(0, to.halfLen - to.halfW) * t;
  return {
    cx: from.cx + (to.cx - from.cx) * t,
    cy: from.cy + (to.cy - from.cy) * t,
    angle: toDegrees(fromAngle + delta * t),
    halfLen: straight + halfW,
    halfW,
  };
}

export function blendExpression(
  from: Expression,
  to: Expression,
  mix: number,
): Expression {
  return [blendEye(from[0], to[0], mix), blendEye(from[1], to[1], mix)];
}

/**
 * The adjustments Grok makes to a pair before it is shown in a given mood.
 *
 * `alignTo`: both slits turn by the pair's mean difference from the reference, so an angry pair
 * still reads as this Bot's eyes. `capTo`: neither slit grows past 1.05× the reference. `matchRight`:
 * the right eye takes the left one's size. `widenTo`: both slits get at least the wider one's width
 * (or a floor), for the moods where a thin slit would read as a different feeling.
 */
export function alignTo(pair: Expression, reference: Expression): Expression {
  const deltas = [0, 1].map((index) =>
    wrapAngle(
      toRadians((pair[index] as Eye).angle) -
        toRadians((reference[index] as Eye).angle),
    ),
  );
  const mean = ((deltas[0] as number) + (deltas[1] as number)) / 2;
  return [0, 1].map((index) => {
    const current = pair[index] as Eye;
    const target = toRadians((reference[index] as Eye).angle) + mean;
    return { ...current, angle: toDegrees(target) };
  }) as unknown as Expression;
}

export function capTo(
  pair: Expression,
  reference: Expression,
  maxScale = 1.05,
): Expression {
  return [0, 1].map((index) => {
    const current = pair[index] as Eye;
    const ref = reference[index] as Eye;
    const ratio = Math.max(
      current.halfLen / Math.max(ref.halfLen, 1e-6),
      current.halfW / Math.max(ref.halfW, 1e-6),
    );
    const scale = Math.min(1, maxScale / ratio);
    if (scale >= 0.999) return current;
    return {
      ...current,
      halfLen: current.halfLen * scale,
      halfW: current.halfW * scale,
    };
  }) as unknown as Expression;
}

export function matchRight(pair: Expression): Expression {
  const [left, right] = pair;
  return [left, { ...right, halfLen: left.halfLen, halfW: left.halfW }];
}

export function widenTo(pair: Expression, minHalfW = 0): Expression {
  const widest = Math.max(pair[0].halfW, pair[1].halfW, minHalfW);
  return [0, 1].map((index) => {
    const current = pair[index] as Eye;
    if (current.halfW >= widest * 0.92) return current;
    return {
      ...current,
      halfLen: Math.max(0, current.halfLen - current.halfW) + widest,
      halfW: widest,
    };
  }) as unknown as Expression;
}

/** The pair's midpoint, used to pull the eyes toward the face centre when a Bot is emphasised. */
export function pairCentre(pair: Expression): [number, number] {
  return [(pair[0].cx + pair[1].cx) / 2, (pair[0].cy + pair[1].cy) / 2];
}

export const REFERENCE_CENTRE = pairCentre(REFERENCE);
export { CENTRE };
