import { IconMenu2 } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import {
  openMobileNav,
  useMobileNavAvailable,
  useMobileNavOpen,
} from "@/lib/mobile-nav";
import { cn } from "@/lib/utils";

/**
 * The way to the sidebar on a phone: the first thing in a screen's header, and only below `md`,
 * where the sidebar is a sheet rather than a column (`lib/mobile-nav.ts`).
 */
export function MobileNavButton({ className }: { className?: string }) {
  const isOpen = useMobileNavOpen();
  const isAvailable = useMobileNavAvailable();
  // Settings and Admin share `PageShell` and have no sidebar to open.
  if (!isAvailable) return null;
  return (
    <Button
      aria-expanded={isOpen}
      aria-label={t("Open the menu")}
      className={cn("shrink-0 md:hidden", className)}
      onClick={openMobileNav}
      size="icon"
      variant="ghost"
    >
      <IconMenu2 className="size-5" />
    </Button>
  );
}
