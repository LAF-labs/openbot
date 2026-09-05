/**
 * The bodies a Bot can have, generated the way Grok Bot generates them.
 *
 * Read out of Grok Bot 0.30.0's renderer bundle on 2026-09-06 at the owner's request ("Grok Bot 파일을
 * 뜯어서 읽고 그걸 최대한 따라가"), and re-derived here rather than pasted: every body is a formula —
 * a superellipse, a union of circles, a polygon with rounded corners — evaluated on a 228.44-unit
 * canvas whose centre is `CENTRE`, then normalised so the longest side spans the canvas. The one
 * exception is the blob, which is a hand-drawn path and is kept as one.
 *
 * What the numbers below preserve is the FAMILY RESEMBLANCE the owner asked for: a Bot on our roster
 * next to a Bot on Grok's should look like two members of the same species. The eyes and the motion
 * live in `grok-eyes.ts` and `grok-engine.ts`; this module is only the silhouette and the two
 * things a silhouette has to answer for the face — where the eyes may sit, and how wide the body is
 * at a given height, so an eye that is pushed sideways is stopped at the skin and never floats off.
 */

/** Centre of the canvas, in user units. The viewBox is `-15 -15 259 259`, so this is its middle. */
export const CENTRE = 114.2705;
/** The longest side of a normalised body. */
const SPAN = 228.44;
const TAU = Math.PI * 2;
const round2 = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, low: number, high: number) =>
  value < low ? low : value > high ? high : value;

type Point = [number, number];

/**
 * A path builder that emits absolute commands with paired coordinates only.
 *
 * Arcs are written as cubic curves on purpose: `normalise` rescales a path by rewriting every number
 * in it as an x or a y in turn, and an SVG `A` command carries radii, an angle and two flags that
 * are neither.
 */
class PathBuilder {
  d = "";
  x = 0;
  y = 0;

  move(x: number, y: number) {
    this.d += `M${round2(x)} ${round2(y)}`;
    this.x = x;
    this.y = y;
    return this;
  }

  line(x: number, y: number) {
    this.d += `L${round2(x)} ${round2(y)}`;
    this.x = x;
    this.y = y;
    return this;
  }

  curve(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
    this.d += `C${round2(x1)} ${round2(y1)} ${round2(x2)} ${round2(y2)} ${round2(x)} ${round2(y)}`;
    this.x = x;
    this.y = y;
    return this;
  }

  /** A corner at `at` between `from` and `to`, rounded with `radius`. */
  corner(from: Point, at: Point, to: Point, radius: number) {
    const unit = (a: Point, b: Point): Point => {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const length = Math.hypot(dx, dy) || 1;
      return [dx / length, dy / length];
    };
    const before = unit(from, at);
    const after = unit(to, at);
    const start: Point = [
      at[0] + before[0] * radius,
      at[1] + before[1] * radius,
    ];
    const end: Point = [at[0] + after[0] * radius, at[1] + after[1] * radius];
    if (this.d) this.line(start[0], start[1]);
    else this.move(start[0], start[1]);
    this.d += `Q${round2(at[0])} ${round2(at[1])} ${round2(end[0])} ${round2(end[1])}`;
    this.x = end[0];
    this.y = end[1];
    return this;
  }

  /** An elliptical arc from angle `from` to `to`, as one cubic per quarter turn. */
  arc(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    from: number,
    to: number,
  ) {
    const pieces = Math.max(1, Math.ceil(Math.abs(to - from) / (Math.PI / 2)));
    const step = (to - from) / pieces;
    const k = (4 / 3) * Math.tan(step / 4);
    let angle = from;
    for (let index = 0; index < pieces; index += 1) {
      const next = angle + step;
      const a: Point = [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
      const b: Point = [cx + rx * Math.cos(next), cy + ry * Math.sin(next)];
      this.curve(
        a[0] - k * rx * Math.sin(angle),
        a[1] + k * ry * Math.cos(angle),
        b[0] + k * rx * Math.sin(next),
        b[1] - k * ry * Math.cos(next),
        b[0],
        b[1],
      );
      angle = next;
    }
    return this;
  }

  close() {
    return `${this.d}Z`;
  }
}

/** A closed smooth curve through `points` (Catmull-Rom written as cubics). */
const smoothClosed = (points: Point[]): string => {
  const count = points.length;
  const first = points[0] as Point;
  let d = `M${round2(first[0])} ${round2(first[1])}`;
  for (let index = 0; index < count; index += 1) {
    const previous = points[(index - 1 + count) % count] as Point;
    const current = points[index] as Point;
    const next = points[(index + 1) % count] as Point;
    const after = points[(index + 2) % count] as Point;
    d += `C${round2(current[0] + (next[0] - previous[0]) / 6)} ${round2(current[1] + (next[1] - previous[1]) / 6)} ${round2(next[0] - (after[0] - current[0]) / 6)} ${round2(next[1] - (after[1] - current[1]) / 6)} ${round2(next[0])} ${round2(next[1])}`;
  }
  return `${d}Z`;
};

/** Sample a polar function around the centre and smooth it closed. */
const polar = (at: (angle: number) => Point, samples = 128): string => {
  const points: Point[] = [];
  for (let index = 0; index < samples; index += 1) {
    points.push(at((index / samples) * TAU));
  }
  return smoothClosed(points);
};

/** A polygon whose corners are rounded with `radii` (one number, or one per corner). */
const rounded = (points: Point[], radii: number | number[]): string => {
  const builder = new PathBuilder();
  const count = points.length;
  for (let index = 0; index < count; index += 1) {
    const radius =
      typeof radii === "number"
        ? radii
        : (radii[index % radii.length] as number);
    builder.corner(
      points[(index - 1 + count) % count] as Point,
      points[index] as Point,
      points[(index + 1) % count] as Point,
      radius,
    );
  }
  return builder.close();
};

const regularPolygon = (
  radius: number,
  sides: number,
  cornerRadius: number,
  phase = 0,
): string =>
  rounded(
    Array.from({ length: sides }, (_, index) => {
      const angle = phase + (index / sides) * TAU;
      return [
        CENTRE + Math.cos(angle) * radius,
        CENTRE + Math.sin(angle) * radius,
      ] as Point;
    }),
    cornerRadius,
  );

/** The outline of a union of circles `[cx, cy, r]`, read as the farthest hit along each ray. */
const cloudOf = (circles: [number, number, number][], samples = 160): string =>
  polar((angle) => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let farthest = 0;
    for (const [cx, cy, r] of circles) {
      const dx = cx - CENTRE;
      const dy = cy - CENTRE;
      const along = cos * dx + sin * dy;
      const discriminant = along * along - (dx * dx + dy * dy) + r * r;
      if (discriminant <= 0) continue;
      const hit = along + Math.sqrt(discriminant);
      if (hit > farthest) farthest = hit;
    }
    return [CENTRE + cos * farthest, CENTRE + sin * farthest];
  }, samples);

const superellipse = (a: number, b: number, n: number): string =>
  polar((angle) => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [
      CENTRE + Math.sign(cos) * Math.abs(cos) ** (2 / n) * a,
      CENTRE + Math.sign(sin) * Math.abs(sin) ** (2 / n) * b,
    ];
  });

const tablet = (halfWidth: number, radius: number): string =>
  new PathBuilder()
    .move(CENTRE - halfWidth + radius, CENTRE - radius)
    .line(CENTRE + halfWidth - radius, CENTRE - radius)
    .arc(
      CENTRE + halfWidth - radius,
      CENTRE,
      radius,
      radius,
      -Math.PI / 2,
      Math.PI / 2,
    )
    .line(CENTRE - halfWidth + radius, CENTRE + radius)
    .arc(
      CENTRE - halfWidth + radius,
      CENTRE,
      radius,
      radius,
      Math.PI / 2,
      (Math.PI * 3) / 2,
    )
    .close();

const capsule = (halfWidth: number, halfHeight: number): string =>
  new PathBuilder()
    .move(CENTRE - halfWidth, CENTRE + halfHeight - halfWidth)
    .line(CENTRE - halfWidth, CENTRE - halfHeight + halfWidth)
    .arc(
      CENTRE,
      CENTRE - halfHeight + halfWidth,
      halfWidth,
      halfWidth,
      Math.PI,
      TAU,
    )
    .line(CENTRE + halfWidth, CENTRE + halfHeight - halfWidth)
    .arc(
      CENTRE,
      CENTRE + halfHeight - halfWidth,
      halfWidth,
      halfWidth,
      0,
      Math.PI,
    )
    .close();

const cylinder = (halfWidth: number, halfHeight: number, cap: number): string =>
  new PathBuilder()
    .move(CENTRE - halfWidth, CENTRE - halfHeight + cap)
    .arc(CENTRE, CENTRE - halfHeight + cap, halfWidth, cap, Math.PI, TAU)
    .line(CENTRE + halfWidth, CENTRE + halfHeight - cap)
    .arc(CENTRE, CENTRE + halfHeight - cap, halfWidth, cap, 0, Math.PI)
    .close();

const dome = (halfWidth: number, halfHeight: number, foot: number): string => {
  const bottom = CENTRE + halfHeight;
  return new PathBuilder()
    .move(CENTRE - halfWidth, bottom - foot)
    .arc(CENTRE, bottom - foot, halfWidth, 2 * halfHeight - foot, Math.PI, TAU)
    .line(CENTRE + halfWidth, bottom - foot)
    .curve(
      CENTRE + halfWidth,
      bottom,
      CENTRE + halfWidth,
      bottom,
      CENTRE + halfWidth - foot,
      bottom,
    )
    .line(CENTRE - halfWidth + foot, bottom)
    .curve(
      CENTRE - halfWidth,
      bottom,
      CENTRE - halfWidth,
      bottom,
      CENTRE - halfWidth,
      bottom - foot,
    )
    .close();
};

const arch = (halfWidth: number, halfHeight: number, foot: number): string => {
  const bottom = CENTRE + halfHeight;
  const shoulder = CENTRE - halfHeight + halfWidth;
  return new PathBuilder()
    .move(CENTRE - halfWidth, shoulder)
    .arc(CENTRE, shoulder, halfWidth, halfWidth, Math.PI, TAU)
    .line(CENTRE + halfWidth, bottom - foot)
    .curve(
      CENTRE + halfWidth,
      bottom,
      CENTRE + halfWidth,
      bottom,
      CENTRE + halfWidth - foot,
      bottom,
    )
    .line(CENTRE - halfWidth + foot, bottom)
    .curve(
      CENTRE - halfWidth,
      bottom,
      CENTRE - halfWidth,
      bottom,
      CENTRE - halfWidth,
      bottom - foot,
    )
    .close();
};

const shield = (
  halfWidth: number,
  halfHeight: number,
  shoulder: number,
): string => {
  const top = CENTRE - halfHeight;
  const bottom = CENTRE + halfHeight;
  return new PathBuilder()
    .move(CENTRE - halfWidth, top + shoulder)
    .curve(
      CENTRE - halfWidth,
      top - 2,
      CENTRE - halfWidth * 0.5,
      top - 10,
      CENTRE,
      top - 10,
    )
    .curve(
      CENTRE + halfWidth * 0.5,
      top - 10,
      CENTRE + halfWidth,
      top - 2,
      CENTRE + halfWidth,
      top + shoulder,
    )
    .curve(
      CENTRE + halfWidth,
      CENTRE + halfHeight * 0.42,
      CENTRE + halfWidth * 0.62,
      bottom,
      CENTRE,
      bottom,
    )
    .curve(
      CENTRE - halfWidth * 0.62,
      bottom,
      CENTRE - halfWidth,
      CENTRE + halfHeight * 0.42,
      CENTRE - halfWidth,
      top + shoulder,
    )
    .close();
};

const egg = (halfWidth: number, halfHeight: number, taper: number): string =>
  polar((angle) => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const toward = (1 - sin) / 2;
    return [
      CENTRE + cos * halfWidth * (1 - taper * toward * toward),
      CENTRE + sin * halfHeight,
    ];
  });

const teardrop = (
  radius: number,
  tipY: number,
  bulbY: number,
  tipRadius: number,
): string => {
  const ratio = clamp(radius / (bulbY - tipY), -1, 1);
  const side = Math.sqrt(1 - ratio * ratio);
  const right: Point = [CENTRE + radius * side, bulbY - radius * ratio];
  const left: Point = [CENTRE - radius * side, bulbY - radius * ratio];
  const angle = Math.atan2(right[1] - bulbY, right[0] - CENTRE);
  return new PathBuilder()
    .corner(right, [CENTRE, tipY], left, tipRadius)
    .line(left[0], left[1])
    .arc(CENTRE, bulbY, radius, radius, Math.PI - angle, angle)
    .close();
};

const leaf = (halfWidth: number, halfHeight: number, point: number): string =>
  polar((angle) => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [
      CENTRE +
        cos * halfWidth * Math.max(1 - sin * sin, 0) ** (point / 2 - 0.5),
      CENTRE + sin * halfHeight,
    ];
  });

const bean = (
  halfWidth: number,
  halfHeight: number,
  dent: number,
  where: number,
): string =>
  polar((angle) => {
    const near = (at: number) => {
      const away = Math.abs(
        ((((angle - at + Math.PI) % TAU) + TAU) % TAU) - Math.PI,
      );
      return Math.exp(-(away * away) / 0.4232);
    };
    const scale = 1 - dent * near(where) + dent * 0.34 * near(where + Math.PI);
    return [
      CENTRE + Math.cos(angle) * halfWidth * scale,
      CENTRE + Math.sin(angle) * halfHeight * scale,
    ];
  });

const pebble = (radius: number, wobble: number, phase: number): string =>
  polar((angle) => {
    const r =
      radius *
      (1 +
        wobble *
          (Math.sin(angle * 2 + phase) * 0.6 +
            Math.sin(angle * 3 - phase) * 0.4));
    return [CENTRE + Math.cos(angle) * r, CENTRE + Math.sin(angle) * r * 0.98];
  });

/** The one drawn body. Grok's blob is a hand-made path; a formula never quite got its shoulders. */
const BLOB_PATH =
  "M228.541 114.228C228.541 130.133 225.184 145.994 218.738 160.534C212.674 174.217 203.904 186.669 193.065 196.988C155.933 232.34 99.497 238.596 55.5255 212.24C45.097 205.99 35.6851 198.072 27.7451 188.866C19.1926 178.953 12.3686 167.569 7.65781 155.351C2.60712 142.264 0 128.257 0 114.228C0 98.3219 3.35751 82.4611 9.80315 67.9215C15.8672 54.2382 24.6377 41.7862 35.4767 31.4668C72.6081 -3.88483 129.044 -10.1413 173.016 16.2153C183.444 22.4653 192.856 30.3829 200.796 39.5896C209.349 49.5018 216.173 60.8859 220.883 73.1037C225.934 86.1906 228.541 100.198 228.541 114.228Z";

/** Walk a path into points roughly `step` units apart, for measuring. */
export const flattenPath = (path: string, step = 4): Point[] => {
  const tokens = path.match(/[MLCQZmlcqz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const points: Point[] = [];
  let index = 0;
  let command = "";
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const number = () => Number.parseFloat(tokens[index++] as string);
  const sample = (at: (t: number) => Point, length: number) => {
    const pieces = Math.max(2, Math.ceil(length / step));
    for (let piece = 1; piece <= pieces; piece += 1)
      points.push(at(piece / pieces));
  };
  while (index < tokens.length) {
    const token = tokens[index] as string;
    if (/[a-z]/i.test(token))
      command = (tokens[index++] as string).toUpperCase();
    if (command === "Z") {
      const length = Math.hypot(startX - x, startY - y);
      if (length > 0.01) {
        const [fromX, fromY] = [x, y];
        sample(
          (t) => [fromX + (startX - fromX) * t, fromY + (startY - fromY) * t],
          length,
        );
      }
      x = startX;
      y = startY;
      continue;
    }
    if (index >= tokens.length) break;
    if (command === "M") {
      x = number();
      y = number();
      startX = x;
      startY = y;
      points.push([x, y]);
      command = "L";
    } else if (command === "L") {
      const toX = number();
      const toY = number();
      const [fromX, fromY] = [x, y];
      sample(
        (t) => [fromX + (toX - fromX) * t, fromY + (toY - fromY) * t],
        Math.hypot(toX - fromX, toY - fromY),
      );
      x = toX;
      y = toY;
    } else if (command === "Q") {
      const cx = number();
      const cy = number();
      const toX = number();
      const toY = number();
      const [fromX, fromY] = [x, y];
      sample(
        (t) => {
          const u = 1 - t;
          return [
            u * u * fromX + 2 * u * t * cx + t * t * toX,
            u * u * fromY + 2 * u * t * cy + t * t * toY,
          ];
        },
        Math.hypot(cx - fromX, cy - fromY) + Math.hypot(toX - cx, toY - cy),
      );
      x = toX;
      y = toY;
    } else if (command === "C") {
      const x1 = number();
      const y1 = number();
      const x2 = number();
      const y2 = number();
      const toX = number();
      const toY = number();
      const [fromX, fromY] = [x, y];
      sample(
        (t) => {
          const u = 1 - t;
          return [
            u * u * u * fromX +
              3 * u * u * t * x1 +
              3 * u * t * t * x2 +
              t * t * t * toX,
            u * u * u * fromY +
              3 * u * u * t * y1 +
              3 * u * t * t * y2 +
              t * t * t * toY,
          ];
        },
        Math.hypot(x1 - fromX, y1 - fromY) +
          Math.hypot(x2 - x1, y2 - y1) +
          Math.hypot(toX - x2, toY - y2),
      );
      x = toX;
      y = toY;
    } else {
      index += 1;
    }
  }
  return points;
};

/** Rescale every coordinate pair in a path about the centre, after shifting it. */
const rewrite = (
  path: string,
  scale: number,
  dx: number,
  dy: number,
): string => {
  let isY = false;
  return path.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (token) => {
    isY = !isY;
    const value = Number.parseFloat(token) + (isY ? dx : dy);
    return String(round2(CENTRE + (value - CENTRE) * scale));
  });
};

/** Centre a body and make its longest side `SPAN`, within the tolerance Grok allows itself. */
const normalise = (path: string): string => {
  const points = flattenPath(path);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const dx = CENTRE - (minX + maxX) / 2;
  const dy = CENTRE - (minY + maxY) / 2;
  const scale = clamp(SPAN / Math.max(maxX - minX, maxY - minY), 0.9, 1.35);
  if (Math.abs(scale - 1) < 0.005 && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5)
    return path;
  return rewrite(path, scale, dx, dy);
};

/**
 * The body's horizontal extent at each height, so an eye can be kept inside the skin.
 *
 * `spanAt(y)` answers the inner span: the rightmost outline crossing left of centre and the
 * leftmost crossing right of it — which is the body's own width on that row even for a cloud whose
 * lobes overlap.
 */
const measureSpans = (points: Point[], rows = 160) => {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const [, y] of points) {
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  const height = bottom - top;
  const rowY = (row: number) => top + (height * (row + 0.5)) / rows;
  const left = new Float64Array(rows);
  const right = new Float64Array(rows);
  for (let row = 0; row < rows; row += 1) {
    const y = rowY(row);
    let innerLeft = Number.NEGATIVE_INFINITY;
    let innerRight = Number.POSITIVE_INFINITY;
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index] as Point;
      const b = points[(index + 1) % points.length] as Point;
      if (a[1] <= y === b[1] <= y) continue;
      const x = a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]);
      if (x <= CENTRE) {
        if (x > innerLeft) innerLeft = x;
      } else if (x < innerRight) innerRight = x;
    }
    left[row] = Number.isFinite(innerLeft) ? innerLeft : CENTRE;
    right[row] = Number.isFinite(innerRight) ? innerRight : CENTRE;
  }
  const spanAt = (y: number): [number, number] => {
    const at = clamp(((y - top) / height) * rows - 0.5, 0, rows - 1);
    const row = Math.floor(at);
    const next = Math.min(row + 1, rows - 1);
    const mix = at - row;
    return [
      (left[row] as number) +
        ((left[next] as number) - (left[row] as number)) * mix,
      (right[row] as number) +
        ((right[next] as number) - (right[row] as number)) * mix,
    ];
  };
  return { top, bottom, spanAt };
};

const ASPECTS = [1 / 1.45, 1 / 1.25, 1 / 1.12, 1, 1.12, 1.25, 1.45];

/**
 * Where the face goes: the largest ellipse that fits inside the outline, preferring the upper
 * middle. Grok searches a coarse grid and then refines around the winner; so does this.
 */
const placeFace = (points: Point[]) => {
  const sampled: Point[] = [];
  const stride = Math.max(1, Math.round(points.length / 110));
  for (let index = 0; index < points.length; index += stride)
    sampled.push(points[index] as Point);
  let best = { score: -1, x: CENTRE, y: CENTRE, a: 1, b: 1 };
  const consider = (x: number, y: number, aspect: number) => {
    let nearest = Number.POSITIVE_INFINITY;
    for (const [px, py] of sampled) {
      const dx = px - x;
      const dy = (py - y) * aspect;
      const distance = dx * dx + dy * dy;
      if (distance < nearest) nearest = distance;
    }
    nearest = Math.sqrt(nearest);
    const b = nearest / aspect;
    const score =
      nearest *
      b *
      (1 - 0.0018 * Math.abs(y - CENTRE) - 0.004 * Math.abs(x - CENTRE));
    if (score > best.score) best = { score, x, y, a: nearest, b };
  };
  for (let y = CENTRE - 56; y <= CENTRE + 56; y += 8) {
    for (let x = CENTRE - 16; x <= CENTRE + 16; x += 8) {
      for (const aspect of ASPECTS) consider(x, y, aspect);
    }
  }
  const { x: bestX, y: bestY } = best;
  for (let y = bestY - 8; y <= bestY + 8; y += 2) {
    for (let x = bestX - 8; x <= bestX + 8; x += 2) {
      for (const aspect of ASPECTS) consider(x, y, aspect);
    }
  }
  const sx = clamp(best.a / CENTRE, 0.3, 1);
  const sy = clamp(best.b / CENTRE, 0.3, 1);
  return {
    x: round2(best.x - CENTRE),
    y: round2(best.y - CENTRE),
    sx: round2(sx),
    sy: round2(sy),
    eye: round2(
      clamp((Math.min(sx, sy) * 0.7 + Math.max(sx, sy) * 0.3) * 1.12, 0.64, 1),
    ),
  };
};

/** How much of a rotation the body shows; a flat-bottomed body rocks, a round one rolls. */
const tiltScaleOf = (
  spanAt: (y: number) => [number, number],
  bottom: number,
) => {
  const width = (up: number) => {
    const [left, right] = spanAt(bottom - up);
    return right - left;
  };
  const wide = width(9);
  const ratio = wide < 1 ? 0 : width(1) / wide;
  return round2(clamp(1 - 1.9 * (ratio - 0.36), 0.15, 1));
};

export type FacePlacement = {
  x: number;
  y: number;
  sx: number;
  sy: number;
  eye: number;
  /** The left eye's extra offset, for the wedge whose apex would otherwise crowd it. */
  leftDX: number;
};

export type BodyShape = {
  id: ShapeId;
  label: string;
  path: string;
  top: number;
  bottom: number;
  radius: number;
  tiltScale: number;
  spanAt: (y: number) => [number, number];
  face: FacePlacement;
};

export const SHAPE_IDS = [
  "blob",
  "pebble",
  "bean",
  "egg",
  "squircle",
  "tablet",
  "capsule",
  "cylinder",
  "hex",
  "gem",
  "crystal",
  "wedge",
  "shield",
  "dome",
  "arch",
  "cloud",
  "teardrop",
  "leaf",
] as const;

export type ShapeId = (typeof SHAPE_IDS)[number];

/** The eight a Bot is dealt when nobody chose; the other ten are in the picker. */
export const DEFAULT_SHAPE_IDS: readonly ShapeId[] = [
  "blob",
  "pebble",
  "squircle",
  "tablet",
  "wedge",
  "hex",
  "cloud",
  "teardrop",
];

const RAW: Record<
  ShapeId,
  { label: string; path: () => string; leftDX?: number }
> = {
  blob: { label: "Blob", path: () => BLOB_PATH },
  pebble: { label: "Pebble", path: () => pebble(108, 0.075, 1.1) },
  bean: { label: "Bean", path: () => bean(94, 112, 0.34, Math.PI) },
  egg: { label: "Egg", path: () => egg(98, 113, 0.22) },
  squircle: { label: "Squircle", path: () => superellipse(107, 107, 4.2) },
  tablet: { label: "Tablet", path: () => tablet(114, 74) },
  capsule: { label: "Capsule", path: () => capsule(72, 113) },
  cylinder: { label: "Cylinder", path: () => cylinder(94, 110, 34) },
  hex: { label: "Hex", path: () => regularPolygon(114, 6, 20, Math.PI / 6) },
  gem: { label: "Gem", path: () => superellipse(112, 113, 1.5) },
  crystal: {
    label: "Crystal",
    path: () =>
      rounded(
        [
          [CENTRE, CENTRE - 113],
          [CENTRE + 76, CENTRE - 52],
          [CENTRE + 76, CENTRE + 52],
          [CENTRE, CENTRE + 113],
          [CENTRE - 76, CENTRE + 52],
          [CENTRE - 76, CENTRE - 52],
        ],
        [20, 26],
      ),
  },
  wedge: {
    label: "Wedge",
    path: () => regularPolygon(130, 3, 60, -Math.PI / 2),
    leftDX: -6,
  },
  shield: { label: "Shield", path: () => shield(98, 108, 30) },
  dome: { label: "Dome", path: () => dome(114, 82, 26) },
  arch: { label: "Arch", path: () => arch(76, 113, 20) },
  cloud: {
    label: "Cloud",
    path: () =>
      cloudOf([
        [CENTRE - 62, CENTRE + 26, 56],
        [CENTRE + 62, CENTRE + 26, 54],
        [CENTRE, CENTRE + 34, 62],
        [CENTRE - 24, CENTRE - 30, 62],
        [CENTRE + 38, CENTRE - 26, 54],
      ]),
  },
  teardrop: {
    label: "Teardrop",
    path: () => teardrop(88, CENTRE - 114, CENTRE + 26, 18),
  },
  leaf: { label: "Leaf", path: () => leaf(88, 113, 1.5) },
};

const built = new Map<ShapeId, BodyShape>();

/** A body, measured once and remembered: the path and everything the face needs to know about it. */
export function bodyShape(id: ShapeId): BodyShape {
  const cached = built.get(id);
  if (cached) return cached;
  const raw = RAW[id];
  const path = normalise(raw.path());
  const points = flattenPath(path);
  let radius = 0;
  for (const [x, y] of points)
    radius = Math.max(radius, Math.hypot(x - CENTRE, y - CENTRE));
  const { top, bottom, spanAt } = measureSpans(points);
  const shape: BodyShape = {
    id,
    label: raw.label,
    path,
    top,
    bottom,
    radius: round2(radius),
    tiltScale: tiltScaleOf(spanAt, bottom),
    spanAt,
    face: { ...placeFace(points), leftDX: raw.leftDX ?? 0 },
  };
  built.set(id, shape);
  return shape;
}

export const isShapeId = (value: string): value is ShapeId =>
  (SHAPE_IDS as readonly string[]).includes(value);
