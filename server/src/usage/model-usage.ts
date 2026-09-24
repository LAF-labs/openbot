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
export type ModelUsage = {
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
  /** Prompt tokens the provider wrote to its cache. Absent where it did not say. */
  cacheWriteTokens?: number;
  /**
   * Prompt tokens billed at the full price: the prompt less what was read from the cache. Only
   * where the cache read was reported — otherwise nobody knows.
   */
  uncachedPromptTokens?: number;
  /** Of the completion, the tokens spent reasoning. Absent where it did not say. */
  reasoningTokens?: number;
  /** What the request cost in dollars, as the provider billed it (OpenRouter's `usage.cost`). */
  costUsd?: number;
  /**
   * Who served it — OpenRouter routes one model over dozens of endpoints, each with its own cache,
   * so a hit rate without this is an average over caches that never met. A name from a closed
   * shape only: letters, digits and a little punctuation, or nothing.
   */
  provider?: string;
};

/** The shape a provider's name may take to be kept. The fleet read matches the same source. */
export const PROVIDER_NAME_SOURCE = "^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,39}$";
const PROVIDER_NAME = new RegExp(PROVIDER_NAME_SOURCE);

/**
 * Below this many prompt tokens a hit rate says nothing: a provider caches in blocks of 64 or more
 * (measured, agent-harness-review §3), and a short prompt is mostly its last block.
 */
export const CACHE_WATCH_MIN_PROMPT = 1_024;

/**
 * How long a provider's cache is trusted to hold. OpenRouter's sticky routing expires after ten
 * minutes idle (its prompt-caching guide), and the caches measured here outlived that; a request
 * after a longer pause is cold for reasons that are nobody's bug.
 */
export const CACHE_WARM_SECONDS = 10 * 60;

/** Under this share read from cache, on a warm request in an established epoch, is a break. */
export const CACHE_LOW_SHARE = 0.5;

export function modelUsageOf(events: ReadonlyArray<BaseEvent>): ModelUsage[] {
  const found: ModelUsage[] = [];
  for (const raw of events) {
    const event = raw as BaseEvent & { name?: string; value?: unknown };
    if (String(event.type) !== "CUSTOM" || event.name !== "laf.model.usage")
      continue;
    const value = (event.value ?? {}) as Record<string, unknown>;
    const count = (key: string) =>
      typeof value[key] === "number" ? (value[key] as number) : 0;
    /** A count that was reported, read as what it is; one that was not, absent. */
    const said = (key: string) => {
      const number = value[key];
      return typeof number === "number" &&
        Number.isFinite(number) &&
        number >= 0
        ? number
        : undefined;
    };
    const promptTokens = count("promptTokens");
    const cached = said("cachedPromptTokens");
    const written = said("cacheWriteTokens");
    const reasoning = said("reasoningTokens");
    const cost = said("costUsd");
    const provider =
      typeof value.provider === "string" && PROVIDER_NAME.test(value.provider)
        ? value.provider
        : undefined;
    found.push({
      model: typeof value.model === "string" ? value.model : "unknown",
      promptTokens,
      completionTokens: count("completionTokens"),
      totalTokens: count("totalTokens"),
      ...(cached === undefined
        ? {}
        : {
            cachedPromptTokens: cached,
            uncachedPromptTokens: Math.max(0, promptTokens - cached),
          }),
      ...(written === undefined ? {} : { cacheWriteTokens: written }),
      ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
      ...(cost === undefined ? {} : { costUsd: cost }),
      ...(provider ? { provider } : {}),
    });
  }
  return found;
}

/** The share of the prompt read from the cache, where the endpoint said. Null where it did not. */
export function cacheReadOf(usage: ModelUsage): number | null {
  if (usage.cachedPromptTokens === undefined || usage.promptTokens <= 0) {
    return null;
  }
  return usage.cachedPromptTokens / usage.promptTokens;
}
