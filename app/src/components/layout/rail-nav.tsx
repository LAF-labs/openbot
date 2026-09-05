import { IconArrowLeft } from "@tabler/icons-react";
import { Link, type LinkOptions } from "@tanstack/react-router";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * What the rail becomes when the window is too narrow to hold it.
 *
 * WHY THIS EXISTS. Settings and Admin are the two screens with a rail, and the rail is `fixed
 * inset-y-0` at 280px with no way to collapse it — the Sheet, the breakpoint hook and the Cmd+B
 * shortcut all left with the phone decision, and `--sidebar-width-mobile` was still being handed
 * in by both route files without reaching anything. So at 900px the pane had 620px, at 700px it
 * had 420px, and there was no gesture, key or button that would give any of it back.
 *
 * The rail is the whole navigation of both screens, so it cannot simply be hidden. Below `lg` it
 * is drawn here instead: one horizontal row at the top of the pane, the way back to the app first,
 * scrolling sideways when there are more links than fit — which is Admin, at nine.
 *
 * Pure CSS, no width hook. The choice is a media query in the class list, so it is right on the
 * first frame at any width and it survives a window somebody drags. A `useIsMobile` here would
 * render the wrong navigation once on every load of both screens.
 */

export type RailNavItem = {
  /** Already through `t()` — these tables are read once at module load, like the rails' own. */
  title: string;
  linkOptions: LinkOptions;
  /**
   * The route that is a prefix of every other one on this rail. Without it "General" stays lit on
   * every sub-page, which is the state Settings shipped in.
   */
  isExact?: boolean;
};

export const RailNav = ({
  className,
  items,
  label,
}: {
  className?: string;
  items: RailNavItem[];
  /** Names the landmark, so a screen reader hears which of the two rails this is. */
  label: string;
}) => (
  <nav
    aria-label={label}
    className={cn(
      "sticky top-0 z-20 shrink-0 border-border border-b bg-background/95 backdrop-blur-sm",
      className,
    )}
  >
    <div className="no-scrollbar flex items-center gap-1 overflow-x-auto px-3 py-2">
      <Link
        aria-label={t("Back to app")}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        to="/"
      >
        <IconArrowLeft className="size-4" />
      </Link>
      {items.map((item) => (
        <Link
          activeOptions={item.isExact ? { exact: true } : undefined}
          className="shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition-colors hover:bg-foreground/5 data-[status=active]:bg-foreground/8 data-[status=active]:font-medium data-[status=active]:hover:bg-foreground/8"
          key={item.title}
          {...item.linkOptions}
        >
          {item.title}
        </Link>
      ))}
    </div>
  </nav>
);
