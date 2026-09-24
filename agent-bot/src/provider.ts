import OpenAI from "openai";

/**
 * The model, where it is answered from, and the one call this service makes to it.
 *
 * Which model drives the Bot has NO DEFAULT, on purpose. It used to fall back to `gpt-5.5` while
 * the tenant package fell back to `gpt-4.1` and the deployment ran `z-ai/glm-5.3-flash`: three
 * answers to one question, and the two written here were both wrong. A default in this file cannot
 * be the deployment's decision — it is not where the deployment is described — so the fallback
 * lives once, in the tenant package's `model.yaml`, and `BOT_MODEL` carries it here. Unset, the
 * service refuses to start (`./server`) rather than answering on a model nobody chose.
 *
 * Whatever it names is sent verbatim through `/v1/chat/completions`, which is the API this service
 * uses. `gpt-5.6-*` models require the Responses API for tool use and cannot be used by this
 * chat-completions streaming loop.
 */
export const MODEL = process.env.BOT_MODEL?.trim() ?? "";

/**
 * Where that model is answered from.
 *
 * Unset, this is OpenAI. Set, it is any endpoint speaking the same `/v1/chat/completions` API: a
 * gateway in front of several providers, a proxy, or a model on hardware you control. Which is the
 * point of writing against that API by hand rather than against one company's URL.
 *
 * `BOT_MODEL` is sent verbatim, because an endpoint names its own catalogue.
 */
export const BASE_URL = process.env.OPENAI_BASE_URL?.trim() || undefined;

/**
 * The longest one model request may take before this service gives up on it.
 *
 * There was no bound at all. A provider that accepts a request and then never finishes it held the
 * turn open until something further up the chain got bored, and the person watched a spinner with
 * nothing behind it. Generous — a reasoning model on a long page genuinely takes a minute — and
 * finite, which is the whole point.
 */
export const REQUEST_TIMEOUT_MS = 120_000;

/**
 * The one call this service makes to a model, as a seam.
 *
 * A test hands in a fake that yields scripted chunks; the service itself never notices. Narrower
 * than the whole client on purpose: it is the only method used, and a fake of one method cannot
 * drift from a client it does not pretend to be.
 */
export type CompletionProvider = (
  request: Parameters<OpenAI["chat"]["completions"]["create"]>[0],
  options?: {
    /** Aborted when the request outlives `REQUEST_TIMEOUT_MS`. Optional, so a test fake may ignore it. */
    signal?: AbortSignal;
    /** Per-request headers — the conversation's `x-session-id` (`./turn`). */
    headers?: Record<string, string>;
  },
) => Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;

/**
 * The seam, over a real client.
 *
 * Exported so a test can point the REAL SDK at a fake endpoint: the SDK's own behaviour on a
 * stream that ends without `[DONE]`, or on a 429, is not something a scripted iterator can stand
 * in for.
 */
export function createProvider(
  client: OpenAI,
  routing: ProviderRouting | null = null,
): CompletionProvider {
  return (request, options) =>
    client.chat.completions.create(
      {
        ...request,
        stream: true,
        // A caller's own `provider` (the eval's pin) wins over the deployment's policy.
        ...(routing && !("provider" in request) ? { provider: routing } : {}),
      } as typeof request & { stream: true },
      {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.headers ? { headers: options.headers } : {}),
      },
    );
}

/**
 * Which of OpenRouter's endpoints this deployment's model may be answered by — its provider
 * routing (https://openrouter.ai/docs/guides/routing/provider-selection), as a policy.
 *
 * WHY THERE IS ONE (agent-harness-design row 7, R9). A cache lives with one provider, and
 * OpenRouter spreads `z-ai/glm-5.3-flash` over dozens of endpoints that are not the same product:
 * measured in phase 1 and again here (docs/laf/eval-pack.md), Wafer sent bridged tool-call
 * arguments empty two times in four, and Relace does not serve a cache it wrote seconds earlier. The
 * session header keeps a conversation on one endpoint; this decides which endpoints are in the pool
 * at all, and which is tried first.
 *
 *   BOT_PROVIDER_ORDER   comma-separated slugs, tried in order (`z-ai`)
 *   BOT_PROVIDER_IGNORE  comma-separated slugs never used (`wafer,relace`)
 *   BOT_PROVIDER_FALLBACKS `off` to fail rather than leave the order; anything else leaves
 *                        OpenRouter's fallback on, because a Bot that answers from a cold cache is
 *                        better than a Bot that does not answer
 *
 * Sent only to OpenRouter: an unknown body field is a 400 on OpenAI's own API. Null when nothing is
 * configured, so a deployment that says nothing sends exactly the request it always sent.
 */
export type ProviderRouting = {
  order?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
};

const slugsOf = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);

export function providerRoutingOf(
  env: Record<string, string | undefined>,
  baseUrl: string | undefined,
): ProviderRouting | null {
  if (!baseUrl || !/(^|\.)openrouter\.ai$/.test(safeHost(baseUrl))) {
    return null;
  }
  const order = slugsOf(env.BOT_PROVIDER_ORDER);
  const ignore = slugsOf(env.BOT_PROVIDER_IGNORE);
  const fallbacks = env.BOT_PROVIDER_FALLBACKS?.trim().toLowerCase();
  if (order.length === 0 && ignore.length === 0 && fallbacks !== "off") {
    return null;
  }
  return {
    ...(order.length > 0 ? { order } : {}),
    ...(ignore.length > 0 ? { ignore } : {}),
    ...(fallbacks === "off" ? { allow_fallbacks: false } : {}),
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export const PROVIDER_ROUTING = providerRoutingOf(process.env, BASE_URL);

/**
 * THE CLIENT RETRIES NOTHING ON ITS OWN. The OpenAI SDK retries a 408, a 429, a 5xx and a dropped
 * connection twice by default, silently — and on OpenRouter a retry is a new routing decision, so a
 * conversation could come back from a different endpoint's cold cache with nothing anywhere saying
 * it had. It also turned a provider's refusal into three refusals and a minute of waiting. Retries
 * are now the loop's, once, logged, and never for a 429 (`./run`, `isRetryable`).
 */
export const liveProvider: CompletionProvider = createProvider(
  new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: BASE_URL,
    maxRetries: 0,
  }),
  PROVIDER_ROUTING,
);
