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

export type ModelCall = {
  /** Where chat completions are answered. The same endpoint everything else in this deployment uses. */
  baseUrl: string;
  model: string;
  /** Resolved per call, so revoking a credential takes effect on the next one, not the next restart. */
  apiKey: () => Promise<string | null>;
  /** Injected by the tests. Production uses the global. */
  fetch?: typeof globalThis.fetch;
};

export type Ask = {
  system: string;
  user: string;
  timeoutMs: number;
  maxTokens: number;
};

/**
 * The model's answer as text, or null.
 *
 * Null covers every way there is no answer — no credential, a refusal, a timeout, a body that is
 * not what an OpenAI-compatible endpoint returns. They are one outcome here because the callers
 * treat them as one: nobody has answered this.
 */
export async function askModel(
  call: ModelCall,
  ask: Ask,
): Promise<string | null> {
  const apiKey = await call.apiKey().catch(() => null);
  if (!apiKey) return null;
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
          max_tokens: ask.maxTokens,
          messages: [
            { role: "system", content: ask.system },
            { role: "user", content: ask.user },
          ],
        }),
        signal: AbortSignal.timeout(ask.timeoutMs),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : null;
  } catch {
    // A timeout, a dead provider, a body that is not JSON. Nothing is retried: both callers have a
    // good answer for "nobody said anything", and neither is improved by waiting twice as long.
    return null;
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
