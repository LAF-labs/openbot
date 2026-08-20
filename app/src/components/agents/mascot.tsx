import { MASCOT_ART } from "@/components/agents/mascot-art";

/**
 * Every Bot's face, from a drawn set rather than from a generator.
 *
 * `boring-avatars` gave each Bot a different arrangement of the same gradient, which at 32 pixels in
 * a sidebar is a different smudge per coworker. These are characters: a person can tell two of them
 * apart across the room, which is the whole job an avatar has in a roster. The art itself lives in
 * mascot-art.ts, with the story of why it is vectors.
 *
 * A Bot with no face chosen gets one from its seed rather than at random, so the same Bot is the
 * same character on every machine, after every restart, and in a screenshot pasted into a ticket
 * last week. The seed doubles as the choice: a seed that names a tile is that tile, and anything
 * else is hashed into one. Nothing was added to the schema to let somebody pick, and a Bot created
 * before the set existed still comes up with a face.
 */

export type MascotTile = { id: string; name: string; background: string };

/** Sorted, so the picker's order and the hash below do not depend on declaration order. */
export const MASCOT_TILES: MascotTile[] = Object.keys(MASCOT_ART)
  .sort()
  .map((id) => ({
    id,
    name: MASCOT_ART[id]?.name ?? id,
    background: MASCOT_ART[id]?.background ?? "#2B2B2B",
  }));

/**
 * FNV-1a, because the same Bot has to land on the same face everywhere.
 *
 * Any stable hash would do; what matters is that it is written down here rather than left to a
 * runtime that is free to change its mind between versions.
 */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The tile id for a seed: the one it names, or the one it hashes to. Never nothing. */
export function mascotIdFor(seed: string | undefined): string {
  if (seed !== undefined && seed in MASCOT_ART) return seed;
  const ids = MASCOT_TILES;
  return ids[hash(seed ?? "") % ids.length]?.id ?? "r0c0";
}

/** The ground a Bot's face sits on, for surfaces that want to carry its colour themselves. */
export function mascotBackground(seed: string | undefined): string {
  return MASCOT_ART[mascotIdFor(seed)]?.background ?? "#2B2B2B";
}

/**
 * One face.
 *
 * `aria-hidden`, always: every caller labels the avatar with the Bot's name, and a second
 * announcement reads the same coworker out twice. The markup is a checked-in constant from
 * mascot-art.ts — see the note there on why setting it as HTML is safe.
 */
export function Mascot({
  seed,
  size,
  className,
}: {
  seed: string | undefined;
  size: number;
  className?: string;
}) {
  const art = MASCOT_ART[mascotIdFor(seed)];
  if (!art) return null;

  return (
    <svg
      viewBox="0 0 96 96"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static art strings checked in beside this file.
      dangerouslySetInnerHTML={{ __html: art.markup }}
    />
  );
}
