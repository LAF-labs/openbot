/**
 * ONE SPELLING OF THE FOCUS RING, FOR EVERYTHING THAT TAKES KEYBOARD FOCUS.
 *
 * The house ring was written out by hand in seven primitives and left out of five more. `button`,
 * `input`, `textarea`, `select`, `switch`, `bubble` and `item` each carried their own copy of
 * `focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50`; `combobox`,
 * `context-menu`, `dropdown-menu` and the sidebar carried a different one or none at all. Six copies
 * of a rule is six chances for one of them to drift, and the drift had already happened — the
 * sidebar's rows answer at `ring-2` against everything else's `ring-3`.
 *
 * These are strings, not a `cva` variant, so they compose into an existing `cn()` or `cva()` call
 * without changing a component's props. Tailwind reads class names out of source files, and this
 * file is source, so the utilities named here are generated whether or not any component is using
 * them today.
 *
 * `outline-hidden`, never `outline-none`, and the difference is not cosmetic. Both switch the native
 * outline off, but `outline-hidden` puts a transparent 2px outline back under
 * `@media (forced-colors: active)` — and in a forced-colours theme a `box-shadow` ring is not
 * painted at all, so `outline-none` leaves somebody using Windows High Contrast with no focus
 * indicator anywhere in the app. The app already spelled it both ways.
 *
 * THE RING IS THE BOT'S COLOUR SINCE 2026-09-24 (`--ring` is `--bot-accent`), and that changed what
 * carries the contrast. The old ring was a 50% halo of a 40% grey — about 1.3:1 against the page,
 * a hint rather than an indicator. Now the part that must clear 3:1 is solid: the recoloured border
 * on a control, the whole inset ring on a row. The halo around a control is 35% of the same colour,
 * there to make the solid line findable, not to carry it.
 */

/**
 * The house ring: for a control that owns a border of its own — a button, a field, a select.
 *
 * `border-ring` is half the effect. The ring is drawn OUTSIDE the border box, so without recolouring
 * the border the control keeps a grey outline with a blue-grey halo floating off it, which reads as
 * two rings rather than one. Only use this on something that actually has a border to recolour;
 * `focusRingInset` is the answer where there is none.
 */
export const focusRing =
  "outline-hidden focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/35";

/**
 * For a row inside a padded popup — a menu item, a combobox option, a listbox entry.
 *
 * Inset, because the ring on an outward-drawing control would spill over the popover's own 4px of
 * padding and clip against its rounded edge. Two pixels rather than three for the same reason.
 *
 * A menu item is NOT already covered by its `data-highlighted:bg-accent`. That highlight is
 * `--sand-fill-ghost-hover`, a 9% grey — 1.05:1 against the popover it sits on. It is a hint, not an
 * indicator, and on the keyboard it is the only thing telling somebody where they are.
 */
export const focusRingInset =
  "outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/**
 * For a container that is focused THROUGH a child — a chips field.
 *
 * The visible control is the wrapper; the thing that takes focus is the bare input inside it, and a
 * ring on that input draws a rectangle in the middle of the box it belongs to.
 */
export const focusRingWithin =
  "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/35";

/**
 * The same ring again, for the buttons and links a Bot's own prose puts inside a bubble.
 *
 * Those elements are not ours to give a className to — they arrive as rendered markdown — so the
 * bubble reaches down to them with a selector variant.
 *
 * Spelled out rather than composed, because Tailwind generates a utility only when it can SEE the
 * finished class name in a source file. `` `[button,a]:${focusRing}` `` produces the right string at
 * runtime and no CSS at all, which is the failure mode where the ring simply stops existing.
 */
export const focusRingNested =
  "[button,a]:outline-hidden [button,a]:focus-visible:border-ring [button,a]:focus-visible:ring-3 [button,a]:focus-visible:ring-ring/35";

/**
 * CHOSEN. Not focused, and it lives here so it cannot be confused with focused again.
 *
 * The app had four treatments for "this is the one you picked" and three of them were rings:
 * `ring-2 ring-primary` on the face picker, on the roster strip and on the effort chooser;
 * `ring-2 ring-primary ring-offset-1` on one of those; `bg-primary text-primary-foreground` in the
 * computer view; a hand-rolled `aria-pressed:` pill on Routines. A ring already means FOCUSED in
 * this design — the house ring is a 3px `--ring` halo — so three of the four said "chosen" in the
 * keyboard's own vocabulary, and a chosen-and-focused tile said it twice in two greys.
 *
 * So selection is a BORDER and a FILL, and focus keeps the rings. The two stack legibly: a hairline
 * in the foreground colour with a tinted ground, wrapped in the focus halo when it is also focused.
 *
 * The element must already have a border box for this to land — `border` with any colour, which
 * every `Button` has (`border border-transparent`). On a bare `div` add `border` first, or the
 * chosen state moves the layout by a pixel when it turns on.
 *
 * Keyed to `aria-pressed="true"`, which `Button` carries for free.
 *
 * `data-pressed` is deliberately NOT included, and this is the trap it avoids: Base UI overloads
 * that attribute. On `Toggle` it means "on"; on `Combobox.Trigger`, `Select.Trigger` and the rest it
 * means "the pointer is down on me right now". Styling `data-pressed` here would make every trigger
 * in the app flash the chosen treatment while it is being held.
 *
 * Written out rather than composed for the same reason as `focusRingNested`: Tailwind emits a
 * utility only for a class name it can SEE.
 */
export const selectedWhenPressed =
  "aria-pressed:border-foreground aria-pressed:bg-accent aria-pressed:text-foreground";
