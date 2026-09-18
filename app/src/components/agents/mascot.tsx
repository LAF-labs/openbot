import { BotAvatar } from "@/components/avatar/bot-avatar";

/**
 * The old name for a Bot's face, kept for the callers that still say it.
 *
 * The face is `components/avatar/bot-avatar.tsx`; this module is one wrapper so the profile and
 * creation screens compile unchanged, and it goes when they stop importing it.
 */

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
