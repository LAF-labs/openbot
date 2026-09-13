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

/**
 * The thread as the server stores it, with this tab's live copy of each message kept where it has one.
 *
 * MEASURED 2026-09-13: a question whose run failed — agent-bot down, so the API stored the question
 * and recorded the failure — was GONE from the transcript after a reload, and with it the line and
 * the 다시 시도 under it. Joining the thread replays the runtime's last run from memory, which was the
 * one before the failure; the stored history was then only applied to an agent with no messages at
 * all, and this one had the replay's two. So the screen said less than the thread held.
 *
 * Stored order wins, because the store is the record: a message somebody else wrote between runs (a
 * routine's delivery) sits where it was written. For a message both sides hold, the live copy wins,
 * because a run still in flight carries tool calls the store has not caught up with. Anything only
 * this tab holds — a message sent while the history was on its way — stays, at the end.
 *
 * Returns `live` itself when nothing would change, so a caller can skip a rewrite that would redraw.
 */
export function mergeStoredHistory(
  stored: readonly Message[],
  live: readonly Message[],
): readonly Message[] {
  if (live.length === 0) return stored;
  const liveById = new Map(live.map((message) => [message.id, message]));
  const storedIds = new Set(stored.map((message) => message.id));
  const merged = [
    ...stored.map((message) => liveById.get(message.id) ?? message),
    ...live.filter((message) => !storedIds.has(message.id)),
  ];
  const unchanged =
    merged.length === live.length &&
    merged.every((message, index) => message === live[index]);
  return unchanged ? live : merged;
}
