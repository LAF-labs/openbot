/**
 * THE RING THE HOUSE BUTTON DRAWS, FOR THE ONES THAT ARE NOT BUTTONS.
 *
 * Copied from the base of `buttonVariants` in `components/ui/button.tsx`. Every `<button>` written
 * by hand — a card that is really a link, a chip, a segment, a face that opens a picker — was
 * getting the browser's default outline or, worse, `outline-none` and nothing at all: measured on
 * the Bots pane, the routines row and the auto-review chips, where tabbing through simply stopped
 * being visible.
 *
 * A CONSTANT RATHER THAN A COPY IN EACH FILE, because the ring is a house style and a copy is a
 * thing that drifts. It belongs in `components/ui` and is expected there shortly; this is one
 * import away from re-exporting that when it lands, and nothing that uses it has to change.
 */
export const FOCUS_RING =
  "outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
