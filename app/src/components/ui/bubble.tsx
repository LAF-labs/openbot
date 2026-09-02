import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const bubbleVariants = cva(
  /*
 * `min(88%, 640px, 100% - 82px)` is the measured cap. Three limits because they bind at
 * different widths: 88% keeps a bubble off the far edge in a narrow pane, 640px stops a long
 * answer from running to an unreadable measure on a wide one, and the 82px inset leaves the
 * gutter the avatar and hover actions live in.
 */
  "group/bubble relative flex w-fit max-w-[min(88%,640px,calc(100%-82px))] min-w-0 flex-col gap-1 group-data-[align=end]/message:self-end data-[align=end]:self-end data-[variant=ghost]:max-w-full",
  {
    variants: {
      variant: {
        default:
          "*:data-[slot=bubble-content]:bg-primary *:data-[slot=bubble-content]:text-primary-foreground [&>[data-slot=bubble-content]:is(button,a):hover]:bg-primary/80",
        secondary:
          "*:data-[slot=bubble-content]:bg-secondary *:data-[slot=bubble-content]:text-secondary-foreground [&>[data-slot=bubble-content]:is(button,a):hover]:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
        muted:
          "*:data-[slot=bubble-content]:bg-muted [&>[data-slot=bubble-content]:is(button,a):hover]:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_5%)]",
        /*
         * THE TWO BUBBLES THE TRANSCRIPT ACTUALLY USES.
         *
         * `--sand-fill-bubble-agent` and `--sand-fill-bubble-user` are their own tokens in Grok's
         * palette, not the generic muted/primary surfaces — the Bot's grey is #eeeeee where `muted`
         * is a #777777 alpha, and the person's is solid near-black in light and a mid grey in dark,
         * which no combination of the shadcn names reproduces. Bubbles are the most-looked-at
         * surface in the product; they get the tokens that were measured for them.
         */
        agent:
          "*:data-[slot=bubble-content]:bg-[var(--sand-fill-bubble-agent)] *:data-[slot=bubble-content]:text-foreground",
        user: "*:data-[slot=bubble-content]:bg-[var(--sand-fill-bubble-user)] *:data-[slot=bubble-content]:text-[var(--sand-text-on-color)]",
        tinted:
          "*:data-[slot=bubble-content]:bg-[oklch(from_var(--primary)_0.93_calc(c*0.4)_h)] *:data-[slot=bubble-content]:text-foreground dark:*:data-[slot=bubble-content]:bg-[oklch(from_var(--primary)_0.3_calc(c*0.4)_h)] [&>[data-slot=bubble-content]:is(button,a):hover]:bg-[oklch(from_var(--primary)_0.88_calc(c*0.5)_h)] dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-[oklch(from_var(--primary)_0.35_calc(c*0.5)_h)]",
        outline:
          "*:data-[slot=bubble-content]:border-border *:data-[slot=bubble-content]:bg-background [&>[data-slot=bubble-content]:is(button,a):hover]:bg-muted [&>[data-slot=bubble-content]:is(button,a):hover]:text-foreground dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-input/30",
        ghost:
          "border-none *:data-[slot=bubble-content]:rounded-none *:data-[slot=bubble-content]:bg-transparent *:data-[slot=bubble-content]:p-0 [&>[data-slot=bubble-content]:is(button,a):hover]:bg-muted [&>[data-slot=bubble-content]:is(button,a):hover]:text-foreground dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-muted/50",
        destructive:
          "*:data-[slot=bubble-content]:bg-destructive/10 *:data-[slot=bubble-content]:text-destructive dark:*:data-[slot=bubble-content]:bg-destructive/20 [&>[data-slot=bubble-content]:is(button,a):hover]:bg-destructive/20 dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-destructive/30",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Bubble({
  variant = "default",
  align = "start",
  joinedPrev = false,
  joinedNext = false,
  className,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof bubbleVariants> & {
    align?: "start" | "end"
    /** This bubble continues the one above it, from the same speaker. */
    joinedPrev?: boolean
    /** The bubble below it continues this one. */
    joinedNext?: boolean
  }) {
  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={align}
      // Absent rather than false: `data-joined-prev="false"` still matches `data-[joined-prev]`.
      {...(joinedPrev ? { "data-joined-prev": "" } : {})}
      {...(joinedNext ? { "data-joined-next": "" } : {})}
      className={cn(bubbleVariants({ variant }), className)}
      {...props}
    />
  )
}

function BubbleContent({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          /*
           * NO SIZE OR LEADING HERE. The transcript puts `.chat-prose` (16px/1.65) on the Bubble,
           * and a `text-sm` on this child beat it — so a Bot's reply rendered at 13px, a step DOWN
           * from the 14px UI root and three pixels smaller than the box it was typed into, while
           * the element around it correctly reported 16. Bubble has exactly one consumer, so the
           * measure belongs to that consumer.
           */
          /*
           * 18px corners, 8px/12px padding — the measured bubble. The joined corners come from
           * `data-joined-*` on the Bubble above: a run of messages from one speaker keeps its outer
           * corners round and tightens the two where it meets its neighbour to 6px, which is what
           * makes three bubbles read as one turn instead of three separate remarks.
           */
          "w-fit max-w-full min-w-0 overflow-hidden rounded-3xl border border-transparent px-3 py-2 wrap-break-word group-data-[joined-prev]/bubble:group-data-[align=start]/bubble:rounded-tl-[6px] group-data-[joined-next]/bubble:group-data-[align=start]/bubble:rounded-bl-[6px] group-data-[joined-prev]/bubble:group-data-[align=end]/bubble:rounded-tr-[6px] group-data-[joined-next]/bubble:group-data-[align=end]/bubble:rounded-br-[6px] group-data-[align=end]/bubble:self-end [button]:text-left [button,a]:transition-colors [button,a]:outline-none [button,a]:focus-visible:border-ring [button,a]:focus-visible:ring-3 [button,a]:focus-visible:ring-ring/50",
          className
        ),
      },
      props
    ),
    render,
    state: {
      slot: "bubble-content",
    },
  })
}

export { Bubble, BubbleContent }
