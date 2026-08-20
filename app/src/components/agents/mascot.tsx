import r0c0 from "../../assets/mascots/r0c0.webp";
import r0c1 from "../../assets/mascots/r0c1.webp";
import r0c2 from "../../assets/mascots/r0c2.webp";
import r0c3 from "../../assets/mascots/r0c3.webp";
import r0c4 from "../../assets/mascots/r0c4.webp";
import r0c5 from "../../assets/mascots/r0c5.webp";
import r0c6 from "../../assets/mascots/r0c6.webp";
import r1c0 from "../../assets/mascots/r1c0.webp";
import r1c1 from "../../assets/mascots/r1c1.webp";
import r1c2 from "../../assets/mascots/r1c2.webp";
import r1c3 from "../../assets/mascots/r1c3.webp";
import r1c4 from "../../assets/mascots/r1c4.webp";
import r1c5 from "../../assets/mascots/r1c5.webp";
import r1c6 from "../../assets/mascots/r1c6.webp";
import r2c0 from "../../assets/mascots/r2c0.webp";
import r2c1 from "../../assets/mascots/r2c1.webp";
import r2c2 from "../../assets/mascots/r2c2.webp";
import r2c3 from "../../assets/mascots/r2c3.webp";
import r2c4 from "../../assets/mascots/r2c4.webp";
import r2c5 from "../../assets/mascots/r2c5.webp";
import r2c6 from "../../assets/mascots/r2c6.webp";
import r3c0 from "../../assets/mascots/r3c0.webp";
import r3c1 from "../../assets/mascots/r3c1.webp";
import r3c2 from "../../assets/mascots/r3c2.webp";
import r3c3 from "../../assets/mascots/r3c3.webp";
import r3c4 from "../../assets/mascots/r3c4.webp";
import r3c5 from "../../assets/mascots/r3c5.webp";
import r3c6 from "../../assets/mascots/r3c6.webp";
import r4c0 from "../../assets/mascots/r4c0.webp";
import r4c1 from "../../assets/mascots/r4c1.webp";
import r4c2 from "../../assets/mascots/r4c2.webp";
import r4c3 from "../../assets/mascots/r4c3.webp";
import r4c4 from "../../assets/mascots/r4c4.webp";
import r4c5 from "../../assets/mascots/r4c5.webp";
import r4c6 from "../../assets/mascots/r4c6.webp";

/**
 * Every Bot's face, from a set rather than from a generator.
 *
 * `boring-avatars` gives each Bot a different arrangement of the same gradient, which at 32 pixels in
 * a sidebar is a different smudge. These are drawn characters: a person can tell two of them apart
 * across a room, which is the whole job an avatar has in a roster.
 *
 * The set is the showcase wall from the ip-as-logo skill (s1dashu/ip-as-logo-skill, MIT), cut back
 * into its thirty-five tiles. See NOTICE at the repository root for the attribution.
 *
 * A Bot with no face chosen gets one from its seed rather than at random, so the same Bot is the same
 * character on every machine, after every restart, and in a screenshot somebody pasted into a ticket
 * last week. `avatarSeed` doubles as the choice: a seed that names a tile is that tile, and anything
 * else is hashed into one. Nothing had to be added to the schema to let somebody pick, and a Bot
 * created before the set existed still comes up with a face.
 */

/*
 * Explicit imports rather than `import.meta.glob`. The glob is Vite's, and this module is also
 * loaded by the test runner, which is not Vite; a component that only imports under one loader is a
 * component whose tests exercise a different program. Thirty-five lines of import is the entire
 * cost, and adding a tile is adding one.
 */
const URLS: Record<string, string> = {
  r0c0: r0c0,
  r0c1: r0c1,
  r0c2: r0c2,
  r0c3: r0c3,
  r0c4: r0c4,
  r0c5: r0c5,
  r0c6: r0c6,
  r1c0: r1c0,
  r1c1: r1c1,
  r1c2: r1c2,
  r1c3: r1c3,
  r1c4: r1c4,
  r1c5: r1c5,
  r1c6: r1c6,
  r2c0: r2c0,
  r2c1: r2c1,
  r2c2: r2c2,
  r2c3: r2c3,
  r2c4: r2c4,
  r2c5: r2c5,
  r2c6: r2c6,
  r3c0: r3c0,
  r3c1: r3c1,
  r3c2: r3c2,
  r3c3: r3c3,
  r3c4: r3c4,
  r3c5: r3c5,
  r3c6: r3c6,
  r4c0: r4c0,
  r4c1: r4c1,
  r4c2: r4c2,
  r4c3: r4c3,
  r4c4: r4c4,
  r4c5: r4c5,
  r4c6: r4c6,
};

/**
 * The ground each tile sits on, sampled once from its own edges and written down.
 *
 * Kept as data rather than read back off the image, because the one surface that needs it — the tile
 * on the Explore row — needs it before the picture has loaded, and a card that changes colour a
 * moment after it appears is worse than one that was the right colour to begin with.
 */
const BACKGROUNDS: Record<string, string> = {
  r0c0: "#B05943",
  r0c1: "#1050E7",
  r0c2: "#026DBF",
  r0c3: "#C3BEEF",
  r0c4: "#734A6C",
  r0c5: "#000000",
  r0c6: "#33756C",
  r1c0: "#BD5D4E",
  r1c1: "#000000",
  r1c2: "#605393",
  r1c3: "#2B3F56",
  r1c4: "#FEFEFE",
  r1c5: "#F4F2EC",
  r1c6: "#5674D6",
  r2c0: "#C15945",
  r2c1: "#B48730",
  r2c2: "#FAF9D0",
  r2c3: "#2B5840",
  r2c4: "#356699",
  r2c5: "#204C83",
  r2c6: "#8FA68A",
  r3c0: "#FC7953",
  r3c1: "#6E7967",
  r3c2: "#E6FBA7",
  r3c3: "#63778D",
  r3c4: "#393F3B",
  r3c5: "#000000",
  r3c6: "#6D4C6E",
  r4c0: "#363C35",
  r4c1: "#011A6D",
  r4c2: "#000000",
  r4c3: "#6F3CED",
  r4c4: "#764750",
  r4c5: "#5C76D4",
  r4c6: "#000000",
};

export type MascotTile = { id: string; url: string; background: string };

/** Sorted, so the picker's order and the hash below do not depend on declaration order. */
export const MASCOT_TILES: MascotTile[] = Object.keys(URLS)
  .sort()
  .map((id) => ({
    id,
    url: URLS[id] as string,
    background: BACKGROUNDS[id] ?? "#2B2B2B",
  }));

const BY_ID = new Map(MASCOT_TILES.map((tile) => [tile.id, tile]));

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

/** The face for a seed: the one it names, or the one it hashes to. Never nothing. */
export function mascotFor(seed: string | undefined): MascotTile {
  const chosen = seed === undefined ? undefined : BY_ID.get(seed);
  if (chosen) return chosen;
  const tile = MASCOT_TILES[hash(seed ?? "") % MASCOT_TILES.length];
  // MASCOT_TILES is never empty — the glob is a checked-in folder — but the type says it could be.
  return tile ?? { id: "", url: "", background: "#2B2B2B" };
}

/** Whether a seed names a tile outright, which is what "somebody chose this" looks like. */
export function isChosenMascot(seed: string | undefined): boolean {
  return seed !== undefined && BY_ID.has(seed);
}

/**
 * One face.
 *
 * `aria-hidden`, always: every caller labels the avatar with the Bot's name, and a second
 * announcement reads the same coworker out twice.
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
  const tile = mascotFor(seed);
  return (
    <img
      alt=""
      aria-hidden="true"
      className={className}
      draggable={false}
      height={size}
      src={tile.url}
      style={{ background: tile.background }}
      width={size}
    />
  );
}
