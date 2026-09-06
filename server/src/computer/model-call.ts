/**
 * One question to a model, answered as JSON, for the two places that need one.
 *
 * The boundary asks a model twice: once to judge whether an action falls under somebody's standing
 * instruction (`auto-review.ts`), and once to write up what somebody demonstrated
 * (`write-up.ts`). Both send a system prompt and a body, both want JSON back, and both must treat
 * whatever comes back as a suggestion rather than a fact.
 *
 * Written by hand against `/v1/chat/completions` rather than through an SDK, because the first of
 * those two decides whether a person is shown an action at all: the prompt, the body, the timeout
 * and the parsing want to be small enough to read in one sitting, with no library behaviour to
 * reason about in between.
 *
 * It returns the raw text. Deciding what an unparseable answer means belongs to the caller, and the
 * two answers are different — a judgement that cannot be read is a refusal, a write-up that cannot
 * be read is nothing to show.
 */

import { providerStatusFact } from "../failure-text";
import { log } from "../log";

export type ModelCall = {
  /** Where chat completions are answered. The same endpoint everything else in this deployment uses. */
  baseUrl: string;
  model: string;
  /** Resolved per call, so revoking a credential takes effect on the next one, not the next restart. */
  apiKey: () => Promise<string | null>;
  /** Injected by the tests. Production uses the global. */
  fetch?: typeof globalThis.fetch;
  /**
   * Told what a call cost, when the provider says. Counts only — the caller decides where they
   * land (the audit trail, in production). Never awaited and never allowed to fail the call:
   * metering must not be able to break the feature it measures.
   */
  onUsage?: (usage: ModelUsage) => void;
};

export type ModelUsage = {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type Ask = {
  system: string;
  user: string;
  timeoutMs: number;
  /**
   * A ceiling on the reply, or none.
   *
   * OMITTING IT IS SOMETIMES THE ONLY WAY TO GET AN ANSWER. A reasoning model spends this budget on
   * thinking before it writes anything, so a cap sized for the answer is spent before the answer
   * starts and what comes back is an empty message. Measured against this deployment's model: a
   * twelve-hundred-token ceiling produced empty content most tries, including one that came back in
   * a second, and the same request without a ceiling answered.
   *
   * The timeout is the real bound. A cap is a cost control, and one that silently turns answers
   * into nothing is a worse trade than the tokens it saves.
   */
  maxTokens?: number;
  /**
   * How long the model may think before it answers, where it is a model that thinks at all.
   *
   * The other half of the trap above. Removing the ceiling stops a reasoning model returning an
   * empty message; it does not stop it spending thirty seconds on "is this read-only", which times
   * out and asks the person anyway. Sent as `reasoning_effort`, which is what this deployment's
   * chat-completions endpoint takes — the same setting the runtime sends per Bot, by another road
   * (see `copilot.ts`, which goes through the SDK and has to force it past a name heuristic).
   *
   * Omitted entirely unless the deployment says its model reasons (`model.yaml supports_effort`).
   * A model that does not take the field can refuse the whole request over it, so guessing here
   * would trade an empty answer for no answer.
   */
  reasoningEffort?: "low" | "medium" | "high";
};

/**
 * Why there is no answer.
 *
 * They were one outcome — null — on the argument that the callers treat them the same. Measured,
 * they do not: four write-ups in a row gave one answer at twenty-four seconds, one timeout at
 * sixty, and two refusals at under a second, and all four said the same sentence to the person.
 * Somebody watching a button fail instantly, twice, is watching a broken feature; somebody told
 * the provider is busy knows to come back. The kinds also read differently in a log.
 */
export type NoAnswer =
  /** Nothing is configured to answer. Pressing again will do the same thing. */
  | "no credential"
  /** The provider said no — out of quota, rate limited, having an outage. Later, not again now. */
  | "refused"
  /** It took longer than the caller was willing to wait. */
  | "took too long"
  /** It answered, and the answer was not usable. Pressing again may well work. */
  | "unreadable";

export type Answer =
  | { ok: true; text: string }
  | { ok: false; because: NoAnswer };

/**
 * The model's answer, or why there is not one.
 *
 * Nothing is retried. Both callers have a good answer for "nobody said anything", and the one
 * failure worth retrying least is the one that arrives in a second because a provider is refusing.
 */
export async function askModel(call: ModelCall, ask: Ask): Promise<Answer> {
  const apiKey = await call.apiKey().catch(() => null);
  if (!apiKey) return { ok: false, because: "no credential" };
  const send = call.fetch ?? globalThis.fetch;

  try {
    const response = await send(
      `${call.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: call.model,
          // Deterministic. A boundary that answers differently on a retry is one nobody can reason
          // about, and a write-up that changed every time it was asked would be a lottery.
          temperature: 0,
          ...(ask.maxTokens === undefined ? {} : { max_tokens: ask.maxTokens }),
          ...(ask.reasoningEffort === undefined
            ? {}
            : { reasoning_effort: ask.reasoningEffort }),
          messages: [
            { role: "system", content: ask.system },
            { role: "user", content: ask.user },
          ],
        }),
        signal: AbortSignal.timeout(ask.timeoutMs),
      },
    );
    if (!response.ok) {
      // Said out loud, because a refusal that arrives in under a second is the one failure a person
      // will otherwise read as the feature being broken. The status as a fact word, never the
      // body: the body names the vendor and the model's real catalogue entry.
      log.error("model_call_refused", {
        model: call.model,
        status: response.status,
        reason: providerStatusFact(response.status),
      });
      return { ok: false, because: "refused" };
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    if (call.onUsage && body.usage) {
      try {
        call.onUsage({
          model: call.model,
          promptTokens: body.usage.prompt_tokens ?? 0,
          completionTokens: body.usage.completion_tokens ?? 0,
          totalTokens: body.usage.total_tokens ?? 0,
        });
      } catch {
        // Metering must not break the call it measures.
      }
    }
    const content = body.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim()
      ? { ok: true, text: content }
      : { ok: false, because: "unreadable" };
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, because: timedOut ? "took too long" : "refused" };
  }
}

/**
 * JSON out of whatever came back, or null.
 *
 * Models fence JSON in markdown about as often as they do not, so the fence is stripped before the
 * parse. Anything that is not an object is null: an array or a bare string is not an answer to a
 * question that asked for fields, and guessing at it is how a caller ends up acting on `undefined`.
 */
export function jsonFrom(
  content: string | null,
): Record<string, unknown> | null {
  if (!content) return null;
  const fenced = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const parsed: unknown = JSON.parse(fenced);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
