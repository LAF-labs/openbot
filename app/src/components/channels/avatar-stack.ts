/**
 * Where each face sits inside a group avatar's box, in pixels from its top-left.
 *
 * SEPARATE FROM THE COMPONENT SO IT CAN BE ASSERTED. What went wrong here was arithmetic, not
 * markup, and it was invisible to every test in the app: with two participants the old tile size
 * was `size / (length / 2)` — which for `length === 2` is `size / 1`, the full box. Two full-size
 * faces were drawn, the second shifted `translateX(-75%)` over the first, so all anybody ever saw
 * of the second Bot was an 8px crescent; and because the shifted disc still ran to `-75% + 100%`
 * of its own width, the group ran 8px PAST the `size` box it was told to fit in. Every room row in
 * the app was therefore 8px wider than every Bot row beside it — the sidebar, the room header and
 * the compose chips all failed to line up, and nothing said why.
 *
 * So the geometry is a function of `(count, size)` and nothing else, it returns pixels, and
 * `avatar-stack.test.ts` holds it to the one invariant that was broken: no face may leave the box.
 */
export type StackedFace = {
  /** Diameter in pixels. Every face in a stack shares one. */
  diameter: number;
  /** Offset from the box's left edge, in pixels. */
  left: number;
  /** Offset from the box's top edge, in pixels. */
  top: number;
};

/**
 * How much of the box one face takes, per crowd size.
 *
 * Each is large enough that the faces overlap — a stack has to read as a stack rather than as a
 * neat grid of dots — and small enough that the free space (`1 - fraction`) can hold the whole
 * arrangement. A drawn character at 36px is already small; two at 0.68 keep a recognisable face,
 * where the four-face cluster is frankly a texture that says "several".
 */
const DIAMETER_FRACTION = { four: 0.56, three: 0.6, two: 0.68 } as const;

/**
 * The faces of a group avatar, laid out to fill a `size × size` box without ever leaving it.
 *
 * Two sit on a diagonal, which overlaps them the way a hand of cards overlaps and keeps both faces
 * more than half visible. Three make a triangle, one over two. Four or more make a 2×2 cluster of
 * the first four; a room can hold eight, and eight faces at 36px is a grey smudge, so the rest are
 * counted by the row's name rather than drawn here.
 */
export function stackedFaces(count: number, size: number): StackedFace[] {
  if (count <= 1) {
    return [{ diameter: size, left: 0, top: 0 }];
  }

  if (count === 2) {
    const diameter = size * DIAMETER_FRACTION.two;
    // The only offset that fits, which is what makes overflow impossible rather than unlikely.
    const shift = size - diameter;
    return [
      { diameter, left: 0, top: 0 },
      { diameter, left: shift, top: shift },
    ];
  }

  if (count === 3) {
    const diameter = size * DIAMETER_FRACTION.three;
    const shift = size - diameter;
    return [
      { diameter, left: shift / 2, top: 0 },
      { diameter, left: 0, top: shift },
      { diameter, left: shift, top: shift },
    ];
  }

  const diameter = size * DIAMETER_FRACTION.four;
  const shift = size - diameter;
  return [
    { diameter, left: 0, top: 0 },
    { diameter, left: shift, top: 0 },
    { diameter, left: 0, top: shift },
    { diameter, left: shift, top: shift },
  ];
}

/** How many faces a stack of `count` participants actually draws. */
export function drawnFaceCount(count: number): number {
  return Math.min(Math.max(count, 1), 4);
}
