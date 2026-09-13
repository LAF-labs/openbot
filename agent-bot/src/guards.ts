import type { RunAgentInput } from "@ag-ui/core";
import { BRIDGE_TOOL_NAMES } from "../../shared/tools/bridge";
import type { ExposedTools } from "./deferral";
import {
  parseToolArguments,
  toProviderMessages,
  type TranscriptMessage,
} from "./transcript";

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

/**
 * What one question may cost before the Bot is told to answer with what it has, in tokens — as
 * estimated from characters.
 *
 * Estimated because this service holds no database: the `laf.model.usage` events it emits are filed
 * by the server, and the only record of what this question has cost so far that reaches this
 * process is the transcript itself. So the estimate is the characters of every request this
 * question has produced, rebuilt from the transcript the way the converter built them (trimmed like
 * the real ones). A Korean character is about a token, which is the approximation the audit
 * measured with; English is three or four characters to a token, which errs towards stopping
 * sooner, never later. The real number is the sum of the usage rows.
 *
 * Six hundred thousand is thirty requests of the size the audit measured a browsing Bot settling
 * at (§5, ~20,000 characters each), against the hundred the browser would have allowed: more than
 * a long honest task needs, and a third of a runaway one.
 */
export const ASK_TOKEN_BUDGET = 600_000;

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
  if (exposed.deferred.length > 0) {
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

/**
 * What this question has cost so far, estimated — see `ASK_TOKEN_BUDGET`.
 *
 * Every assistant turn since the person last spoke was produced by one request carrying the
 * transcript up to that point, converted and trimmed as `toProviderMessages` does it; summing those
 * requests is the whole calculation. The retry an empty answer gets is not in the transcript and is
 * not counted, and neither is the request about to be made.
 */
export function spentSinceLastAsk(
  transcript: readonly TranscriptMessage[],
): number {
  let spent = 0;
  transcript.forEach((message, at) => {
    if (message.role === "user") {
      spent = 0;
      return;
    }
    if (message.role !== "assistant") return;
    spent += charsOf(toProviderMessages(transcript.slice(0, at)));
  });
  return spent;
}

/** What one request weighs, in the characters of the messages the model is sent. */
export function charsOf(
  messages: ReturnType<typeof toProviderMessages>,
): number {
  let chars = 0;
  for (const message of messages) {
    if (typeof message.content === "string") chars += message.content.length;
    if ("tool_calls" in message) {
      for (const call of message.tool_calls ?? []) {
        if (call.type !== "function") continue;
        chars += call.function.name.length + call.function.arguments.length;
      }
    }
  }
  return chars;
}
