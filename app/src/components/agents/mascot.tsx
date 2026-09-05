import { BotAvatar } from "@/components/avatar/bot-avatar";
import {
  BOT_AVATAR_PALETTES,
  BOT_AVATAR_SHAPES,
  botAvatarBackground,
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
    background: palette.fill,
  }),
);

/** The seed a Bot's face is actually drawn from: normalised, never nothing. */
export function mascotIdFor(seed: string | undefined): string {
  return botAvatarIdFor(seed);
}

/** The ground a Bot's face sits on, for surfaces that want to carry its colour themselves. */
export function mascotBackground(seed: string | undefined): string {
  return botAvatarBackground(seed);
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
