import { BotAvatar } from "@/components/avatar/bot-avatar";
import { botAvatarIdFor } from "@/lib/avatar/bot-avatar";

/**
 * The old name for a Bot's face, kept for the callers that still say it.
 *
 * The face is `components/avatar/bot-avatar.tsx`; this module is three re-exports so the profile
 * and creation screens compile unchanged, and it goes when they stop importing it.
 */

/** The seed a Bot's face is actually drawn from: normalised, never nothing. */
export function mascotIdFor(seed: string | undefined): string {
  return botAvatarIdFor(seed);
}

/**
 * Nothing goes directly behind a face. A generated body is a shape on transparency: paint its own
 * fill behind it and the silhouette disappears into the square (measured — Bot cards became
 * coloured tiles with two eyes floating on them). Callers that still ask get a no-op.
 */
export function mascotBackground(_seed: string | undefined): string {
  return "transparent";
}

/** One face. `aria-hidden` always: every caller labels it with the Bot's name. */
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
