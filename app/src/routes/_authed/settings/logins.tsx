import { createFileRoute } from "@tanstack/react-router";
import { LoginsScreen } from "@/components/logins/logins-screen";

/**
 * 계정 — the logins a person saved for their Bot's browser. Everything the screen does is in
 * `components/logins/logins-screen.tsx`; the path says what is kept here, and the menu says 계정,
 * which is what the decision record calls it (`docs/laf/redesign-2026-10.md` §6).
 */
export const Route = createFileRoute("/_authed/settings/logins")({
  component: LoginsScreen,
});
