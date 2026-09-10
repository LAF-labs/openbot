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
  /** Aborted when the request outlives `REQUEST_TIMEOUT_MS`. Optional, so a test fake may ignore it. */
  options?: { signal?: AbortSignal },
) => Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;

/**
 * The seam, over a real client.
 *
 * Exported so a test can point the REAL SDK at a fake endpoint: the SDK's own behaviour on a
 * stream that ends without `[DONE]`, or on a 429, is not something a scripted iterator can stand
 * in for.
 */
export function createProvider(client: OpenAI): CompletionProvider {
  return (request, options) =>
    client.chat.completions.create({ ...request, stream: true }, options);
}

export const liveProvider: CompletionProvider = createProvider(
  new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: BASE_URL,
  }),
);
