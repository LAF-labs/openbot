import { SITE_REFUSED } from "@shared/task-ending";
import type { TaskEnding } from "@/lib/computer/browsing";
import { OUTCOME_LABELS } from "@/lib/computer/outcome-labels";
import { t } from "@/lib/i18n";

/**
 * THE WORDS FOR HOW A TASK STANDS, ONE SET, FOR EVERY PLACE THAT SAYS IT.
 *
 * 하는 중 · 사장님 차례 · 끝남 · 못 끝냄 · 멈춤. The card, the banner, 오늘 and the header's drawer read
 * these and nothing else, so one task cannot be 멈춤 on the card and 끝내지 못함 in 오늘. Which one it
 * is was decided from facts in `shared/task-ending.ts`; this only says it.
 *
 * 멈춤 is the owner's word — they pressed Stop, or the step never got its answer. A task that went
 * wrong on its own is 못 끝냄, with why beside it, and a site that turned the Bot away is one of those.
 */
export type TaskState = TaskEnding | { kind: "yourTurn" };

export function taskStateWord(state: TaskState): string {
  switch (state.kind) {
    case "running":
      return t("Working on it");
    case "yourTurn":
      return t("Your turn");
    case "done":
      return t("Finished");
    case "stopped":
      return t("Halted");
    case "failed":
      return t("Couldn't finish");
  }
}

/**
 * Why a task did not finish, short enough for the line beside the word. Undefined where the facts
 * do not say, rather than a guess.
 */
export function failureReason(
  code: string | null | undefined,
): string | undefined {
  if (!code) return undefined;
  const key = REASONS[code] ?? OUTCOME_LABELS[code];
  return key ? t(key) : undefined;
}

/**
 * Reasons said differently here than on a step's line, or not said there at all. `t(variable)` is
 * invisible to the coverage test, so `task-state.test.ts` walks this table.
 */
export const REASONS: Record<string, string> = {
  [SITE_REFUSED]: "The site turned the Bot away",
  "laf:person_declined": "You said no",
};

/** The word, and why when it did not finish: "못 끝냄 · 사이트가 봇을 막았어요". */
export function taskStateLine(state: TaskState): string {
  const word = taskStateWord(state);
  if (state.kind !== "failed") return word;
  const why = failureReason(state.code);
  return why ? `${word} · ${why}` : word;
}

/**
 * What the card says under its title where the state has words of its own: why a task did not
 * finish, or that it is the person the Bot is waiting on. Undefined everywhere else — the card
 * then says the newest thing the Bot said while doing it.
 *
 * A LINE OF ITS OWN, IN THE CARD'S READING SIZE. It used to ride behind the state's word in the
 * smallest text on the card ("못 끝냄 · 사이트가 봇을 막았어요"): the one thing a person needed to read
 * was the hardest to (the owner's screenshot, 2026-10-03). The word is a chip now, and this is the
 * sentence.
 */
export function taskStateDetail(state: TaskState): string | undefined {
  if (state.kind === "failed") return failureReason(state.code);
  if (state.kind === "yourTurn") {
    return t("It is waiting for your answer. The question is just above.");
  }
  return undefined;
}

/**
 * Failures no second asking changes, by their code: the answer was decided by what was asked for,
 * and asking for it again is the same question.
 *
 * - the owner's own no: the Bot would be asking what it was just told no to;
 * - the app's own address, and an address inside the deployment: the floor under every rule refuses
 *   those whoever asks and however often, and nothing a person can press changes it.
 *
 * A rule that refused is NOT here: a person can change the rule, and 다시 해 보기 is then exactly
 * what they press next.
 */
export const NO_RETRY: ReadonlySet<string> = new Set([
  "laf:person_declined",
  "laf:own_address_refused",
  "laf:navigation_refused",
]);

/** A failed task worth offering again: any but the ones {@link NO_RETRY} names. */
export function canRetry(state: TaskState): boolean {
  return state.kind === "failed" && !(state.code && NO_RETRY.has(state.code));
}
