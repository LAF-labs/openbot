import type { Message } from "@ag-ui/core";

/**
 * A thread's stored messages, in the shape the agent runs with.
 *
 * The runtime's threads endpoint answers in its own message format, and it is not AG-UI's: a tool
 * call comes back as `{ id, name, args }` where the agent — and the provider behind it — want
 * `{ id, type: "function", function: { name, arguments } }`. Put into `agent.setMessages` as it
 * arrived, the history looked right on screen and then failed the next run's validation with
 * "expected 'function'" at the first reply after a reload, in any room whose Bot had ever used a
 * tool. Every read of stored history goes through here, so there is one place the shape is known.
 */
type StoredToolCall = {
  id: string;
  type?: string;
  name?: string;
  args?: unknown;
  function?: { name?: string; arguments?: unknown };
};

function agUiToolCall(call: StoredToolCall) {
  const name = call.function?.name ?? call.name ?? "";
  const raw = call.function?.arguments ?? call.args ?? "{}";
  const args = typeof raw === "string" ? raw : JSON.stringify(raw);
  return {
    id: call.id,
    type: "function" as const,
    function: { name, arguments: args },
  };
}

export function normalizeStoredMessages(stored: unknown): Message[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((message: unknown) => {
    if (!message || typeof message !== "object") return [];
    const entry = message as Record<string, unknown> & { id?: string };
    if (!entry.id) return [];
    const calls = entry.toolCalls;
    if (!Array.isArray(calls)) return [entry as Message];
    return [
      {
        ...entry,
        toolCalls: (calls as StoredToolCall[])
          .filter((call) => call && typeof call.id === "string")
          .map(agUiToolCall),
      } as Message,
    ];
  });
}

/** Null when the endpoint refuses or is unreachable; an empty thread is an empty array. */
export async function loadThreadHistory(
  threadId: string,
  agentId: string,
): Promise<Message[] | null> {
  try {
    const response = await fetch(
      `/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages?agentId=${encodeURIComponent(agentId)}`,
      { credentials: "include" },
    );
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as {
      messages?: unknown;
    } | null;
    return normalizeStoredMessages(body?.messages);
  } catch {
    return null;
  }
}
