import type { BaseEvent } from "@ag-ui/client";

/**
 * The usage a Bot's stream reported, shaped for the trail.
 *
 * Counts only, with non-numbers read as zero rather than trusted: the event crossed a service
 * boundary, and a ledger row that throws on a malformed count is a run that fails on metering.
 *
 * Moved here from `runner/laf-runner.ts` on 2026-09-15, when the row stopped being written there:
 * the runner only ever saw chat turns, and the day's budget has to count every turn.
 */
export function modelUsageOf(events: ReadonlyArray<BaseEvent>): Array<{
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Prompt tokens the provider served from its cache, only where the endpoint said so.
   *
   * Absent rather than zero otherwise: the monthly cost is a sum over these rows, and a row that
   * says "0 cached" for an endpoint that never reports the number would make a prompt that caches
   * perfectly indistinguishable from one that never does.
   */
  cachedPromptTokens?: number;
}> {
  const found: ReturnType<typeof modelUsageOf> = [];
  for (const raw of events) {
    const event = raw as BaseEvent & { name?: string; value?: unknown };
    if (String(event.type) !== "CUSTOM" || event.name !== "laf.model.usage")
      continue;
    const value = (event.value ?? {}) as Record<string, unknown>;
    const count = (key: string) =>
      typeof value[key] === "number" ? (value[key] as number) : 0;
    found.push({
      model: typeof value.model === "string" ? value.model : "unknown",
      promptTokens: count("promptTokens"),
      completionTokens: count("completionTokens"),
      totalTokens: count("totalTokens"),
      ...(typeof value.cachedPromptTokens === "number"
        ? { cachedPromptTokens: value.cachedPromptTokens }
        : {}),
    });
  }
  return found;
}
