import { createFileRoute } from "@tanstack/react-router";
import { PageEmpty, PageShell } from "@/components/layout/page-shell";
import { t } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/_app/projects")({
  component: RouteComponent,
});

/**
 * WHERE THE PROJECTS WILL BE LISTED (`docs/laf/redesign-2026-10.md` §3), AND TODAY ONLY THE PLACE.
 *
 * The switcher at the top has two halves and this is the second one's screen. A project cannot be
 * made yet — a conversation has no kind to be one — so the screen says exactly that and draws no
 * button: a control that could do nothing would be worse than none.
 */
function RouteComponent() {
  return (
    <PageShell title={t("Projects")}>
      <PageEmpty>{t("Projects cannot be made yet.")}</PageEmpty>
    </PageShell>
  );
}
