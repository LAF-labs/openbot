/**
 * What a Bot's face is made of: a body and a colour, read from the seed string that names them.
 *
 * Shape and colour, and nothing else: the eyes are the expression engine's, and change with what
 * the Bot is doing. This module follows Grok Bot's own tables: its bodies (twelve kept, eight of
 * which are dealt to a Bot whose seed names none), its eleven colours, and the two hashes it uses to
 * deal a face from a name, so a Bot that was never given a named face gets the same one Grok would
 * give it.
 *
 * NOBODY CHOOSES A FACE SINCE 2026-10-08 (docs/laf/redesign-2026-10.md §8). A Bot made from then on
 * has its own id as its seed (`server/src/agents/profile-store.ts`), which is dealt a face below;
 * the picker that wrote named seeds, and the tables of names it showed, went that day. The named
 * grammar is still read, because every Bot that was given a face by the picker keeps it.
 *
 * SEED GRAMMAR: `s:<shape>.<colour>`, both names (`s:cloud.green`). Older seeds still resolve: the
 * `f:` and `g:` grammars of the generated avatars that preceded this one map their numeric shape
 * and palette onto these tables, and anything else — a tile id from the drawn era, a Bot's id, a
 * name — is hashed. Every Bot has a face; no seed is an error.
 */

import {
  DEFAULT_SHAPE_IDS,
  isShapeId,
  SHAPE_IDS,
  type ShapeId,
} from "./grok-shapes";

export const COLOR_IDS = [
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "violet",
  "magenta",
  "gray",
] as const;

export type ColorId = (typeof COLOR_IDS)[number];

/**
 * The colours a face can be drawn in. Black is left out as Grok leaves it out: a black body in
 * light mode is a white body in dark mode, which is a Bot that changes colour with the room.
 *
 * Names only. The fill each one has on a light and on a dark page is the stylesheet's
 * (`.bot-avatar-color-*` in `styles.css`), which is where the face is drawn from.
 */
export const FACE_COLOR_IDS: readonly ColorId[] = COLOR_IDS.filter(
  (id) => id !== "black",
);

export type BotAvatarParams = { shape: ShapeId; palette: ColorId };

export const isColorId = (value: string): value is ColorId =>
  (COLOR_IDS as readonly string[]).includes(value);

// —— Grok's two hashes, so an unnamed face lands where Grok would land it ——————————————————————

const fnv1a = (text: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/** A small PRNG seeded from a hash; one draw picks the colour. */
const mulberry = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 1831565813) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

/** Grok's colour deal: FNV of the key, salted, one PRNG draw over the colours a face can have. */
export const dealColor = (key: string): ColorId => {
  const salted = (fnv1a(key) ^ Math.imul(1, 2654435769)) >>> 0;
  const draw = mulberry((salted ^ Math.imul(1, 2654435769)) >>> 0);
  return FACE_COLOR_IDS[Math.floor(draw() * FACE_COLOR_IDS.length)] ?? "gray";
};

/** Grok's shape deal: an avalanche over FNV, modulo the eight default bodies. */
export const dealShape = (key: string): ShapeId => {
  let hash = fnv1a(key) | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 73244475);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  const index = ((hash ^ (hash >>> 16)) >>> 0) % DEFAULT_SHAPE_IDS.length;
  return DEFAULT_SHAPE_IDS[index] ?? "blob";
};

// —— The seed grammar ————————————————————————————————————————————————————————————————————————————

const NAMED = /^s:([a-z]+)\.([a-z]+)$/;
/** The two numeric grammars that came before: `f:<shape>.<palette>.<eyes>.<accessory>`, `g:<shape>.<palette>.<eyes>`. */
const NUMBERED = /^[fg]:(\d+)\.(\d+)(?:\.\d+)*$/;

/** The palettes of the numbered grammars, in the order they had, so an old seed keeps its colour. */
const NUMBERED_PALETTES: readonly ColorId[] = [
  "red",
  "orange",
  "green",
  "cyan",
  "blue",
  "violet",
  "magenta",
  "magenta",
  "brown",
  "gray",
];

export function botAvatarParams(seed: string | undefined): BotAvatarParams {
  const text = (seed ?? "").trim();
  const named = NAMED.exec(text);
  if (named) {
    const [, shape, palette] = named as unknown as [string, string, string];
    if (isShapeId(shape) && isColorId(palette) && palette !== "black") {
      return { shape, palette };
    }
  }
  const numbered = NUMBERED.exec(text);
  if (numbered) {
    const shape = Number.parseInt(numbered[1] as string, 10);
    const palette = Number.parseInt(numbered[2] as string, 10);
    return {
      shape: DEFAULT_SHAPE_IDS[shape % DEFAULT_SHAPE_IDS.length] ?? "blob",
      palette: NUMBERED_PALETTES[palette % NUMBERED_PALETTES.length] ?? "gray",
    };
  }
  return { shape: dealShape(text), palette: dealColor(text) };
}

export { DEFAULT_SHAPE_IDS, SHAPE_IDS, type ShapeId };
