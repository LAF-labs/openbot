/**
 * The doors of a turn the server owns (`server/src/turns/routes.ts`), as a window uses them.
 *
 * The window no longer runs the turn: it hands over what the person said, and watches. Watching is
 * a server-sent event stream with a cursor, so a window that loses its connection — a laptop lid, a
 * Wi-Fi change, a hidden tab the browser froze — asks to be taken from where it was and is handed
 * exactly what it missed, or the turn as it stands when that is no longer held.
 */
import type { Message, Tool } from "@ag-ui/core";
import type { TurnFrame } from "./frames";

export type SendResult =
  | { ok: true; turnId: string }
  /** The server answered and said no: the conversation is busy, or the message was refused. */
  | { ok: false; code: string; reached: true }
  /** Nothing answered. What was typed never arrived. */
  | { ok: false; code: "laf:turn_server_unreachable"; reached: false };

export async function sendTurn(
  threadId: string,
  body: {
    botId: string;
    messages: Message[];
    tools: Tool[] | null;
    device?: unknown;
  },
): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetch(`/api/turns/${encodeURIComponent(threadId)}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, code: "laf:turn_server_unreachable", reached: false };
  }
  const answer = (await response.json().catch(() => null)) as {
    turnId?: unknown;
    code?: unknown;
  } | null;
  if (response.ok && typeof answer?.turnId === "string") {
    return { ok: true, turnId: answer.turnId };
  }
  // The front door's 503 is the server not being there, whatever it says.
  if (response.status >= 502) {
    return { ok: false, code: "laf:turn_server_unreachable", reached: false };
  }
  return {
    ok: false,
    code: typeof answer?.code === "string" ? answer.code : "laf:turn_refused",
    reached: true,
  };
}

export async function stopTurn(threadId: string): Promise<boolean> {
  try {
    const response = await fetch(
      `/api/turns/${encodeURIComponent(threadId)}/stop`,
      { method: "POST", credentials: "include" },
    );
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as {
      stopped?: unknown;
    } | null;
    return body?.stopped === true;
  } catch {
    return false;
  }
}

export type HistoryPage = {
  messages: Message[];
  times: Record<string, string>;
  seqs: Record<string, number>;
  oldestSeq: number | null;
  newestSeq: number | null;
  hasOlder: boolean;
};

/** A page of the conversation, newest first; `before` a durable cursor for the one above. Null when unreadable. */
export async function readHistory(
  threadId: string,
  before: number | null,
  limit?: number,
): Promise<HistoryPage | null> {
  const query = new URLSearchParams();
  if (before !== null) query.set("before", String(before));
  if (limit !== undefined) query.set("limit", String(limit));
  try {
    const response = await fetch(
      `/api/turns/${encodeURIComponent(threadId)}/history${query.size ? `?${query}` : ""}`,
      { credentials: "include" },
    );
    if (!response.ok) return null;
    const body = (await response
      .json()
      .catch(() => null)) as HistoryPage | null;
    if (!body || !Array.isArray(body.messages)) return null;
    return body;
  } catch {
    return null;
  }
}

/** A person's choice on a card the Bot is waiting on. False when nothing is waiting on it any more. */
export async function answerCard(
  threadId: string,
  toolCallId: string,
  value: unknown,
): Promise<boolean> {
  try {
    const response = await fetch(
      `/api/turns/${encodeURIComponent(threadId)}/answers/${encodeURIComponent(toolCallId)}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/** 건너뛰기 on a help request, told to the turn that is waiting on it. */
export async function skipOnServer(
  botId: string,
  toolCallId: string,
): Promise<void> {
  try {
    await fetch("/api/turns/skips", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId, toolCallId }),
    });
  } catch {
    // The call runs out on its own; a skip that did not arrive is a skip not pressed.
  }
}

/**
 * How long a watching window waits for anything — a frame or the server's keepalive, every 15 s —
 * before it calls the stream dead and opens another. A socket a sleeping laptop left half-open
 * looks alive to the browser and hears nothing.
 */
const SILENT_AFTER_MS = 40_000;
const RETRY_FIRST_MS = 500;
const RETRY_MOST_MS = 8_000;

export type TurnWatch = {
  close: () => void;
  /** Open a fresh stream from the current cursor now: the window became visible, or came online. */
  nudge: () => void;
};

/**
 * Watch a conversation's turn from a cursor, reconnecting on its own.
 *
 * `cursor` is read at every (re)connect, so a caller that has applied frames always resumes from
 * the last one it applied, and a snapshot is what a cursor from another process gets.
 */
export function watchTurn(
  threadId: string,
  handlers: {
    cursor: () => string | null;
    onFrame: (frame: TurnFrame) => void;
    /** Whether the stream is open. A caller can say "reconnecting" off this. */
    onLive?: (live: boolean) => void;
  },
): TurnWatch {
  let source: EventSource | null = null;
  let closed = false;
  let retryMs = RETRY_FIRST_MS;
  let silence: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const heard = () => {
    clearTimeout(silence);
    silence = setTimeout(() => reopen(), SILENT_AFTER_MS);
  };

  const open = () => {
    if (closed) return;
    const cursor = handlers.cursor();
    const url = `/api/turns/${encodeURIComponent(threadId)}/stream${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
    const stream = new EventSource(url, { withCredentials: true });
    source = stream;
    heard();
    stream.onopen = () => {
      retryMs = RETRY_FIRST_MS;
      handlers.onLive?.(true);
      heard();
    };
    stream.onmessage = (message) => {
      heard();
      let frame: TurnFrame;
      try {
        frame = JSON.parse(String(message.data)) as TurnFrame;
      } catch {
        return;
      }
      handlers.onFrame(frame);
    };
    stream.addEventListener("ping", heard);
    stream.onerror = () => {
      handlers.onLive?.(false);
      /*
       * EventSource reconnects on its own after a dropped connection, carrying the last id it saw —
       * which is the cursor. It gives up for good on an answer that is not a stream (a 401, a 404, a
       * front door's 503), and that one is reopened here, with backoff.
       */
      if (stream.readyState === EventSource.CLOSED) scheduleReopen();
    };
  };

  const scheduleReopen = () => {
    if (closed) return;
    clearTimeout(retry);
    retry = setTimeout(reopen, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MOST_MS);
  };

  function reopen() {
    if (closed) return;
    source?.close();
    source = null;
    clearTimeout(retry);
    open();
  }

  open();
  return {
    close: () => {
      closed = true;
      clearTimeout(silence);
      clearTimeout(retry);
      source?.close();
      source = null;
    },
    nudge: () => reopen(),
  };
}
