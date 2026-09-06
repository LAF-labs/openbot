import { createFileRoute, redirect } from "@tanstack/react-router";

/** The short address for the privacy policy. See `terms.tsx`. */
export const Route = createFileRoute("/privacy")({
  beforeLoad: () => {
    throw redirect({ to: "/legal/privacy", replace: true });
  },
});
