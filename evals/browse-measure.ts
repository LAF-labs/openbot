/**
 * The pure half of `eval:browse`: the prompt of its other arm, what a run's thread says about how
 * the model asked for its steps, and what a site's echo says about a form it was sent.
 *
 * Kept free of the model, the browser and the clock so the judges are judged in the ordinary suite
 * (`tests/eval-browse.test.ts`) — the runs themselves call a real model and never run in the gate,
 * and a judge that could not fail would pass every arm for ever.
 */
import { ACTING_COMPUTER_TOOLS } from "../server/src/runner/round-stop";
import { BASE_KO, SEVERAL_STEPS_KO } from "../shared/prompt";
import { STEP_NOT_REACHED } from "../shared/task-ending";

/* ------------------------------------------------------------------------------------------ */
/* Arm A: the prompt without the paragraph about several steps in one reply.                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * A composed system message as it read before `BASE_KO` carried the paragraph inviting several
 * steps in one reply (`SEVERAL_STEPS_KO`, `shared/prompt/base.ko.ts`) — every other byte where it is.
 *
 * THE ARMS, AND WHICH ONE IS THE PRODUCT. The paragraph shipped on 2026-10-05 on what two arms
 * measured: the prompt without it, and the prompt with it spliced into the base at the very place
 * it now stands. So the product's prompt is the arm that was "B", and this function makes the
 * other one, for the day somebody asks whether the paragraph still pays — on a new model, or a
 * new wording. It was a splice in the other direction until then (`withInvitation`), and before
 * that an append at the END of the whole message, past the context layer: the most salient place a
 * prompt has, and one that left the cached static prefix as it was. That first arm measured an
 * upper bound and not the product, and its numbers were set aside.
 *
 * Throws when the message does not begin with today's base or the base does not hold the
 * paragraph exactly once: an arm A that silently ran the product's prompt would be a measurement
 * of nothing.
 */
export function withoutInvitation(system: string): string {
  const paragraph = `\n\n${SEVERAL_STEPS_KO}`;
  const at = BASE_KO.indexOf(paragraph);
  if (
    !system.startsWith(BASE_KO) ||
    at < 0 ||
    BASE_KO.indexOf(paragraph, at + 1) >= 0
  ) {
    throw new Error(
      "The paragraph cannot be taken out: the prompt does not begin with BASE_KO, or BASE_KO does not hold it exactly once.",
    );
  }
  return `${BASE_KO.slice(0, at)}${BASE_KO.slice(at + paragraph.length)}${system.slice(BASE_KO.length)}`;
}

/* ------------------------------------------------------------------------------------------ */
/* The answer: did the Bot get the thing.                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * Phrases a Bot uses when it did not get the thing. A pass on a `strict` task needs none of them.
 *
 * "열지 못하" and "응답하지 않아" were added on 2026-10-05: an answer that said the article "could
 * not be opened … did not respond" passed the news task as a summary (measured in the stored
 * answers of that day's runs).
 */
export const GAVE_UP =
  /(확인하지 못|찾지 못|열리지 않|열 수 없|열지 못하|응답하지 않아|막혀|접근이 제한|차단|보이지 않았|가져오지 못|읽지 못|실패했)/;

/**
 * Korean prose of at least `words` words of two syllables or more, wherever they stand.
 *
 * THE WORDS ARE COUNTED, NOT REQUIRED IN A ROW. The floor used to be `([가-힣]{2,}[^가-힣]+){12,}` —
 * twelve such words one after another — and Korean is full of words of one syllable (수, 등, 및,
 * 이, 그): "늘릴 수 있다" ends a run. Measured 2026-10-05 on 16 stored answers to the news task: five
 * complete three-line summaries failed at ten or eleven in a row, in both arms alike, and the
 * comparison of the arms turned on which arm had drawn more of them. A floor is there to tell
 * prose from an apology or an empty answer, and a count does that.
 */
export const koreanProse = (words: number): RegExp =>
  new RegExp(`(?:[가-힣]{2,}[\\s\\S]*?){${words},}`);

/** What a right answer to each ordinary task has to contain, and whether an apology fails it. */
export const ANSWER_JUDGES = {
  "naver-weather": { expects: /-?\d+(\.\d+)?\s*°|\d+\s*도/ },
  "naver-search": { expects: /[가-힣A-Za-z]{2,}/, strict: true },
  "naver-shopping": { expects: /\d{1,3}(,\d{3})+\s*원|\d{4,}\s*원/ },
  coupang: { expects: /\d{1,3}(,\d{3})+\s*원|\d{4,}\s*원/ },
  news: { expects: koreanProse(20), strict: true },
  blog: { expects: koreanProse(8), strict: true },
} as const satisfies Record<string, { expects: RegExp; strict?: true }>;

/** Whether an answer passes a task's judge: the pattern is there, and on a strict task no apology is. */
export function answerPasses(
  judge: { expects: RegExp; strict?: true },
  answer: string,
): boolean {
  return judge.expects.test(answer) && !(judge.strict && GAVE_UP.test(answer));
}

/* ------------------------------------------------------------------------------------------ */
/* The rounds: how the model asked for its steps.                                               */
/* ------------------------------------------------------------------------------------------ */

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
   * Replies in which a press that WENT THROUGH ended the round with acting steps still written
   * after it — the premature send: 검색 pressed, Enter, or a field typed with `submit`, before the
   * last field.
   *
   * Read off what it leaves behind, not off where it stands. The stopper is the acting call just
   * before the first `laf:step_not_reached` of the reply, and it counts when it is a press that
   * went through: an ok click, key or type ends a round only by moving the page or raising an
   * alert (`round-stop.ts`). A refusal or a question that ended the round is the rule doing its
   * work on something that did NOT happen, and is not counted here.
   *
   * It replaced a count by position — a click with a `computer_type` after it — which scored a
   * correct batch (a radio and a checkbox between two text fields) as two mistakes and could not
   * see Enter at all.
   */
  earlyPresses: number;
};

/** The steps that can send a form: a click, a key, and a field typed (with `submit`, Enter). */
const PRESSES: ReadonlySet<string> = new Set([
  "computer_click",
  "computer_key",
  "computer_type",
]);

const notReached = (call: RoundCall) =>
  !call.ok && call.code === STEP_NOT_REACHED;

export function roundStats(rounds: readonly RoundCall[][]): RoundStats {
  const actingPerRound = rounds.map(
    (calls) =>
      calls.filter((call) => ACTING_COMPUTER_TOOLS.has(call.name)).length,
  );
  let earlyPresses = 0;
  for (const calls of rounds) {
    const first = calls.findIndex(notReached);
    if (first < 0) continue;
    const stopper = calls
      .slice(0, first)
      .findLast((call) => ACTING_COMPUTER_TOOLS.has(call.name));
    if (stopper?.ok && PRESSES.has(stopper.name)) earlyPresses += 1;
  }
  return {
    rounds: rounds.length,
    callsPerRound: rounds.map((calls) => calls.length),
    actingPerRound,
    batchedRounds: actingPerRound.filter((acting) => acting >= 2).length,
    notReached: rounds.flat().filter(notReached).length,
    earlyPresses,
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

/**
 * Every time this run SENT the form: the echoes the site gave back to a press, in order.
 *
 * A press that sends a form brings the next page back with it (`page` on the outcome), so a send
 * is in the thread as the answer to a click, a key or a typed field that holds an echo. Reading
 * the echo page again afterwards is not a send, and neither is opening an address.
 */
export function echoedSends(
  messages: readonly FiledMessage[],
): Record<string, unknown>[] {
  const answers = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      answers.set(message.toolCallId, message.content);
    }
  }
  const sends: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (!PRESSES.has(call.function?.name ?? "")) continue;
      const echo = echoedForm(answers.get(call.id));
      if (echo) sends.push(echo);
    }
  }
  return sends;
}

export type FormVerdict = {
  passed: boolean;
  /** Whether the site answered with an echo at all: without one, the form was never sent. */
  echoed: boolean;
  /** How many times the form was sent. One is the task; two is a half-filled send, then another. */
  sends: number;
  wrongFields: string[];
  unaskedFields: string[];
};

/**
 * Whether a form task was done: the tab started on a page that is not the echo, the form was sent
 * exactly once, and what the site received is every asked field as asked and nothing else.
 *
 * Each of the three was a way to pass without doing it. The last echo used to win, so a form sent
 * half filled and then sent again passed; a field the ask said to leave empty could be filled; and
 * the tab's start was not checked, so with it and the Bot's own navigation both failing, the echo
 * read afterwards was the run before's.
 *
 * `page` is the echo read off the tab after the run, and the one the fields are judged by; where
 * the Bot went somewhere else after sending, the last send in its thread stands in.
 */
export function judgeForm(run: {
  startedClean: boolean;
  sends: readonly Record<string, unknown>[];
  page: Record<string, unknown> | null;
  asked: Readonly<Record<string, string>>;
}): FormVerdict {
  const echo = run.page ?? run.sends.at(-1) ?? null;
  const wrong = wrongFields(echo, run.asked);
  const unasked = unaskedFields(echo, run.asked);
  return {
    passed:
      run.startedClean &&
      run.sends.length === 1 &&
      wrong.length === 0 &&
      unasked.length === 0,
    echoed: echo !== null,
    sends: run.sends.length,
    wrongFields: wrong,
    unaskedFields: unasked,
  };
}
