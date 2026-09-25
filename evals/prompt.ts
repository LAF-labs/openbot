/**
 * The prompt the eval sends, which is the prompt production sends.
 *
 * `agent-bot` no longer carries a system prompt of its own: the server composes one and the
 * service forwards it. So an eval that sent no system message was, from this change onwards,
 * measuring a Bot with no instructions at all — and before it, measuring upstream's English
 * original while the product shipped something else. Both are the same failure the harness banner
 * has always warned about, one level up.
 *
 * The standing role here is a REAL one. The old eval sent none, so every verdict was about a Bot
 * with no name, no job and no memories, which is a Bot nobody has: a person's Bot always carries a
 * role message, and the fixed overhead it adds is part of what the model has to work through.
 */
import { createHash } from "node:crypto";
import {
  composePrompt,
  contextFactsFor,
  DEFAULT_TIME_ZONE,
  earlierSummaryText,
  type PromptMode,
  type PromptPerson,
  type PromptSkill,
  promptSkeleton,
  reminderBlock,
  reminderLines,
  withReminder,
} from "../shared/prompt";
import { BRIDGE_TOOLS } from "../shared/tools/bridge";
import { COMPUTER_TOOLS } from "../shared/tools/computer";
import { NOW_TOOL } from "../shared/tools/now";
import { SELF_TOOLS } from "../shared/tools/self";

/**
 * One clock for the whole run, read once.
 *
 * The real one, not a fixture: the date line is computed from the server clock in production and a
 * frozen date would certify an arithmetic the product never does. Read ONCE so the scenario that
 * checks the date and the prompt that carries it cannot disagree by a minute — which they would,
 * across midnight, exactly when the answer matters.
 */
export const EVAL_NOW = new Date();

export const EVAL_TIME_ZONE = DEFAULT_TIME_ZONE;

/** A shop owner's Bot, of the kind this product is for. */
export const EVAL_BOT = {
  id: "eval_bot",
  name: "미소",
};

export const EVAL_STANDING_ROLE =
  "우리 온라인 가게의 주문과 영수증을 챙긴다. 아침마다 새 주문을 확인하고, 경비를 정리하고, 사장님이 물어보면 가게 관련해서 아는 것을 답한다.";

/*
 * DELIBERATELY NOT ABOUT SUNDAY.
 *
 * The first run of this fixture carried "일요일은 쉰다." and `memory-goes-to-remember` — whose
 * whole instruction is "앞으로 기억해줘: 우리 가게는 일요일에 쉰다" — went 0/3. The model was
 * right: it already knew, and said so. The scenario was measuring the fixture, not the model.
 * Memories here must not answer any scenario's question.
 */
export const EVAL_MEMORIES = [
  "가게 이름은 '미소상회'다.",
  "택배는 우체국을 쓴다.",
];

/**
 * The system message for one scenario, exactly as the server's middleware would build it.
 *
 * `person` is the scenario's owner — their device's zone, their place — as the middleware attaches
 * it from the run and the account. Absent is somebody who has set nothing.
 */
export function systemMessageFor(
  mode: PromptMode = "chat",
  person?: PromptPerson,
  /**
   * When the epoch this message was frozen in began. `EVAL_NOW` for a conversation that starts
   * now; earlier for one whose layer is days old, where what changed since arrives as a reminder
   * on the person's message — which is how production sends a long-lived conversation.
   */
  frozenAt: Date = EVAL_NOW,
  /** The skills the Bot holds, listed the way the server lists them (`eval:browse` only). */
  skills?: readonly PromptSkill[],
  /** 수첩 as the frozen layer drew it. Absent is the pack's two ordinary memories. */
  notebook?: EvalNotebook,
  /**
   * The summary a day's close left at the end of the frozen layer, as the conversation store
   * appends it (`server/src/context/conversations.ts`). Absent is an epoch with no cut.
   */
  summary?: string,
) {
  const composed = composePrompt({
    mode,
    now: frozenAt,
    timeZone: EVAL_TIME_ZONE,
    bot: EVAL_BOT,
    standingRole: EVAL_STANDING_ROLE,
    ...notebookInput(notebook),
    ...(person ? { person } : {}),
    ...(skills ? { skills } : {}),
  });
  const earlier = summary
    ? earlierSummaryText(summary, factsFor(mode, person, frozenAt).day)
    : "";
  return {
    id: "laf-prompt:eval_bot",
    role: "system" as const,
    content: earlier ? `${composed}\n\n${earlier}` : composed,
  };
}

/** 수첩's lines as the server hands them to the composer (`agents/memory-store.ts`). */
export type EvalNotebook = {
  memories: readonly string[];
  confirmed?: readonly string[];
  superseded?: Readonly<Record<string, string>>;
};

function notebookInput(notebook: EvalNotebook | undefined) {
  return {
    memories: notebook?.memories ?? EVAL_MEMORIES,
    ...(notebook?.confirmed ? { confirmedMemories: notebook.confirmed } : {}),
    ...(notebook?.superseded
      ? { supersededMemories: notebook.superseded }
      : {}),
  };
}

/**
 * A person's message carrying what changed on 수첩 since the frozen layer, built by the same
 * `reminderLines` the conversation store uses — the words a Bot is actually shown.
 */
export function withNotebookReminder(
  content: string,
  from: EvalNotebook,
  to: EvalNotebook,
): string {
  return withReminder(
    content,
    reminderBlock(
      reminderLines(
        factsFor("chat", undefined, EVAL_NOW, from),
        factsFor("chat", undefined, EVAL_NOW, to),
      ),
    ),
  );
}

/** What the context layer says, for a person at a moment — what a reminder compares. */
export function factsFor(
  mode: PromptMode,
  person: PromptPerson | undefined,
  at: Date,
  notebook?: EvalNotebook,
) {
  return contextFactsFor({
    mode,
    now: at,
    timeZone: EVAL_TIME_ZONE,
    bot: EVAL_BOT,
    standingRole: EVAL_STANDING_ROLE,
    ...notebookInput(notebook),
    ...(person ? { person } : {}),
  });
}

/**
 * A person's message as production sends it after something changed mid-epoch: the words, then
 * the reminder the conversation store appends (`server/src/context/conversations.ts`), built by
 * the same functions — so the eval measures the words a Bot is actually shown.
 */
export function withReminderFor(
  content: string,
  from: { mode?: PromptMode; person?: PromptPerson; at: Date },
  to: { person?: PromptPerson; at: Date },
  extra: readonly string[] = [],
): string {
  const mode = from.mode ?? "chat";
  return withReminder(
    content,
    reminderBlock([
      ...reminderLines(
        factsFor(mode, from.person, from.at),
        factsFor(mode, to.person, to.at),
      ),
      ...extra,
    ]),
  );
}

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

/**
 * What a report records so two verdicts can be compared honestly.
 *
 * The SKELETON, not the composed message: the date line and this Bot's memories change between
 * runs, and a hash that changed every minute could not answer "was that verdict about this
 * prompt". The eval-pack rule that a prompt edit inside a verdict starts a NEW verdict is only
 * enforceable because these two numbers are in the report.
 */
export const PROMPT_HASH = sha256(
  (["chat", "routine"] as const)
    .map((mode) => promptSkeleton(mode))
    .join("\n\n---\n\n"),
);

/*
 * The bridge tools are in the hash because they are schema the model reads: a change to how
 * `tool_search` describes itself is a change to what is being measured, exactly like a change to
 * `remember`'s description.
 */
export const CATALOGUE_HASH = sha256(
  JSON.stringify([...COMPUTER_TOOLS, ...SELF_TOOLS, ...BRIDGE_TOOLS, NOW_TOOL]),
);
