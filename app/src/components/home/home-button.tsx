import { IconHome } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { setHomePanelOpen, useHomePanel } from "@/lib/home-panel";
import { t } from "@/lib/i18n";

/**
 * THE HOME BUTTON: ONE CONTROL, AT THE WINDOW'S TOP LEFT WHICHEVER WAY THE PANEL IS
 * (`docs/laf/redesign-2026-10.md` §1, piece 3-2). While the panel is open it is in the panel's own
 * first row (`home-panel.tsx`); folded, it is at the left of the app's top row
 * (`layout/app-top-bar.tsx`). Either way it is the first thing in the window, for the eye and for
 * the Tab key.
 *
 * A FILE OF ITS OWN because the top row draws it and the panel takes the window buttons' clearance
 * from the top row: in one file with the panel, each would import the other.
 *
 * NOT IN A NARROW WINDOW (`max-md:hidden`), where there is no panel to open: a phone's browser is
 * not a surface this app is made for (owner, 2026-10-10), and what a narrow window draws is left
 * as it was.
 */
export function HomeButton() {
  const { isOpen } = useHomePanel();
  const name = isOpen ? t("Close the home panel") : t("Open the home panel");
  return (
    <Button
      aria-controls="home-panel"
      aria-expanded={isOpen}
      aria-label={name}
      /*
       * The ink's own colour in every state. The ghost button it is built on greys itself while
       * `aria-expanded` is true and on hover, each under its own variant, so each is answered
       * under the same one — a plain `bg-foreground` lost to them (measured: the open panel's
       * button was the muted fill).
       */
      className="size-8 shrink-0 rounded-full bg-foreground text-background not-disabled:hover:bg-foreground/85 not-disabled:hover:text-background aria-expanded:bg-foreground aria-expanded:text-background max-md:hidden dark:not-disabled:hover:bg-foreground/85"
      data-home-button
      onClick={() => setHomePanelOpen(!isOpen)}
      size="icon-sm"
      title={name}
      variant="ghost"
    >
      <IconHome className="size-4.5" />
    </Button>
  );
}
