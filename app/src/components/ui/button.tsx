import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { focusRing, selectedWhenPressed } from "@/components/ui/focus"
import { cn } from "@/lib/utils"

/*
 * DISABLED, AND WHY `pointer-events-none` IS NOT IN IT.
 *
 * shadcn's stock pairing is `disabled:pointer-events-none disabled:opacity-50`, and both halves are
 * wrong here. A native `<button disabled>` already dispatches no click in any browser, so the first
 * half prevents nothing — what it actually does is switch off hit-testing, which is why
 * `cursor: not-allowed` never appeared and why a tooltip explaining WHY the button is off could
 * never be attached to the button itself.
 *
 * The second half is what made the screens look wrong. `bg-primary` is near-black; at 50% over the
 * page it lands on a mid-grey with white text on it — which is not a disabled control, it is a
 * perfectly ordinary-looking secondary button that happens not to work. Dropping the fill entirely
 * (see the `default` variant) is what makes it read as inert.
 *
 * `:hover` DOES still match a disabled button once hit-testing is back on, so every variant's hover
 * fill is behind `not-disabled:`. Without that the mid-grey pill would light up under the cursor.
 */
const DISABLED =
  "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"

const buttonVariants = cva(
  `group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate,opacity] duration-150 ease-out select-none ${focusRing} ${selectedWhenPressed} active:not-aria-[haspopup]:translate-y-px ${DISABLED} aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4`,
  {
    variants: {
      variant: {
        /*
         * Near-black, not blue. Grok's filled control is `fill/primary` and the accent hue is spent
         * only on links, focus and the dot that says a Bot needs you — which is why one blue button
         * per screen used to read as an ad and now reads as the thing to press.
         */
        /*
         * `disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100` is the whole
         * point of the block at the top of this file: the near-black fill LEAVES when the button
         * is off, instead of being faded to a mid-grey that looks like a working control. The
         * `opacity-100` cancels the base's fade — a muted fill does not need dimming as well, and
         * dimmed muted text stops being readable.
         */
        default:
          "bg-primary text-primary-foreground not-disabled:hover:bg-primary-hover disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100",
        outline:
          "border-border bg-background not-disabled:hover:bg-muted not-disabled:hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:not-disabled:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground not-disabled:hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "not-disabled:hover:bg-muted not-disabled:hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:not-disabled:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive not-disabled:hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:not-disabled:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 not-disabled:hover:underline",
      },
      size: {
        // 32px — Grok's `height/lg`, the size every dialog and pane CTA is drawn at.
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        /*
         * `rounded-md`, not `rounded-[min(var(--radius-md),12px)]`.
         *
         * Five of those clamps were written across this file and `select.tsx`, and every one of them
         * evaluated to 8px: `--radius-md` IS 8px here, so `min()` could only ever return it. The
         * clamp is left over from a design where the radius scaled with a single `--radius`; this
         * one states its ladder rung by rung, which is what makes the escape both inert and
         * invisible — nobody reading `min(…, 12px)` guesses the corner is 8.
         */
        xs: "h-6 gap-1 rounded-md px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        // `text-xs` (11px), not `text-[0.8rem]` — which at this app's 14px root was 11.2px, i.e. the
        // scale's own step, spelled as a rem escape that only accidentally agreed with it.
        sm: "h-7 gap-1 rounded-md px-2.5 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-md in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-md in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * RENDERING AS SOMETHING THAT IS NOT A `<button>`: PASS `nativeButton={false}`.
 *
 * `render={<Link/>}` alone leaves Base UI believing it still owns a native button, so it hands the
 * anchor button-only props — `disabled`, `type` — and React logs
 * `Received `false` for a non-boolean attribute` or an unknown-prop warning into the console for
 * every one of them. It also leaves the anchor with `role="button"` on top of its own implicit
 * link role, which is two roles for one element and reads to a screen reader as whichever it saw
 * first. One page header in this app ships exactly that today.
 *
 * The correct shape, and the one `NotFoundScreen` in `router.tsx` uses:
 *
 *     <Button nativeButton={false} render={(props) => <Link to="/" {...props} />}>…</Button>
 *
 * A link is not a button. If it navigates, render a `Link`; if it acts, keep the `<button>`.
 */
function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
