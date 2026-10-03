/**
 * THE ONE READING COLUMN: the conversation's rows and the box under them are drawn in the same one.
 *
 * Until 2026-08-21 both were a centred 588px (`max-w-2xl` at a 14px root). That day the Bot's
 * answer became a bubble, each bubble capped its own measure, and the column went: the transcript
 * ran the width of the pane and the composer with it, because "the box a person types into has to
 * sit under the width it types into".
 *
 * The owner, 2026-10-04, chose "proposal A" for the conversation: the Bot's answer is words on the
 * page, with no plate round them. Words with no plate have nothing to cap them, and on a wide
 * window a sentence ran from one edge of the pane to the other. So the column is back, and it is
 * the measure: 720px across with the 16px each side inside it, so a row is at most 688px, and the
 * whole width with that same 16px where the window is narrower — which is every phone, and is what
 * a phone drew before.
 *
 * One string, read by the transcript and by the composer's wrapper (`conversation-view.tsx`), so
 * the two cannot drift: a composer one notch wider than the words above it is the misalignment
 * this is here to end. `max-w-180` is 180 × the 4px grid (`--spacing`, `styles.css`).
 *
 * A string, like `focus.ts` and `touch.ts`, so it composes into a `className`.
 */
export const readingColumn = "mx-auto w-full max-w-180 px-4";
