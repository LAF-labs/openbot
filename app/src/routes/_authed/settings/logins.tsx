import { createFileRoute } from "@tanstack/react-router";
import { LoginsScreen } from "@/components/logins/logins-screen";

/**
 * 계정 — the logins a person saved for their Bot's browser. Everything the screen does is in
 * `components/logins/logins-screen.tsx`; the path says what is kept here, and the menu says 계정,
 * which is what the decision record calls it (`docs/laf/redesign-2026-10.md` §6).
 */
export const Route = createFileRoute("/_authed/settings/logins")({
  /*
   * `?site=` IS A SITE TO SAVE A LOGIN FOR: where 연결's row for a site that is not signed in to
   * sends a person (`components/connections/site-rows.tsx`).
   *
   * THIS SAYS WHAT THE ADDRESS MAY CARRY; IT DOES NOT FILTER IT. The router hands a component
   * whatever the address said, laid under what this returns — measured: returning nothing for a
   * site still opened the form for it. What decides is the screen, which opens nothing for an id
   * it does not offer (`LoginsScreen`, tested there), and the one line below that takes only a
   * string.
   */
  validateSearch: (search: Record<string, unknown>): { site?: string } =>
    typeof search.site === "string" && search.site ? { site: search.site } : {},
  component: LoginsRoute,
});

function LoginsRoute() {
  const search: { site?: unknown } = Route.useSearch();
  const site = typeof search.site === "string" ? search.site : "";
  // Keyed by the site: arriving for another one opens a form for that one.
  return <LoginsScreen key={site} {...(site ? { site } : {})} />;
}
