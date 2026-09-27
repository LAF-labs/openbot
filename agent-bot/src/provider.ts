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
    /** How many times this conversation was cut: the policy's order starts that many places later. */
    cuts?: number;
  },
) => Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;

/**
 * The policy's order, started `cuts` places later.
 *
 * A NEW SESSION DID NOT MOVE A CUT CONVERSATION WHILE AN ORDER WAS SET (2026-09-27 code sprint).
 * `noteCut` gives a cut conversation a new session so its endpoint is chosen afresh, but an `order`
 * is tried first-to-last on every request whatever the session says — so with DeepSeek's measured
 * order the retry after a cut went straight back to the endpoint first in line, the one most likely
 * to have cut it. Each cut now starts the order one place further on; the endpoints it skips stay
 * in the pool behind it, and a conversation that was never cut is routed exactly as before.
 */
export function afterCuts(
  routing: ProviderRouting,
  cuts: number,
): ProviderRouting {
  const order = routing.order ?? [];
  if (cuts <= 0 || order.length < 2) return routing;
  const start = cuts % order.length;
  return {
    ...routing,
    order: [...order.slice(start), ...order.slice(0, start)],
  };
}

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
        ...(routing && !("provider" in request)
          ? { provider: afterCuts(routing, options?.cuts ?? 0) }
          : {}),
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
 * KEYED BY MODEL, IN CONFIGURATION. Which endpoints are good is a fact about one model's endpoints —
 * Wafer and Relace are GLM's — so the policy names the model it is for, and a deployment that swaps
 * `BOT_MODEL` sends no routing at all until somebody measures the new model's endpoints and writes
 * its line. Nothing here names a provider.
 *
 *   BOT_PROVIDER_POLICY  JSON: { "<model>": { "order": [...], "ignore": [...], "allow_fallbacks": bool } }
 *                        e.g. {"z-ai/glm-5.3-flash":{"order":["z-ai"],"ignore":["wafer","relace"]}}
 *
 * `allow_fallbacks` false fails rather than leave the order; left out, OpenRouter's fallback stays
 * on, because a Bot that answers from a cold cache is better than a Bot that does not answer.
 *
 * Sent only to OpenRouter: an unknown body field is a 400 on OpenAI's own API. Null when nothing is
 * configured for this model, so a deployment that says nothing sends exactly the request it always
 * sent. A policy that is not JSON is ignored and said so at boot (`./server`), never half-applied.
 */
/**
 * THE MEASURED LINES, used when `BOT_PROVIDER_POLICY` is unset. The fleet's VMs are written by
 * laf-control, whose env writer takes plain values only — JSON cannot travel that way — so a policy
 * that lived only in `.env` never reached a customer. These are the measured ones
 * (docs/laf/eval-pack.md): MiMo on Xiaomi read 99.8% of a week-long conversation from cache where
 * DeepInfra read 79.9% with tails past 160 s; GLM on Z.AI, without Wafer's empty arguments and
 * Relace's cold cache. DeepSeek V4.1 Flash (2026-09-26, one quick check, three turns 20 s apart on a
 * 15K prompt): ten endpoints read the second turn from cache; CoreWeave read nothing, Wafer's reads
 * cost ~7x the others' ($0.00093 against $0.00005–0.00023), and OpenInference (fp4) took 10–14 s.
 * Sail Research breaks bridged calls (2026-09-27): the round where a Bot sends several `tool_call`s
 * at once — the 지원사업 skill's searches — replayed three times each came back as a 502 mid-stream
 * three times in three there ("invalid or incomplete DSML tool-call block", "invalid arguments for
 * tool_call": DeepSeek's native call markup leaking into the nested `args`), and whole three times
 * in three on DeepInfra and on Novita. In the product the cut is "모델과의 연결이 끊겼어요" on a
 * shop owner's first task, and the conversation it leaves behind keeps failing on 다시 시도.
 * Setting the variable replaces them entirely, `{}` included.
 *
 * DEEPSEEK GOES TO THE FAST ENDPOINTS THAT KEEP A CACHE, CHEAPEST FIRST (2026-09-27). The 지원사업
 * walk's last round — 19.8K prompt tokens, four portal answers to screen — sat 28 s on "생각 중"
 * before its first word. Replayed through this service against OpenRouter (docs/laf/eval-pack.md,
 * "Answer latency"), it was neither the prompt nor the effort: the first chunk came in a median
 * 0.7–1.7 s cold on every endpoint, and `low` thought 921–1,141 tokens where `high` thought
 * 1,078–1,678. It was the endpoint. With nothing ordered OpenRouter weighs endpoints by the inverse
 * square of their price,
 * and sent that round to Relace seven times in seven, which thinks at 26–51 tokens a second: first
 * word 32.8 s median, done 54 s. Pinned, cold, three each: Alibaba 236–267 tokens a second, first word
 * 7.8–9.2 s; Parasail 379, 4.9 s; Together 218, 6.4 s; Makora 259, 7.6 s — and each of the four read
 * a repeated request from its cache and sent the four bridged searches whole, three times in three.
 * Novita (243) and Venice (292) are as fast but read nothing back on a repeat, and a Bot's one long
 * conversation lives on its cache; DeepInfra thought at 66 (23.5 s), Fireworks at 82 (14.1 s, and a
 * 5xx in three). Alibaba first because it is half the others' price on what is new in a round
 * ($0.15/M against $0.30/M, $0.60/M out against $1.20/M): $0.0045 for that cold round, where Relace
 * was $0.0018 and Together $0.0086. The rest stay in the pool behind the order, fallbacks on — a slow
 * answer is still better than none — except InferenceNet, which thought at ~14 tokens a second and
 * ran into `REQUEST_TIMEOUT_MS` three times in three, the answer cut at 120 s; as the cheapest
 * endpoint it is exactly where a fallback weighted by price would land. `sort: "latency"` was not
 * the knob: OpenRouter's latency is the first chunk, which was already under two seconds on every
 * endpoint that could answer; the wait was the speed of the thinking.
 */
export const MEASURED_PROVIDER_POLICY: Record<string, ProviderRouting> = {
  "deepseek/deepseek-v4.1-flash": {
    order: ["alibaba", "parasail", "together", "makora"],
    ignore: [
      "coreweave",
      "wafer",
      "open-inference",
      "sail-research",
      "inference-net",
    ],
  },
  "xiaomi/mimo-v2.6-pro": { order: ["xiaomi"] },
  "z-ai/glm-5.3-flash": { order: ["z-ai"], ignore: ["wafer", "relace"] },
};

export type ProviderRouting = {
  order?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
};

const slugs = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((slug): slug is string => typeof slug === "string")
        .map((slug) => slug.trim())
        .filter(Boolean)
    : [];

export function providerRoutingOf(
  env: Record<string, string | undefined>,
  baseUrl: string | undefined,
  model: string,
): ProviderRouting | null {
  if (!baseUrl || !/(^|\.)openrouter\.ai$/.test(safeHost(baseUrl))) {
    return null;
  }
  let policy: unknown;
  try {
    const configured = env.BOT_PROVIDER_POLICY?.trim();
    policy = configured ? JSON.parse(configured) : MEASURED_PROVIDER_POLICY;
  } catch {
    return null;
  }
  const entry =
    policy && typeof policy === "object"
      ? (policy as Record<string, unknown>)[model]
      : undefined;
  if (!entry || typeof entry !== "object") return null;
  const fields = entry as Record<string, unknown>;
  const order = slugs(fields.order);
  const ignore = slugs(fields.ignore);
  const fallbacks = fields.allow_fallbacks === false;
  if (order.length === 0 && ignore.length === 0 && !fallbacks) return null;
  return {
    ...(order.length > 0 ? { order } : {}),
    ...(ignore.length > 0 ? { ignore } : {}),
    ...(fallbacks ? { allow_fallbacks: false } : {}),
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export const PROVIDER_ROUTING = providerRoutingOf(process.env, BASE_URL, MODEL);

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
