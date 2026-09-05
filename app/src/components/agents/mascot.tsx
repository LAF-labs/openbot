import { BotAvatar } from "@/components/avatar/bot-avatar";
import {
  BOT_AVATAR_PALETTES,
  BOT_AVATAR_SHAPES,
  botAvatarIdFor,
  botAvatarSeed,
} from "@/lib/avatar/bot-avatar";

/**
 * The old name for a Bot's face, kept while the screens that call it are being rewritten.
 *
 * The faces themselves are `components/avatar/bot-avatar.tsx` now — generated from a seed rather
 * than picked out of thirty-five drawings somebody else made. This module is four re-exports so
 * that the Bot creation and profile screens keep compiling through a change that is landing beside
 * this one, and it goes the moment they stop importing it.
 */

export type MascotTile = { id: string; name: string; background: string };

/**
 * THE GROUND BEHIND A FACE IS NOW NOTHING, AND THAT IS NOT AN OVERSIGHT.
 *
 * The drawn mascots were 96x96 tiles with their own background rect, so a caller could ask for the
 * colour and paint the same square behind them. A generated face is a SHAPE on transparency: paint
 * its own fill behind it and the silhouette disappears into the square, which is measured — the Bot
 * cards became coloured tiles with two eyes floating on them, no blob, no pill, no drop.
 *
 * `botAvatarBackground` still hands out the fill hex, because a ring, a chip or a selected state
 * carrying the Bot's colour is a real thing to want. It is just never the thing DIRECTLY BEHIND the
 * face. These callers all want the latter, so they get nothing, and their `style={{ background }}`
 * becomes a no-op until the screens are rewritten and drop it.
 *
 * Declared here rather than beside `mascotBackground` below, because `MASCOT_TILES` reads it at
 * module evaluation and a `const` after that point is a temporal-dead-zone throw — measured as a
 * white screen on every route, with the typecheck perfectly happy.
 */
const NO_GROUND = "transparent";

/**
 * One tile per palette, for the two screens that still draw a grid of faces.
 *
 * The grid IS the thing being replaced — `BotAvatarPicker` asks for a shape, a colour and an
 * accessory separately, because a wall of finished faces makes somebody compare strangers instead
 * of adjusting their own. Ten is what remains here until those screens land: enough for a face to
 * pick, few enough that nobody mistakes it for the picker.
 */
export const MASCOT_TILES: MascotTile[] = BOT_AVATAR_PALETTES.map(
  (palette, index) => ({
    id: botAvatarSeed({
      shape: index % BOT_AVATAR_SHAPES.length,
      palette: index,
      eyes: index % 4,
      accessory: index % 7,
    }),
    name: palette.name,
    background: NO_GROUND,
  }),
);

/** The seed a Bot's face is actually drawn from: normalised, never nothing. */
export function mascotIdFor(seed: string | undefined): string {
  return botAvatarIdFor(seed);
}

/** See `NO_GROUND`. */
export function mascotBackground(_seed: string | undefined): string {
  return NO_GROUND;
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
  return <BotAvatar className={className} seed={seed} size={size} />;
}
