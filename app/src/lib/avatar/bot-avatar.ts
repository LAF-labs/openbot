/**
 * A Bot's face, generated rather than drawn.
 *
 * THE THIRTY-FIVE HAND-DRAWN MASCOTS ARE GONE. They were third-party character art (an MIT
 * showcase wall, redrawn as vectors) and they never belonged to this product: a rabbit, a bear and
 * an elephant standing in for colleagues, in wildly different rendering styles, at wildly different
 * weights on the page. Set five of them side by side in a roster and they do not read as one
 * family, which is the one job a set of avatars has.
 *
 * What replaces them is the shape Grok Bot uses: ONE CONSTANT STRUCTURE — a soft body with
 * expressive eyes — varied along four small axes. A body shape, a palette, a pair of eyes and an
 * accessory. That is enough for 6 x 10 x 4 x 7 = 1,680 faces that are all obviously the same kind
 * of thing, and it is why two Bots are still told apart almost peripherally in a list: the colour
 * carries at 20 pixels, the silhouette at 36, the accessory at 80.
 *
 * NOTHING HERE TOUCHES THE DOM. The component is a separate file; this one is arithmetic and a
 * table of numbers, so the geometry can be tested without rendering anything.
 *
 * ## The seed
 *
 * `f:<shape>.<palette>.<eyes>.<accessory>`, four integers — a seed that names its own face, which
 * is what lets the picker write a choice into the same column the old tile ids used and add nothing
 * to the schema.
 *
 * Anything else — a legacy `r4c5`, an agent id, free text somebody typed — is hashed into the same
 * parameter space. So every Bot created before this existed still comes up wearing one stable face,
 * on every machine, after every restart, and in a screenshot pasted into a ticket last week.
 */

/** Every body is inside a 96 x 96 box and is drawn to be recognisable at 20 pixels. */
export type BotAvatarShape = {
  id: string;
  /** What the shape is, in a word. Read aloud by the picker, so it goes through `t()`. */
  name: string;
  /** The body outline, as the `d` of one closed path. */
  d: string;
  /** The apex of the head, for the accessories that stand on top of it rather than lie on it. */
  crownY: number;
  /** Where an accessory that sits on the head belongs, and how wide the head is there. */
  capY: number;
  capW: number;
  /** Where the eyes sit, and how far apart. Per shape, because a drop is widest low and a pill high. */
  eyeY: number;
  eyeGap: number;
};

/**
 * THE BODIES ALL FIT INSIDE A CIRCLE OF RADIUS 47 ABOUT THE CENTRE.
 *
 * Half the call sites in this app wrap an avatar in `rounded-full overflow-hidden` — a decision
 * those screens are entitled to make, and one that would slice the corners off a squircle and turn
 * a pill into a disc. Keeping every outline inside the inscribed circle means the clip never cuts
 * anything: the silhouette survives where it is allowed to, and degrades to a circle where it is
 * not, instead of to a shape with a bite taken out of it.
 *
 * The second constraint is the fourteen pixels of headroom above every body. An antenna, a leaf and
 * a star have somewhere to be that is not on top of the eyes.
 */
export const BOT_AVATAR_SHAPES: readonly BotAvatarShape[] = [
  {
    id: "blob",
    name: "Blob",
    d: "M48 14C71 14 89 30 89 53C89 76 72 92 47 92C24 92 8 75 8 52C8 29 25 14 48 14Z",
    crownY: 14,
    capY: 34,
    capW: 37,
    eyeY: 54,
    eyeGap: 24,
  },
  {
    id: "squircle",
    name: "Rounded square",
    d: "M36 15H60C74.4 15 86 26.6 86 41V65C86 79.4 74.4 91 60 91H36C21.6 91 10 79.4 10 65V41C10 26.6 21.6 15 36 15Z",
    crownY: 15,
    capY: 35,
    capW: 36,
    eyeY: 54,
    eyeGap: 24,
  },
  {
    id: "drop",
    name: "Drop",
    d: "M48 14C64 20 86 36 86 60C86 79 69 92 48 92C27 92 10 79 10 60C10 36 32 20 48 14Z",
    crownY: 14,
    capY: 36,
    capW: 32,
    eyeY: 58,
    eyeGap: 22,
  },
  {
    id: "hexagon",
    name: "Hexagon",
    d: "M57.5 19.5Q48 14 38.5 19.5L23.7 28Q14.2 33.5 14.2 44.5V61.5Q14.2 72.5 23.7 78L38.5 86.5Q48 92 57.5 86.5L72.3 78Q81.8 72.5 81.8 61.5V44.5Q81.8 33.5 72.3 28Z",
    crownY: 14,
    capY: 33,
    capW: 31,
    eyeY: 54,
    eyeGap: 23,
  },
  {
    id: "pill",
    name: "Pill",
    d: "M48 14C63 14 75 26 75 41V65C75 80 63 92 48 92C33 92 21 80 21 65V41C21 26 33 14 48 14Z",
    crownY: 14,
    capY: 32,
    capW: 26,
    eyeY: 50,
    eyeGap: 18,
  },
  {
    id: "triangle",
    name: "Triangle",
    d: "M55.7 32.2Q48 17 40.3 32.2L19.7 72.8Q12 88 29 88H67Q84 88 76.3 72.8Z",
    crownY: 17,
    capY: 52,
    capW: 19,
    eyeY: 60,
    eyeGap: 22,
  },
] as const;

export type BotAvatarPalette = {
  id: string;
  name: string;
  /** The body. Also what `botAvatarBackground` hands to a surface carrying the colour itself. */
  fill: string;
  /** The same colour a step down, for the underside shade and the cheeks. */
  shade: string;
  /** The accessory, chosen to contrast with the body rather than to match it. */
  accent: string;
  /** The eyes. Dark, tinted toward the body, never pure black. */
  ink: string;
};

/**
 * TEN, ALL AT ROUGHLY THE SAME LIGHTNESS.
 *
 * This is the constraint that makes a roster look like one family: a set that mixes a pale pastel
 * with a saturated primary reads as two products, and the saturated one wins every glance whether
 * or not it is the Bot you were looking for. Everything here is soft-saturated and mid-light, which
 * also happens to be the band that survives both themes — the app's ground is #fcfcfc in light and
 * #070707 in dark, and a face has to be legible against both without being repainted.
 *
 * The eyes are a dark tint of the body rather than black. Black eyes on ten different bodies is the
 * one detail that made the generated set look assembled rather than drawn.
 */
export const BOT_AVATAR_PALETTES: readonly BotAvatarPalette[] = [
  {
    id: "coral",
    name: "Coral",
    fill: "#ff9d8a",
    shade: "#e5705c",
    accent: "#3f4a63",
    ink: "#3a2b2b",
  },
  {
    id: "amber",
    name: "Amber",
    fill: "#ffc46b",
    shade: "#e59a3c",
    accent: "#4a6b62",
    ink: "#46331c",
  },
  {
    id: "lime",
    name: "Lime",
    fill: "#b6d97a",
    shade: "#8ab453",
    accent: "#5b4a72",
    ink: "#2f3a20",
  },
  {
    id: "mint",
    name: "Mint",
    fill: "#7fd7b4",
    shade: "#4fb08d",
    accent: "#5a4a3f",
    ink: "#1f3a31",
  },
  {
    id: "sky",
    name: "Sky",
    fill: "#8ec7f5",
    shade: "#5b9fd8",
    accent: "#f0a04b",
    ink: "#22374d",
  },
  {
    id: "periwinkle",
    name: "Periwinkle",
    fill: "#a8b3f2",
    shade: "#7a86d4",
    accent: "#3d4a5c",
    ink: "#2a2e52",
  },
  {
    id: "lilac",
    name: "Lilac",
    fill: "#c7a6ec",
    shade: "#9f79cd",
    accent: "#6fbfa5",
    ink: "#33254a",
  },
  {
    id: "rose",
    name: "Rose",
    fill: "#f3a8c8",
    shade: "#cf7ba3",
    accent: "#4b5b8a",
    ink: "#442838",
  },
  {
    id: "sand",
    name: "Sand",
    fill: "#e3cba6",
    shade: "#c0a274",
    accent: "#6b8f78",
    ink: "#3d3324",
  },
  {
    id: "slate",
    name: "Slate",
    fill: "#a9b4bd",
    shade: "#7f8b96",
    accent: "#e8a44f",
    ink: "#29323a",
  },
] as const;

export type BotAvatarEyes = { id: string; name: string };

/**
 * Four, and none of them is in the picker.
 *
 * A row of four tiles whose difference is two pixels of eyelid is a row that costs a person a
 * decision and gives them nothing back. The shuffle deals them; the rows below choose the three
 * axes somebody can actually see from across a table.
 */
export const BOT_AVATAR_EYES: readonly BotAvatarEyes[] = [
  { id: "dot", name: "Dot" },
  { id: "oval", name: "Oval" },
  { id: "half-moon", name: "Half-moon" },
  { id: "ring", name: "Ring" },
] as const;

export type BotAvatarAccessory = { id: string; name: string };

export const BOT_AVATAR_ACCESSORIES: readonly BotAvatarAccessory[] = [
  { id: "none", name: "No accessory" },
  { id: "cap", name: "Cap" },
  { id: "bow", name: "Bow" },
  { id: "glasses", name: "Glasses" },
  { id: "antenna", name: "Antenna" },
  { id: "leaf", name: "Leaf" },
  { id: "star", name: "Star" },
] as const;

export type BotAvatarParams = {
  shape: number;
  palette: number;
  eyes: number;
  accessory: number;
};

/** The grammar, as one expression, so the parser and the formatter cannot drift apart. */
const SEED = /^f:(\d{1,4})\.(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

/**
 * FNV-1a, because the same Bot has to land on the same face everywhere.
 *
 * Any stable hash would do; what matters is that it is written down here rather than left to a
 * runtime that is free to change its mind between versions. Kept identical to the one the mascot
 * set used, so nothing about the choice of hash is what changed under anybody's Bot.
 */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Four indices out of one string, by hashing it four times with a different salt each time.
 *
 * NOT BY SLICING THE BITS OF ONE HASH. FNV's low bits are the least mixed part of it, and taking
 * `h % 6` and `(h >>> 3) % 10` off the same word correlates the shape with the palette — which
 * shows up as a set where every blob is coral, in exactly the place a person is meant to be reading
 * two independent signals.
 */
function hashed(seed: string): BotAvatarParams {
  return {
    shape: hash(`shape:${seed}`) % BOT_AVATAR_SHAPES.length,
    palette: hash(`palette:${seed}`) % BOT_AVATAR_PALETTES.length,
    eyes: hash(`eyes:${seed}`) % BOT_AVATAR_EYES.length,
    accessory: hash(`accessory:${seed}`) % BOT_AVATAR_ACCESSORIES.length,
  };
}

/**
 * The four numbers behind a face. Never fails, never returns anything out of range.
 *
 * A seed in the grammar is taken at its word, with each index folded into range rather than
 * rejected: a build that grows a seventh shape and then meets `f:9.…` written by a build that had
 * nine must draw SOMETHING, and the same something every time.
 */
export function botAvatarParams(seed: string | undefined): BotAvatarParams {
  const match = seed === undefined ? null : SEED.exec(seed);
  if (!match) return hashed(seed ?? "");
  const [shape, palette, eyes, accessory] = match
    .slice(1)
    .map((part) => Number.parseInt(part, 10));
  return {
    shape: (shape ?? 0) % BOT_AVATAR_SHAPES.length,
    palette: (palette ?? 0) % BOT_AVATAR_PALETTES.length,
    eyes: (eyes ?? 0) % BOT_AVATAR_EYES.length,
    accessory: (accessory ?? 0) % BOT_AVATAR_ACCESSORIES.length,
  };
}

/** The seed that names this face. `botAvatarParams` round-trips it. */
export function botAvatarSeed(params: BotAvatarParams): string {
  return `f:${params.shape}.${params.palette}.${params.eyes}.${params.accessory}`;
}

/** A stable, normalised seed for whatever was passed in — including nothing at all. */
export function botAvatarIdFor(seed: string | undefined): string {
  return botAvatarSeed(botAvatarParams(seed));
}

/**
 * A face nobody chose.
 *
 * The randomness is a parameter so a test can hand it a sequence and a shuffle button can hand it
 * `Math.random`. A generator whose only source of chance is ambient is a generator no test can say
 * anything about.
 */
export function randomBotAvatarSeed(rng: () => number = Math.random): string {
  const pick = (count: number) =>
    Math.min(count - 1, Math.max(0, Math.floor(rng() * count)));
  return botAvatarSeed({
    shape: pick(BOT_AVATAR_SHAPES.length),
    palette: pick(BOT_AVATAR_PALETTES.length),
    eyes: pick(BOT_AVATAR_EYES.length),
    accessory: pick(BOT_AVATAR_ACCESSORIES.length),
  });
}

/** The Bot's colour, for a surface that wants to carry it without drawing the face. */
export function botAvatarBackground(seed: string | undefined): string {
  const { palette } = botAvatarParams(seed);
  return BOT_AVATAR_PALETTES[palette]?.fill ?? "#a9b4bd";
}

/**
 * Which of five idle phases this face keeps.
 *
 * Every avatar on a page runs the same blink animation, and a page-load-synchronised blink across a
 * roster of five is not "alive", it is a row of machines. The delay cannot be an inline style (this
 * app writes classes), so it is one of five classes, chosen from the seed — stable per Bot, and
 * different from its neighbour's often enough that the roster stops blinking in unison.
 */
export function botAvatarPhase(seed: string | undefined): number {
  return hash(`phase:${seed ?? ""}`) % 5;
}
