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
  DEFAULT_TIME_ZONE,
  type PromptMode,
  promptSkeleton,
} from "../shared/prompt";
import { BRIDGE_TOOLS } from "../shared/tools/bridge";
import { COMPUTER_TOOLS } from "../shared/tools/computer";
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
  title: "가게 운영 도우미",
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

/** The system message for one scenario, exactly as the server's middleware would build it. */
export function systemMessageFor(mode: PromptMode = "chat") {
  return {
    id: "laf-prompt:eval_bot",
    role: "system" as const,
    content: composePrompt({
      mode,
      now: EVAL_NOW,
      timeZone: EVAL_TIME_ZONE,
      bot: EVAL_BOT,
      standingRole: EVAL_STANDING_ROLE,
      memories: EVAL_MEMORIES,
    }),
  };
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
  (["chat", "room", "routine", "coworker"] as const)
    .map((mode) => promptSkeleton(mode, EVAL_BOT.name))
    .join("\n\n---\n\n"),
);

/*
 * The bridge tools are in the hash because they are schema the model reads: a change to how
 * `tool_search` describes itself is a change to what is being measured, exactly like a change to
 * `remember`'s description.
 */
export const CATALOGUE_HASH = sha256(
  JSON.stringify([...COMPUTER_TOOLS, ...SELF_TOOLS, ...BRIDGE_TOOLS]),
);
