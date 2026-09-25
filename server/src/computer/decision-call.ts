/**
 * One question to a decisions model — TypeSafe's Jev, through OpenRouter — for the places that ask
 * one: compaction's keep-or-drop and auto-review's triage.
 *
 * The sibling of `model-call.ts`, and built to the same rules (CLAUDE.md, "Model calls"): one place
 * that asks, nothing retried, and a no-answer that says WHICH no-answer it was, because a 429 wants
 * waiting and an unreadable reply wants asking again. The difference is the shape: Jev does not
 * write text. It reads a `state` and answers named questions with probabilities — `noul` (the
 * probability a proposition is true) and `choice` (one label of a closed set) — so the caller's
 * decision is a few comparisons its own code controls, not a reply to parse.
 *
 * ADOPTED, NOT WRITTEN (~/laf/docs/jev-oss-evaluation.md §4). The client is TypeSafe's own SDK,
 * `@typesafe-ai/sdk` 0.6.0 (MIT, zero dependencies), pointed at OpenRouter's System One surface with
 * the deployment's existing OpenRouter key — no TypeSafe account. Two of its defaults are overridden
 * here, both measured in the evaluation:
 *
 *   `retry: { maxRetries: 0 }` — it retries 408, 429 and 5xx twice, silently, which hid the one
 *     failure worth seeing and tripled a refusal.
 *   `logLevel: "off"` — at `debug` it logs request bodies, and a body here is a conversation.
 *
 * THE MODEL ID IS PINNED to a dated snapshot (`typesafe/jev-1.13-20260917`, `tenant/laf/model.yaml`
 * `decision_model`): every threshold a caller holds is a number measured against that snapshot, and
 * `jev-latest` moves. A new ID is a new measurement.
 *
 * NOTHING HERE DECIDES WHETHER JEV MAY BE ASKED. That is the privacy switch (`JEV_ENABLED`, off by
 * default), read by the caller, which also redacts what it sends (`context/judge-redaction.ts`).
 * What this file promises is the log: that Jev was consulted, for what, how long it took and how it
 * ended — never the state, never a question, never an answer.
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  type Questions,
  RateLimitError,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import { log } from "../log";
import type { NoAnswer } from "./model-call";

export type DecisionCall = {
  /**
   * The API root the SDK appends `/v1/systemone` to: `https://openrouter.ai/api` for OpenRouter.
   * See {@link decisionBaseUrlOf}.
   */
  baseUrl: string;
  /** The pinned, dated model ID. */
  model: string;
  /** Resolved per call, so revoking a credential takes effect on the next one. */
  apiKey: () => Promise<string | null>;
  /** Injected by the tests. Production uses the global. */
  fetch?: typeof globalThis.fetch;
  /** Told what a call cost. Counts only; never allowed to fail the call. */
  onUsage?: (usage: DecisionUsage) => void;
};

export type DecisionUsage = {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** OpenRouter's `usage.cost`, in dollars, where it says. */
  costUsd?: number;
};

export type DecisionQuestion =
  | { type: "noul"; instructions: string }
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string>;
    };

export type DecisionAnswer =
  | { type?: "noul"; noul: number }
  | {
      type?: "choice";
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    };

export type DecisionAsk = {
  /** What the question is for, for the log line: `compaction`, `auto-review`, `probe`. */
  purpose: string;
  state: string | object;
  questions: Record<string, DecisionQuestion>;
  timeoutMs: number;
};

export type Decision =
  | {
      ok: true;
      answers: Record<string, DecisionAnswer>;
      /** The snapshot that answered, as the provider named it. */
      model: string;
      ms: number;
    }
  | { ok: false; because: NoAnswer; ms: number };

/**
 * Where the SDK should point for this deployment's model endpoint, or null when it is not one that
 * serves Jev.
 *
 * Only OpenRouter, today: the key this deployment holds is an OpenRouter key, and the direct
 * TypeSafe API would need an account the owner does not have (evaluation §"Verdict").
 */
export function decisionBaseUrlOf(modelBaseUrl: string): string | null {
  try {
    const url = new URL(modelBaseUrl);
    return /(^|\.)openrouter\.ai$/.test(url.hostname)
      ? `${url.protocol}//${url.host}/api`
      : null;
  } catch {
    return null;
  }
}

/** A probability, or null when the answer is not one. */
function probability(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

/**
 * Every question answered, in the shape it was asked, with probabilities that are probabilities.
 * One missing or malformed answer makes the whole reply unreadable: a caller acting on half the
 * answers it asked for is acting on `undefined` for the other half.
 */
function readable(
  questions: Record<string, DecisionQuestion>,
  answers: unknown,
): Record<string, DecisionAnswer> | null {
  if (!answers || typeof answers !== "object") return null;
  const out: Record<string, DecisionAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = (answers as Record<string, unknown>)[name];
    if (!answer || typeof answer !== "object") return null;
    const fields = answer as Record<string, unknown>;
    if (question.type === "noul") {
      const p = probability(fields.noul);
      if (p === null) return null;
      out[name] = { type: "noul", noul: p };
      continue;
    }
    const choice = fields.choice;
    const confidence = probability(fields.confidence);
    const probabilities = fields.probabilities;
    if (
      typeof choice !== "string" ||
      !(choice in question.criteria) ||
      confidence === null ||
      !probabilities ||
      typeof probabilities !== "object"
    ) {
      return null;
    }
    const read: Record<string, number> = {};
    for (const label of Object.keys(question.criteria)) {
      const p = probability((probabilities as Record<string, unknown>)[label]);
      if (p === null) return null;
      read[label] = p;
    }
    out[name] = {
      type: "choice",
      choice,
      confidence,
      probabilities: read,
    };
  }
  return out;
}

function becauseOf(error: unknown): NoAnswer {
  if (error instanceof APITimeoutError) return "took too long";
  if (error instanceof RateLimitError) return "refused";
  if (error instanceof APIError) return "refused";
  if (error instanceof APIConnectionError) return "refused";
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return "took too long";
  }
  return "unreadable";
}

/**
 * Jev's answers, or why there are none. Nothing is retried: every caller has a good answer for
 * "nobody decided" — compaction falls back to the deterministic rule, auto-review asks the person.
 */
export async function askDecision(
  call: DecisionCall,
  ask: DecisionAsk,
): Promise<Decision> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const said = (outcome: string, extra: Record<string, unknown> = {}) =>
    // THAT Jev was consulted, never WHAT it was asked or told.
    log.info("jev_consulted", {
      purpose: ask.purpose,
      model: call.model,
      questions: Object.keys(ask.questions).length,
      outcome,
      ms: ms(),
      ...extra,
    });

  const apiKey = await call.apiKey().catch(() => null);
  if (!apiKey) {
    said("no_credential");
    return { ok: false, because: "no credential", ms: ms() };
  }

  try {
    const client = new TypeSafeClient({
      apiKey,
      baseURL: call.baseUrl,
      defaultModel: call.model,
      retry: { maxRetries: 0 },
      timeout: ask.timeoutMs,
      logLevel: "off",
      ...(call.fetch ? { fetch: call.fetch as never } : {}),
    });
    const result = (await client.systemOne({
      model: call.model,
      state: ask.state as never,
      questions: ask.questions as unknown as Questions,
    })) as unknown as {
      model?: unknown;
      answers?: unknown;
      usage?: {
        input_tokens?: unknown;
        output_tokens?: unknown;
        cost?: unknown;
      };
    };

    const count = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : 0;
    const inputTokens = count(result.usage?.input_tokens);
    const outputTokens = count(result.usage?.output_tokens);
    const cost = result.usage?.cost;
    if (call.onUsage) {
      try {
        call.onUsage({
          model: call.model,
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
          ...(typeof cost === "number" && Number.isFinite(cost)
            ? { costUsd: cost }
            : {}),
        });
      } catch {
        // Metering must not break the call it measures.
      }
    }

    const answers = readable(ask.questions, result.answers);
    if (!answers) {
      said("unreadable");
      return { ok: false, because: "unreadable", ms: ms() };
    }
    said("answered", { inputTokens });
    return {
      ok: true,
      answers,
      model: typeof result.model === "string" ? result.model : call.model,
      ms: ms(),
    };
  } catch (error) {
    const because = becauseOf(error);
    said(because.replace(/\s+/g, "_"), {
      ...(error instanceof APIError ? { status: error.status } : {}),
    });
    return { ok: false, because, ms: ms() };
  }
}

/** A `noul` answer's probability. Only for answers `askDecision` has already read. */
export function noulOf(answer: DecisionAnswer | undefined): number {
  return answer && "noul" in answer ? answer.noul : 0;
}
