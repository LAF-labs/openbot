/**
 * ONE SURFACE FOR EVERYTHING THE BOT HANDS OVER IN THE CONVERSATION THAT IS NOT PROSE.
 *
 * The browsing card, the approval card, the help card and the routine card arrived in four packages
 * and came out as four surfaces: `rounded-2xl border p-2.5`, `rounded-md border bg-card px-3 py-2`
 * at full width, `rounded-2xl border p-3` with an amber edge, `rounded-2xl border bg-card p-3`. Side
 * by side in one conversation they read as four different apps' widgets. The same card now carries
 * all four — the corner, the width, the fill, the lift and the padding — and what differs is what is
 * in it, which is the only thing that should.
 *
 * Strings, like `focus.ts`, so they compose into an existing `cn()` without a new component, and so
 * Tailwind sees the utilities here whether or not a card is on screen.
 */

/** The card: 16px corners, the width a card keeps beside a 3xl transcript, a hairline and a lift. */
export const chatCard =
  "max-w-md rounded-2xl border border-border bg-card text-card-foreground shadow-card";

/** The card's padding, apart so a card with a picture edge-to-edge can leave it off. */
export const chatCardPadding = "p-3";

/**
 * The same card while it waits on the person — an approval not yet answered, a help request not yet
 * done. Amber, whatever the Bot's colour: "your turn" is a signal and must not look like a red Bot's
 * ordinary button or disappear on a yellow one. The edge is the only change, so the card does not
 * jump when the answer lands.
 */
export const chatCardWaiting = "border-warning/55";

/** The title line of a card: what this is about, in the card's one weight. */
export const chatCardTitle = "font-medium text-sm";

/** Everything under the title that is about the card rather than in it: status, time, site. */
export const chatCardMeta = "text-muted-foreground text-xs";

/** A short status word on a card's title line ("도움 필요", "건너뜀"). Tone is added beside it. */
export const chatCardChip =
  "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-medium text-xs";
