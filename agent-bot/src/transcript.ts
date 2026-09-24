import { createHash } from "node:crypto";
import type { RunAgentInput } from "@ag-ui/core";
import type OpenAI from "openai";
import { textOf } from "../../shared/message-content";
import { toolResultText } from "../../shared/prompt/tool-results.ko";
import { spillLineOf } from "../../shared/spillover";
import type { ProviderSession } from "./turn";

/**
 * The conversation as AG-UI carries it, turned into what the model provider expects — and what
 * this service reads out of the run's `forwardedProps` on the way.
 *
 * Nothing here talks to a model or a socket. It is the part of the loop that can be checked by
 * looking at its output, and the part that the context budget lives in.
 */

/** One message of the transcript, in AG-UI's own shape. */
export type TranscriptMessage = RunAgentInput["messages"][number];

/**
 * How many of the most recent tool results are forwarded whole.
 *
 * A page's readable text comes back up to 6,000 characters (`agent-computer`), and in Korean that
 * is roughly as many tokens. Ten steps of browsing therefore put forty to sixty thousand tokens of
 * page text in front of the model, most of it pages it has already finished with, and every one of
 * those turns is paid for again. The recent ones are what the model is still working from; the
 * older ones only have to be recognisable.
 */
const TOOL_RESULTS_IN_FULL = 4;

/** How much of an older tool result survives. Enough to know what page it was. */
const TRIMMED_TOOL_RESULT_CHARS = 500;

/**
 * Every tool result together, per request to the model.
 *
 * The count above bounds how many results are whole, not how much they weigh: four whole pages
 * are 24,000 characters, and a file read is up to 64,000 on its own. Over this, the oldest of the
 * whole ones are trimmed too — never the newest, which is the result the model just asked for.
 * The server files anything over 1,500 characters on the Bot's computer from the run after it
 * arrived (`shared/spillover.ts`), so on a deployment with a computer the budget is rarely
 * reached; without one, this is what keeps a long transcript from pushing the person's question
 * out of the window. A bridge lookup's answer (`./deferral`) is a tool result too, and counts.
 */
export const TOOL_RESULT_TURN_BUDGET = 20_000;

/**
 * An older tool result, cut — and SAID TO BE CUT.
 *
 * A silent truncation is read by the model as "that page did not say anything about it", which
 * is a confident wrong answer rather than a missing one. A result the server has already filed
 * ends in the line naming its file; that line is kept in place of the trim marker, because a cut
 * that lost the path would turn a result the model could still read whole into one it cannot.
 */
function trimmed(content: string): string {
  const filed = spillLineOf(content);
  return `${content.slice(0, TRIMMED_TOOL_RESULT_CHARS)}\n${filed ?? toolResultText("laf:tool_result_trimmed")}`;
}

/**
 * Which tool results are to be trimmed: the ones older than the last few, and then, while the
 * whole of them together is still over the budget, the oldest of the rest.
 *
 * By position, not by tool name: the name of the tool a result answers is only knowable by walking
 * back to the assistant message that called it, and the thing that actually costs tokens is length.
 * A short result — an approval question, a saved file — is under the cut either way, so the rule
 * that reads on length is the same rule as the one that reads on "is this page text", without
 * needing to be right about which tool produced it.
 */
function toolResultsToTrim(
  messages: readonly TranscriptMessage[],
): Set<number> {
  const results: Array<{ at: number; text: string }> = [];
  messages.forEach((message, at) => {
    if (message.role === "tool") {
      results.push({ at, text: textOf(message.content) });
    }
  });

  const trim = new Set<number>();
  /** Marks a result for trimming and returns what that saves — nothing, when it is short already. */
  const cut = (result: { at: number; text: string }) => {
    if (result.text.length <= TRIMMED_TOOL_RESULT_CHARS) return 0;
    trim.add(result.at);
    return result.text.length - trimmed(result.text).length;
  };

  let total = results.reduce((sum, result) => sum + result.text.length, 0);
  for (const older of results.slice(0, -TOOL_RESULTS_IN_FULL)) {
    total -= cut(older);
  }
  // Oldest first, and never the last: that one is the result the model just asked for.
  for (const recent of results.slice(-TOOL_RESULTS_IN_FULL, -1)) {
    if (total <= TOOL_RESULT_TURN_BUDGET) break;
    total -= cut(recent);
  }
  return trim;
}

/**
 * Translate the conversation AG-UI carries into the shape the model provider expects.
 *
 * Takes the transcript rather than the run, because a run's transcript grows inside the run: a
 * bridge lookup answered here (`./deferral`) is appended after the conversation as it arrived,
 * and the next round converts the whole of it again — so the lookup's answer is weighed against
 * the turn budget and cut like every other tool result.
 */
export function toProviderMessages(transcript: readonly TranscriptMessage[]) {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const trimmable = toolResultsToTrim(transcript);
  let at = -1;

  for (const message of transcript) {
    at += 1;
    if (message.role === "user") {
      // Not `String(content)`: a user message's content can be an array of parts, and stringifying
      // one hands the model "[object Object]" with nothing anywhere saying so. See message-content.
      messages.push({ role: "user", content: textOf(message.content) });
      continue;
    }
    if (message.role === "system" || message.role === "developer") {
      messages.push({ role: "system", content: textOf(message.content) });
      continue;
    }
    if (message.role === "tool") {
      // Tool results are appended so the model can continue from the completed call — the older
      // ones cut, and said to be cut (see `trimmed`).
      const content = textOf(message.content);
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: trimmable.has(at) ? trimmed(content) : content,
      });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.function.name,
          arguments: readableArguments(call.function.arguments),
        },
      }));
      messages.push({
        role: "assistant",
        content: message.content ?? null,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  return messages;
}

/**
 * A call's arguments, if they are what a surface can execute: a JSON object.
 *
 * An empty string is `{}`, because that is what providers send for a call with no arguments.
 * Anything else that is not an object — broken JSON, an array, a bare string — is null.
 */
export function parseToolArguments(
  raw: string,
): Record<string, unknown> | null {
  const text = raw.trim();
  if (text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * An earlier call's arguments as they go back to the provider: as the model wrote them, unless
 * that was not an object.
 *
 * A call with broken arguments is answered with a fact rather than run (`./guards`), and the next
 * request carries the call so the model can see what it is recovering from. The broken string
 * cannot go back as it was: an endpoint that turns the call into its own model's shape parses those
 * arguments, and a parse error there is a 400 on the recovery request — and on every later request
 * in the thread, since the call stays in it. `{}` beside the fact that says the arguments were not
 * an object is what the model needs to try again.
 */
function readableArguments(raw: string): string {
  return parseToolArguments(raw) === null ? "{}" : raw;
}

/** The product's three words for how hard a Bot thinks. */
export type ProductEffort = "quick" | "balanced" | "thorough";

/** What a provider is sent as `reasoning_effort`. `max` is GLM's own top, which OpenAI does not name. */
export type ProviderEffort = "low" | "medium" | "high" | "max";

/**
 * The product's words in a model's own vocabulary, where the model has one of its own.
 *
 * GLM-5.3 AND 5.3-FLASH DEFINE `low`, `high` AND `max` — AND NOT `medium`, which is what `balanced`
 * was sent as. Z.ai's docs name the three and default to `max`; OpenRouter's listing says
 * `supported_efforts: [max, high, low]`; the model's own chat template turns anything that is not
 * low or high into Max. So `medium` meant whatever each of the 31 endpoints decided, and measured
 * (agent-harness-review §4.4) Wafer rendered it exactly like `low` while others rendered Max. An
 * effort that means a different thing per provider is a setting going nowhere in particular.
 *
 * So the model's three, in order: `quick` → `low`, `balanced` → `high`, `thorough` → `max`. Three
 * settings on the Bot's profile must stay three different requests — two that sent the same word
 * would be a control that saves and does nothing (CLAUDE.md).
 *
 * `balanced`, the default, by the eval (`bun run eval:model`, 2026-09-25, docs/laf/eval-pack.md).
 * Pinned to one provider (Z.AI, two runs a scenario) the pack's 22 scenarios went from 40 of 44 at
 * `medium` to 42 of 44 at `high`, and the five new time and place scenarios 10 of 10. Unpinned,
 * three runs each, `low` and `high` were the same within the noise (57 and 56 of 66), and the noise
 * was a provider: Wafer sends a bridged call's arguments empty at either effort (2 of 4, where Z.AI
 * and Relace were 4 of 4). `high` spent 15% more tokens than `low` at about the same latency, and
 * `low` on Z.AI reasoned not at all. The default is the Bot every person has, so it takes the
 * model's middle, not its floor; `max` for `thorough` was accepted by the provider and measured
 * 25 of 27 at 18 s a scenario.
 *
 * Matched on the name `BOT_MODEL` sends, because that is the only thing this service knows about
 * the model. Any other model keeps the OpenAI words, which every OpenAI reasoning model defines.
 */
const MODEL_EFFORTS: ReadonlyArray<{
  model: RegExp;
  words: Record<ProductEffort, ProviderEffort>;
}> = [
  {
    model: /(^|\/)glm-5\.3/i,
    words: { quick: "low", balanced: "high", thorough: "max" },
  },
];

const OPENAI_EFFORTS: Record<ProductEffort, ProviderEffort> = {
  quick: "low",
  balanced: "medium",
  thorough: "high",
};

/**
 * How hard to think, as the caller asked and this model spells it.
 *
 * The words on the wire are the product's — `quick`, `balanced`, `thorough` — because the server
 * and this service speak different APIs and would otherwise each need the other's spelling. Each
 * end translates its own, so a third would be one file, not a change everywhere upstream.
 *
 * Undefined for anything else, including nothing at all. A caller that says nothing gets exactly
 * the request this service made before the setting existed, which is the only safe reading of
 * silence — and a value this service does not recognise is silence.
 */
export function reasoningEffortOf(
  input: RunAgentInput,
  model = "",
): ProviderEffort | undefined {
  const forwarded = input.forwardedProps;
  if (!forwarded || typeof forwarded !== "object") return undefined;
  const effort = (forwarded as Record<string, unknown>).effort;
  if (effort !== "quick" && effort !== "balanced" && effort !== "thorough") {
    return undefined;
  }
  const words =
    MODEL_EFFORTS.find((entry) => entry.model.test(model))?.words ??
    OPENAI_EFFORTS;
  return words[effort];
}

/**
 * The person's time zone, as the server's middleware forwards it for the `now` tool.
 *
 * Undefined when nothing was said — the tool then reads Seoul (`resolveTimeZone`), which is the
 * deployment's default, rather than this container's clock zone, which is nobody's.
 */
export function timeZoneOf(input: RunAgentInput): string | undefined {
  const forwarded = input.forwardedProps;
  if (!forwarded || typeof forwarded !== "object") return undefined;
  const zone = (forwarded as Record<string, unknown>).timeZone;
  return typeof zone === "string" && zone.trim() ? zone.trim() : undefined;
}

/**
 * What this question has cost in dollars before this run, as the server counted it from the usage
 * rows it filed (`server/src/context/conversations.ts`). Zero when nothing was said: this service
 * holds no record of earlier runs, and a caller that sends nothing gets the bound from this run's
 * own spend alone.
 */
export function questionCostOf(input: RunAgentInput): number {
  const forwarded = input.forwardedProps;
  if (!forwarded || typeof forwarded !== "object") return 0;
  const question = (forwarded as Record<string, unknown>).question;
  if (!question || typeof question !== "object") return 0;
  const cost = (question as Record<string, unknown>).costUsd;
  return typeof cost === "number" && Number.isFinite(cost) && cost > 0
    ? cost
    : 0;
}

/**
 * Which Bot this run belongs to, for this service's own log.
 *
 * It had no way to know. A Bot's whole identity arrived as a system message, so every line this
 * service logged named a run and a model and no Bot, and an operator reading them could not tell
 * whose turn had failed. The server puts it in `forwardedProps`; this only reads it.
 */
export function botIdOf(input: RunAgentInput): string {
  const forwarded = input.forwardedProps;
  if (!forwarded || typeof forwarded !== "object") return "unknown-bot";
  const botId = (forwarded as Record<string, unknown>).botId;
  return typeof botId === "string" && botId ? botId : "unknown-bot";
}

const hashed = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);

/**
 * Who this conversation is, to the provider: the thread and the Bot, hashed.
 *
 * One session per Bot conversation, not per epoch: the tools and the static prompt at the head of
 * every request are the same across epochs, and a new epoch on the same provider still reads them
 * from its cache. Hashed although a thread id is an id this deployment mints and carries nothing
 * personal — what leaves for a third party is what could never be read back into anything.
 */
export function providerSessionOf(
  input: RunAgentInput,
): ProviderSession | undefined {
  if (typeof input.threadId !== "string" || !input.threadId) return undefined;
  return {
    id: hashed(`laf-conversation:${input.threadId}`),
    user: hashed(`laf-bot:${botIdOf(input)}`),
  };
}
