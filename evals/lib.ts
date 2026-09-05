/**
 * The pure half of the model eval pack: reading a run's SSE stream back into
 * something a check can judge.
 *
 * Kept free of the model, the network and the clock so the checks themselves are
 * testable in the ordinary suite. Everything that talks to a model lives in run.ts.
 */

export type StreamEvent = {
  type: string;
  name?: string;
  value?: Record<string, unknown>;
  delta?: string;
  toolCallId?: string;
  toolCallName?: string;
  messageId?: string;
  message?: string;
};

/** The `data:` lines of an SSE body, parsed. Comment lines (heartbeats) are dropped. */
export function eventsOfSse(body: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      events.push(JSON.parse(line.slice(5).trim()) as StreamEvent);
    } catch {
      // A data line that is not JSON is a protocol break; discipline() reports it.
      events.push({ type: "UNPARSEABLE", delta: line });
    }
  }
  return events;
}

export type ObservedCall = {
  name: string;
  /** The fragments, joined. */
  rawArguments: string;
  /** Parsed arguments, or null when the joined fragments are not JSON — the "형식 유효" failure. */
  arguments: Record<string, unknown> | null;
};

/** Every tool call the stream carried, reassembled the way @ag-ui/client would. */
export function callsOf(events: StreamEvent[]): ObservedCall[] {
  const order: string[] = [];
  const byId = new Map<string, { name: string; fragments: string[] }>();
  for (const event of events) {
    if (event.type === "TOOL_CALL_START" && event.toolCallId) {
      if (!byId.has(event.toolCallId)) order.push(event.toolCallId);
      byId.set(event.toolCallId, {
        name: event.toolCallName ?? "",
        fragments: [],
      });
    }
    if (event.type === "TOOL_CALL_ARGS" && event.toolCallId) {
      byId.get(event.toolCallId)?.fragments.push(event.delta ?? "");
    }
  }
  return order.map((id) => {
    const call = byId.get(id) as { name: string; fragments: string[] };
    const raw = call.fragments.join("");
    let parsed: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(raw === "" ? "{}" : raw);
      parsed =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
    } catch {
      parsed = null;
    }
    return { name: call.name, rawArguments: raw, arguments: parsed };
  });
}

/** The assistant's words, joined from the text-message fragments. */
export function textOf(events: StreamEvent[]): string {
  return events
    .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
    .map((event) => event.delta ?? "")
    .join("");
}

/** The usage event the Bot service emits, when the provider reported one. */
export function usageOf(events: StreamEvent[]): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens the provider served from its cache. Null where the endpoint does not say. */
  cachedPromptTokens: number | null;
} | null {
  const found = events.find(
    (event) => event.type === "CUSTOM" && event.name === "laf.model.usage",
  );
  if (!found?.value) return null;
  const count = (key: string) =>
    typeof found.value?.[key] === "number" ? (found.value[key] as number) : 0;
  return {
    promptTokens: count("promptTokens"),
    completionTokens: count("completionTokens"),
    totalTokens: count("totalTokens"),
    cachedPromptTokens:
      typeof found.value.cachedPromptTokens === "number"
        ? found.value.cachedPromptTokens
        : null,
  };
}

/**
 * 형식 유효 — the wire held its shape, whatever the model said.
 *
 * A model can fail a scenario and still stream correctly; a model that breaks the
 * stream fails every scenario it touches, because the product would too.
 */
export function discipline(events: StreamEvent[]): string[] {
  const problems: string[] = [];
  if (!events.some((event) => event.type === "RUN_FINISHED"))
    problems.push("no RUN_FINISHED");
  const error = events.find((event) => event.type === "RUN_ERROR");
  if (error) problems.push(`RUN_ERROR: ${error.message ?? "unnamed"}`);
  if (events.some((event) => event.type === "UNPARSEABLE"))
    problems.push("unparseable data line");
  const started = new Set<string>();
  const ended = new Set<string>();
  for (const event of events) {
    if (event.type === "TOOL_CALL_START" && event.toolCallId)
      started.add(event.toolCallId);
    if (event.type === "TOOL_CALL_ARGS" && event.toolCallId) {
      if (!started.has(event.toolCallId))
        problems.push(`args before start: ${event.toolCallId}`);
    }
    if (event.type === "TOOL_CALL_END" && event.toolCallId)
      ended.add(event.toolCallId);
  }
  for (const id of started)
    if (!ended.has(id)) problems.push(`unclosed call: ${id}`);
  for (const call of callsOf(events))
    if (call.arguments === null)
      problems.push(`arguments are not a JSON object: ${call.name}`);
  return problems;
}

/** How much of the prose is Hangul — the cheap test that an answer is in Korean. */
export function hangulShare(text: string): number {
  const letters = [...text].filter((ch) => /[a-zA-Z가-힣]/.test(ch));
  if (letters.length === 0) return 0;
  const hangul = letters.filter((ch) => /[가-힣]/.test(ch));
  return hangul.length / letters.length;
}

/** True when the text carries the number, with or without thousands separators. */
export function saysNumber(text: string, value: number): boolean {
  const plain = String(value);
  const grouped = value.toLocaleString("en-US");
  const stripped = text.replace(/,/g, "");
  return text.includes(grouped) || stripped.includes(plain);
}
