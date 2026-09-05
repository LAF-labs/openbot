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
  "outline-hidden focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

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
  "outline-hidden focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset";

/**
 * For a listbox option, where `focus-visible` is not a thing that can ever happen.
 *
 * A combobox keeps DOM focus in its input and points at the active option with
 * `aria-activedescendant` — Base UI's `Combobox.Item` renders with `tabIndex: undefined` and never
 * calls `.focus()`. So a `focus-visible:` rule on an option is dead CSS that looks like coverage,
 * and the attribute that actually moves is `data-highlighted`.
 *
 * That attribute is set by the pointer as well as by the arrow keys, so this ring shows on hover
 * too. Deliberate: the alternative is an option whose only marking is `bg-accent`, a 9% grey.
 */
export const highlightRing =
  "data-highlighted:ring-2 data-highlighted:ring-ring/50 data-highlighted:ring-inset";

/**
 * For a container that is focused THROUGH a child — a chips field, an input group.
 *
 * The visible control is the wrapper; the thing that takes focus is the bare input inside it, and a
 * ring on that input draws a rectangle in the middle of the box it belongs to.
 */
export const focusRingWithin =
  "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50";

/**
 * The same ring, drawn on the WRAPPER when a specific control inside it is focused.
 *
 * `focusRingWithin` is too broad for an input group: anything focusable in the row — the clear
 * button, the dropdown trigger — would light the whole field up. This keys on the control itself.
 */
export const focusRingHasControl =
  "has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-3 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50";

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
  "[button,a]:outline-hidden [button,a]:focus-visible:border-ring [button,a]:focus-visible:ring-3 [button,a]:focus-visible:ring-ring/50";
