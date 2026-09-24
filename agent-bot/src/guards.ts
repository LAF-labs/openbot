import type { RunAgentInput } from "@ag-ui/core";
import { BRIDGE_TOOL_NAMES } from "../../shared/tools/bridge";
import { NOW_TOOL_NAME } from "../../shared/tools/now";
import type { ExposedTools } from "./deferral";
import { parseToolArguments, type TranscriptMessage } from "./transcript";

/**
 * What the loop refuses to forward, and the bounds it puts on one question.
 *
 * None of this is policy. The boundary decides whether an ACTION may happen and lives on the
 * server; what is here is whether a call is even a call — a name the run was handed, arguments
 * that are an object — and how much of a person's bill one question may run up before the Bot is
 * made to answer with what it has. A guard answers the model INSIDE THE RUN with a `laf:` fact
 * (`shared/prompt/tool-results.ko.ts`), the same way a bridge lookup is answered, so the model can
 * recover; the run ends on the fact only when it will not.
 *
 * Measured before any of it (audit A2, 2026-09-10): a made-up tool name ended the Bot's turn in
 * silence, because the browser has no handler for it and starts no follow-up; broken JSON put the
 * browser's English parser error into the transcript, again with no follow-up; and a Bot reading
 * the same page over and over was stopped by nothing this side of CopilotKit's hundredth follow-up
 * run — about two million tokens behind one spinner.
 */

/**
 * How many times one run goes back to the model after answering a call it could not forward — a
 * made-up name, arguments that are not an object — before it ends on the fact.
 *
 * Two, because the fact says what to do: a model that has read it twice and made the same kind of
 * mistake a third time is not going to read it a fourth. Ending the run with the fact is what puts
 * the turn in the ledger and on the person's screen, instead of in a loop nobody sees.
 */
export const MAX_TOOL_RECOVERIES = 2;

/**
 * The same tool with the same arguments this many times in a row is a loop, and the last of them
 * is answered rather than run.
 *
 * Three, not two: reading a page twice is a Bot checking whether something changed, which is
 * reasonable, and a third identical read is not going to say anything the second did not. The
 * gateway's repeat counter never saw this, because reading is not an action (`gateway.ts`,
 * "Reading a page never reaches this function").
 */
export const TOOL_LOOP_LIMIT = 3;

/*
 * WHAT ONE QUESTION MAY TAKE: STEPS AND DOLLARS, NOT HISTORY.
 *
 * The bound used to be `ASK_TOKEN_BUDGET`, six hundred thousand characters summed over every
 * request since the person last spoke — and every request carries the WHOLE conversation. A Bot
 * has one conversation for life, so the bound shrank as the Bot aged: at 100K characters of
 * history a question got six requests before the Bot was made to stop, at 200K three
 * (agent-harness-review §5.1). A long-lived Bot became less able to finish anything, and it was
 * paying for history the provider was serving from its cache at a fifth of the price.
 *
 * Claude Code bounds a task the way the Agent SDK does: `maxTurns` and `maxBudgetUsd`, ending in
 * `error_max_turns` and `error_max_budget_usd`. These are the same two bounds, per question.
 */

/**
 * How many model requests one question may take before the Bot is made to answer with what it
 * has: every assistant turn since the person last spoke, plus this run's rounds.
 *
 * Thirty is what the old budget allowed a browsing Bot on a fresh conversation (thirty requests of
 * ~20,000 characters), against the hundred the browser would have allowed: more than a long
 * honest task needs, and a third of a runaway one — now whatever the history weighs.
 */
export const MAX_QUESTION_STEPS = 30;

/**
 * What one question may cost, in dollars, as the provider reported it (`usage.cost`).
 *
 * The server sums the rows it filed for this question and forwards the total
 * (`forwardedProps.question.costUsd`); this run adds its own. Twenty cents: a twenty-step browsing
 * task on the deployment's model measured about three and a half cents with the conversation
 * cached (agent-harness-review §4), so this is a runaway's bound and never an honest task's. An
 * endpoint that reports no cost is bounded by the steps alone.
 */
export const MAX_QUESTION_COST_USD = 0.2;

/** The end reasons, as the run record and the surface read them. */
export const QUESTION_MAX_STEPS = "laf:question_max_steps";
export const QUESTION_MAX_COST = "laf:question_max_cost";

/**
 * How many model requests this question has already taken: the assistant turns since the person
 * last spoke. Each one was produced by exactly one request. The retry an empty answer gets is not
 * in the transcript and is not counted.
 */
export function stepsSinceLastAsk(
  transcript: readonly TranscriptMessage[],
): number {
  let steps = 0;
  for (const message of transcript) {
    if (message.role === "user") steps = 0;
    else if (message.role === "assistant") steps += 1;
  }
  return steps;
}

/**
 * The names a call may be forwarded under: every tool the run was handed, and the bridge where one
 * was offered.
 *
 * Handed, not offered this round. A connected service's tool sits behind the bridge and is never in
 * the schema, but once `tool_call` has forwarded it, the transcript shows the model calling it by
 * its real name — so the model may well call it directly next time, and the surface has a handler
 * for it. That is a real call, not a made-up one.
 */
export function knownToolNames(
  tools: RunAgentInput["tools"],
  exposed: ExposedTools,
): Set<string> {
  const names = new Set((tools ?? []).map((tool) => tool.name));
  // Answered by this service on every run (`./deferral`), whatever the caller handed.
  names.add(NOW_TOOL_NAME);
  if (exposed.bridged) {
    for (const name of BRIDGE_TOOL_NAMES) names.add(name);
  }
  return names;
}

/** The same arguments, however the model ordered the keys, are the same call. */
export function canonicalArguments(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalArguments).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalArguments(item)}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * How many turns in a row the transcript already ends with exactly this call.
 *
 * Walks back from the end over the assistant turns since anybody else spoke, counting each turn
 * that consisted of this one call with these arguments and stopping at the first that did not.
 * The results in between are stepped over: they are what the model read before asking again, and
 * they are why a repeat is a loop and not a retry.
 */
export function repeatsOf(
  transcript: readonly TranscriptMessage[],
  name: string,
  canonical: string,
): number {
  let repeats = 0;
  for (let at = transcript.length - 1; at >= 0; at -= 1) {
    const message = transcript[at];
    if (!message || message.role === "tool") continue;
    if (message.role !== "assistant") break;
    const calls = message.toolCalls ?? [];
    if (calls.length !== 1) break;
    const call = calls[0];
    if (!call || call.function.name !== name) break;
    const args = parseToolArguments(call.function.arguments ?? "");
    if (args === null || canonicalArguments(args) !== canonical) break;
    repeats += 1;
  }
  return repeats;
}
