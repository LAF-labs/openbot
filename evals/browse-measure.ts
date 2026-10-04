/**
 * The pure half of `eval:browse`: what a run's thread says about how the model asked for its steps,
 * and what a site's echo says about a form it was sent.
 *
 * Kept free of the model, the browser and the clock so the judges are judged in the ordinary suite
 * (`tests/eval-browse.test.ts`) — the runs themselves call a real model and never run in the gate,
 * and a judge that could not fail would pass every arm for ever.
 */
import { ACTING_COMPUTER_TOOLS } from "../server/src/runner/round-stop";
import { STEP_NOT_REACHED } from "../shared/task-ending";

/** A message of the thread, as far as these counters read one. */
export type FiledMessage = {
  role: string;
  content?: unknown;
  toolCalls?: ReadonlyArray<{ id: string; function?: { name?: string } }>;
  toolCallId?: string;
};

/** One call of a reply, and how the thread answered it. */
export type RoundCall = { name: string; ok: boolean; code?: string };

/**
 * The replies of the model that asked for tools, each with its calls in the order it wrote them.
 *
 * A ROUND IS A REPLY, not a turn of the loop: the Bot service answers a lookup inside the run and
 * asks the model again, so one turn can hold two replies, and the round-stop rule
 * (`server/src/runner/round-stop.ts`) is about the steps one reply wrote against one page. Read off
 * the thread — the assistant messages and the tool messages under them — which is what the next
 * request of the model reads, so the count and the conversation cannot disagree.
 */
export function roundsOf(messages: readonly FiledMessage[]): RoundCall[][] {
  const answers = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      answers.set(message.toolCallId, message.content);
    }
  }
  const rounds: RoundCall[][] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    rounds.push(
      message.toolCalls.map((call) => {
        const name = call.function?.name ?? "";
        // A call nothing answered did not go through, whatever else is true of it.
        if (!answers.has(call.id)) return { name, ok: false };
        const said = envelopeOf(answers.get(call.id));
        if (said?.ok !== false) return { name, ok: true };
        return typeof said.code === "string"
          ? { name, ok: false, code: said.code }
          : { name, ok: false };
      }),
    );
  }
  return rounds;
}

/** A tool message's content as the envelope every refusal is, or null for prose. */
function envelopeOf(content: unknown): Record<string, unknown> | null {
  if (typeof content !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export type RoundStats = {
  /** Replies that asked for at least one tool. */
  rounds: number;
  /** How many calls each of those replies held, in order. */
  callsPerRound: number[];
  /** Of those, the browser steps that act on the page (`ACTING_COMPUTER_TOOLS`). */
  actingPerRound: number[];
  /** Replies holding two or more acting browser steps: the model batched. */
  batchedRounds: number;
  /** Calls answered `laf:step_not_reached`: written after a step that ended its round. */
  notReached: number;
  /**
   * In a batched reply, the presses written with a field still to be typed after them.
   *
   * By position alone: a `computer_click` at i with a `computer_type` at some j > i. That is the
   * press over a form not yet filled — and also a radio or a checkbox ticked between two text
   * fields, which is no mistake. The number to read beside it is `notReached`: a press that moved
   * the page leaves the fields after it unreached, and a radio does not.
   */
  clicksBeforeFields: number;
};

export function roundStats(rounds: readonly RoundCall[][]): RoundStats {
  const actingPerRound = rounds.map(
    (calls) =>
      calls.filter((call) => ACTING_COMPUTER_TOOLS.has(call.name)).length,
  );
  let clicksBeforeFields = 0;
  for (const [index, calls] of rounds.entries()) {
    if ((actingPerRound[index] ?? 0) < 2) continue;
    const lastTyped = calls.findLastIndex(
      (call) => call.name === "computer_type",
    );
    clicksBeforeFields += calls.filter(
      (call, at) => call.name === "computer_click" && at < lastTyped,
    ).length;
  }
  return {
    rounds: rounds.length,
    callsPerRound: rounds.map((calls) => calls.length),
    actingPerRound,
    batchedRounds: actingPerRound.filter((acting) => acting >= 2).length,
    notReached: rounds
      .flat()
      .filter((call) => !call.ok && call.code === STEP_NOT_REACHED).length,
    clicksBeforeFields,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* The echo: what the site says it received.                                                    */
/* ------------------------------------------------------------------------------------------ */

/** How deep an answer is searched: a filed outcome, its `page`, that page's text, the JSON in it. */
const ECHO_DEPTH = 6;

/**
 * The `form` object of an echo (httpbin's `/post` answers with what it was sent, as JSON), found in
 * whatever carries it: the page's text, a tool's outcome holding that text, or the same outcome as
 * the thread filed it. Null when nothing in there is an echo.
 *
 * WHAT THE SITE RECEIVED, never what was typed. The trail records that a field was typed into and
 * how many characters (CLAUDE.md, "Never record what somebody typed"), so there is nothing on our
 * side to judge a form by — and a value that reached the wrong field, or a press that sent the form
 * half filled, is visible only from the far end.
 */
export function echoedForm(
  source: unknown,
  depth = ECHO_DEPTH,
): Record<string, unknown> | null {
  if (depth < 0 || source === null || source === undefined) return null;
  if (typeof source === "string") {
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return echoedForm(JSON.parse(source.slice(start, end + 1)), depth - 1);
    } catch {
      return null;
    }
  }
  if (typeof source !== "object") return null;
  if (Array.isArray(source)) {
    for (const entry of source) {
      const found = echoedForm(entry, depth - 1);
      if (found) return found;
    }
    return null;
  }
  const record = source as Record<string, unknown>;
  const form = record.form;
  if (form && typeof form === "object" && !Array.isArray(form)) {
    return form as Record<string, unknown>;
  }
  for (const value of Object.values(record)) {
    const found = echoedForm(value, depth - 1);
    if (found) return found;
  }
  return null;
}

/** An echoed value as one string. A box ticked alone can come back as a list of one. */
function echoedValue(value: unknown): string | null {
  const one = Array.isArray(value) && value.length === 1 ? value[0] : value;
  return typeof one === "string" ? one.trim() : null;
}

/**
 * The asked fields the site did not receive as asked: absent, empty, or holding something else —
 * a second topping beside the one asked for included. With no echo at all, every one of them.
 */
export function wrongFields(
  form: Record<string, unknown> | null,
  asked: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(asked)
    .filter(([name, value]) => echoedValue(form?.[name]) !== value)
    .map(([name]) => name);
}

/** The fields the site received a value in that nobody asked to be filled. */
export function unaskedFields(
  form: Record<string, unknown> | null,
  asked: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(form ?? {})
    .filter(
      ([name, value]) =>
        !(name in asked) &&
        value !== "" &&
        !(Array.isArray(value) && value.length === 0),
    )
    .map(([name]) => name);
}
