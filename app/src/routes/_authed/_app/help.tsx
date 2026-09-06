import { createFileRoute } from "@tanstack/react-router";
import { HelpPage } from "@/components/help/help-page";

/** Under `_app`, so the roster stays beside the guide and the Bot somebody was stuck on is a click away. */
export const Route = createFileRoute("/_authed/_app/help")({
  component: HelpPage,
});
