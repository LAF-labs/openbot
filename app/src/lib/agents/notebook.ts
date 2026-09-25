import type { NotebookSlot } from "@shared/notebook";
import type { QueryClient } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { refusalFrom } from "@/lib/refusals";
import { AGENT_REFUSALS } from "./mutations";
import { agentKeys } from "./queries";

/**
 * 수첩's writes. Every one goes through `/notebook`, which is the owner's pen: the Bot's own tool
 * posts to `/memories`, and the server marks a line's source by the route it came through
 * (`server/src/agents/routes.ts`). No tool handler may call these (`notebook-boundary.test.ts`).
 *
 * Each resolves to null when done and to the sentence to show when refused.
 */

const base = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}`;

async function send(
  queryClient: QueryClient,
  agentId: string,
  path: string,
  init: RequestInit,
): Promise<string | null> {
  const response = await fetch(`${base(agentId)}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  }).catch(() => null);
  if (!response) return t("That was not saved. Try again.");
  if (!response.ok) {
    return refusalFrom(
      response,
      AGENT_REFUSALS,
      t("That was not saved. Try again."),
    );
  }
  await queryClient.invalidateQueries({
    queryKey: agentKeys.memories(agentId),
  });
  return null;
}

/** A new line, or a shop slot filled (which replaces what stood there). */
export function writeLine(
  queryClient: QueryClient,
  agentId: string,
  content: string,
  slot: NotebookSlot | null = null,
) {
  return send(queryClient, agentId, "/notebook", {
    method: "POST",
    body: JSON.stringify({ content, slot }),
  });
}

/** New words for a line. The old line is kept, forgotten, behind the new one. */
export function reviseLine(
  queryClient: QueryClient,
  agentId: string,
  memoryId: string,
  content: string,
) {
  return send(
    queryClient,
    agentId,
    `/notebook/${encodeURIComponent(memoryId)}`,
    { method: "PUT", body: JSON.stringify({ content }) },
  );
}

/** A Bot's line, said to be right. */
export function confirmLine(
  queryClient: QueryClient,
  agentId: string,
  memoryId: string,
) {
  return send(
    queryClient,
    agentId,
    `/notebook/${encodeURIComponent(memoryId)}/confirm`,
    { method: "POST" },
  );
}

/** Stop carrying a line. The same route the profile's 잊기 always used. */
export function forgetLine(
  queryClient: QueryClient,
  agentId: string,
  memoryId: string,
) {
  return send(
    queryClient,
    agentId,
    `/memories/${encodeURIComponent(memoryId)}`,
    { method: "DELETE" },
  );
}
