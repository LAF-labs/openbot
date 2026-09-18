import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "@/lib/utils";

/**
 * A small panel anchored to the control that opened it, for a question too short to deserve a
 * dialog — 아쉬워요's "what fell short?" is the first one.
 *
 * Non-modal by default, which is the point of it over `Dialog`: the answer being rated stays on
 * screen and readable beside the question about it, and a press anywhere else simply closes it.
 * Focus still moves into the panel on open and back to the trigger on close, which is Base UI's
 * default and what a keyboard needs.
 *
 * BELOW ITS TRIGGER unless there is no room there. Opened from under an answer, above would lay the
 * question over the last lines of the very answer it asks about — measured, on the first try.
 *
 * `shadow-popover` and `rounded-lg`, the same surface every menu and select in the app is drawn on
 * (docs/laf/design-tokens.md §2 and §4) — a new kind of floating panel is not a new elevation.
 */
function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 6,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="isolate z-50 outline-hidden"
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "z-50 flex w-72 max-w-(--available-width) origin-(--transform-origin) flex-col gap-3 rounded-lg bg-popover p-3 text-popover-foreground text-sm shadow-popover outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn("font-medium text-sm", className)}
      {...props}
    />
  );
}

function PopoverDescription({
  className,
  ...props
}: PopoverPrimitive.Description.Props) {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      className={cn("text-muted-foreground text-xs", className)}
      {...props}
    />
  );
}

export {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
};
