import { Link } from "@tanstack/react-router";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The two documents, as a footer: 이용약관 · 개인정보 처리방침.
 *
 * One component for the sign-in screen and Settings, so the two places a person might go looking
 * for the text — before they have an account, and once they have one — offer it in the same words
 * and the same order. No sentence around the links: agreeing happens on the screens that say so
 * (`consent-line.tsx`); this is only where the text can be found.
 */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <nav
      aria-label={t("Legal")}
      className={cn("flex items-center gap-3", className)}
    >
      <Link className="hover:text-foreground" to="/legal/terms">
        {t("Terms of Service")}
      </Link>
      <span aria-hidden="true">·</span>
      <Link className="hover:text-foreground" to="/legal/privacy">
        {t("Privacy Policy")}
      </Link>
    </nav>
  );
}
