import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/terms` is the address people type and print; `/legal/terms` is where the page lives, beside
 * its sibling. A redirect rather than a second copy of the route, so there is one page to replace
 * the day counsel's text arrives.
 */
export const Route = createFileRoute("/terms")({
  beforeLoad: () => {
    throw redirect({ to: "/legal/terms", replace: true });
  },
});
