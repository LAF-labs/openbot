/**
 * What a Bot's face is made of: a body and a colour, and the seed string that names them.
 *
 * The owner's rule (2026-09-05): shape and colour are the only two choices a person makes. No
 * accessories, no eye styles to pick — the eyes are the expression engine's, and change with what
 * the Bot is doing. This module follows Grok Bot's own tables: its eighteen bodies (eight of which
 * are dealt to a Bot nobody chose a face for), its eleven colours with a light and a dark value each,
 * and the two hashes it uses to deal a face from a name, so a Bot that was never given a face gets
 * the same one Grok would give it.
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

export type BotAvatarColor = {
  id: ColorId;
  /** English, translated through `t()` at the picker. */
  name: string;
  /** The body fill on a light page. */
  light: string;
  /** The body fill on a dark page: a shade deeper, so the same colour reads the same. */
  dark: string;
};

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

const COLORS: Record<ColorId, BotAvatarColor> = {
  black: { id: "black", name: "Black", light: "#000000", dark: "#FFFFFF" },
  brown: { id: "brown", name: "Brown", light: "#A27952", dark: "#855C36" },
  red: { id: "red", name: "Red", light: "#FF3E51", dark: "#E02135" },
  orange: { id: "orange", name: "Orange", light: "#FF781C", dark: "#FF6700" },
  yellow: { id: "yellow", name: "Yellow", light: "#FFAF38", dark: "#FF9800" },
  green: { id: "green", name: "Green", light: "#00C972", dark: "#009957" },
  cyan: { id: "cyan", name: "Cyan", light: "#1CC3B0", dark: "#00A592" },
  blue: { id: "blue", name: "Blue", light: "#2A92FE", dark: "#0E74E0" },
  violet: { id: "violet", name: "Violet", light: "#A97EFE", dark: "#804EE0" },
  magenta: {
    id: "magenta",
    name: "Magenta",
    light: "#FF5EB1",
    dark: "#E02A88",
  },
  gray: { id: "gray", name: "Gray", light: "#959595", dark: "#777777" },
};

/**
 * The colours a person can pick. Black is left out here as Grok leaves it out: a black body in
 * light mode is a white body in dark mode, which is a Bot that changes colour with the room.
 */
export const BOT_AVATAR_PALETTES: readonly BotAvatarColor[] = COLOR_IDS.filter(
  (id) => id !== "black",
).map((id) => COLORS[id]);

export type BotAvatarShape = { id: ShapeId; name: string };

const SHAPE_NAMES: Record<ShapeId, string> = {
  blob: "Blob",
  pebble: "Pebble",
  bean: "Bean",
  egg: "Egg",
  squircle: "Squircle",
  tablet: "Tablet",
  capsule: "Capsule",
  cylinder: "Cylinder",
  hex: "Hex",
  gem: "Gem",
  crystal: "Crystal",
  wedge: "Wedge",
  shield: "Shield",
  dome: "Dome",
  arch: "Arch",
  cloud: "Cloud",
  teardrop: "Teardrop",
  leaf: "Leaf",
};

/** Every body, defaults first so the picker's first row is the eight a Bot is usually dealt. */
export const BOT_AVATAR_SHAPES: readonly BotAvatarShape[] = [
  ...DEFAULT_SHAPE_IDS,
  ...SHAPE_IDS.filter((id) => !DEFAULT_SHAPE_IDS.includes(id)),
].map((id) => ({ id, name: SHAPE_NAMES[id] }));

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

const PICKABLE = COLOR_IDS.filter((id) => id !== "black");

/** Grok's colour deal: FNV of the key, salted, one PRNG draw over the pickable colours. */
export const dealColor = (key: string): ColorId => {
  const salted = (fnv1a(key) ^ Math.imul(1, 2654435769)) >>> 0;
  const draw = mulberry((salted ^ Math.imul(1, 2654435769)) >>> 0);
  return PICKABLE[Math.floor(draw() * PICKABLE.length)] ?? "gray";
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

export function botAvatarSeed(params: BotAvatarParams): string {
  return `s:${params.shape}.${params.palette}`;
}

/** The seed a Bot's face is actually drawn from: normalised, never nothing. */
export function botAvatarIdFor(seed: string | undefined): string {
  return botAvatarSeed(botAvatarParams(seed));
}

/** A face nobody has yet: any body, any pickable colour. */
export function randomBotAvatarSeed(rng: () => number = Math.random): string {
  const pick = <T>(list: readonly T[]): T => {
    const index = Math.min(
      list.length - 1,
      Math.max(0, Math.floor(rng() * list.length)),
    );
    return list[index] as T;
  };
  return botAvatarSeed({ shape: pick(SHAPE_IDS), palette: pick(PICKABLE) });
}

export function botAvatarColor(seed: string | undefined): BotAvatarColor {
  return COLORS[botAvatarParams(seed).palette];
}

/** The body fill on a light page, for a chip or a ring that wants the Bot's colour. */
export function botAvatarBackground(seed: string | undefined): string {
  return botAvatarColor(seed).light;
}

export { DEFAULT_SHAPE_IDS, SHAPE_IDS, type ShapeId };
