import { IconSearch } from "@tabler/icons-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";
import { focusRing } from "@/components/ui/focus";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 검색, AT THE RIGHT OF THE TOP ROW (2026-10-10, record §1, piece 4-3).
 *
 * Beside the picture that opens the menu, on every screen, whether 홈 is open or folded: the way
 * to what was said in any conversation (`routes/_authed/_app/search.tsx`). A link and not a
 * button with a panel — the search is a screen, so it has an address, a way back, and the whole
 * width of the window for what it finds.
 *
 * It reads nothing, so it stands outside the roster's seam: whatever fails in the row, the way to
 * the search is still drawn.
 */
export function SearchButton() {
  const isOpen = useRouterState({
    select: (state) => state.location.pathname === "/search",
  });
  return (
    <Link
      aria-current={isOpen ? "page" : undefined}
      aria-label={t("Search")}
      className={cn(
        buttonVariants({ size: "icon", variant: "ghost" }),
        "shrink-0",
        isOpen && "bg-accent",
        focusRing,
      )}
      data-search-button
      title={t("Search")}
      to="/search"
    >
      <IconSearch aria-hidden="true" />
    </Link>
  );
}
