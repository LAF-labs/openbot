/**
 * 회사: whether this VM belongs to a company hub, and whether the line to it is up.
 *
 * The server holds the line (`server/src/hub/link.ts`) and answers `/api/hub/status` with facts; the
 * words are this module's. The browser never learns the hub's address or the pass — there is nothing
 * here that could reach the hub, only the server's account of it.
 */
import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { requestOrRefusal } from "@/lib/refusals";

export type HubLinkState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "refused";

export type HubStatus =
  | { configured: false }
  | {
      configured: true;
      state: HubLinkState;
      code: string | null;
      workspace: { name: string } | null;
      member: { role: string; name: string | null } | null;
      since: string;
    };

export const hubKeys = {
  all: ["hub"] as const,
  status: ["hub", "status"] as const,
};

export function hubStatusQueryOptions() {
  return queryOptions({
    queryKey: hubKeys.status,
    queryFn: async (): Promise<HubStatus> =>
      (await requestOrRefusal("/api/hub/status", undefined, {})) as HubStatus,
    // The socket's `hub.status` frame refreshes it the moment the line changes; this is the floor.
    refetchInterval: 60_000,
  });
}

/**
 * The fact the server named, as this surface says it. A `switch` of literal `t()` calls rather than
 * a table read through a variable, so the coverage walk sees every one.
 */
export function hubFactText(code: string | null): string | null {
  switch (code) {
    case "laf:hub_unreachable":
      return t("Cannot reach the company server · trying again");
    case "laf:hub_pass_refused":
      return t("The link to your company was undone. Let the operator know.");
    case "laf:hub_forbidden":
      return t("Your company does not allow this.");
    case "laf:hub_not_found":
      return t("Your company does not have that.");
    default:
      return null;
  }
}

/** The one line: 회사: <이름> · 연결됨/끊김, and the reason under it when there is one. */
export function hubStatusLine(
  status: HubStatus,
): { line: string; note: string | null; connected: boolean } | null {
  if (!status.configured) return null;
  const connected = status.state === "connected";
  const state =
    status.state === "connecting"
      ? t("Connecting")
      : connected
        ? t("Connected")
        : t("Disconnected");
  const line = status.workspace
    ? t("Company: {name} · {state}", { name: status.workspace.name, state })
    : t("Company · {state}", { state });
  return {
    line,
    note: connected ? null : hubFactText(status.code),
    connected,
  };
}
