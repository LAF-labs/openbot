import type { Tool } from "@ag-ui/client";
import {
  dueOnOf,
  GOAL_ENTRY_MAX,
  GOAL_TARGET_MAX,
  GOAL_TITLE_MAX,
  goalWords,
  isCategory,
  isEntryKind,
  isMomentum,
  measureOf,
} from "../../../shared/goals";
import { toolResultText } from "../../../shared/prompt/tool-results.ko";
import {
  GOAL_TOOLS,
  LIST_GOALS,
  LOG_PROGRESS,
  SAVE_GOAL,
  UPDATE_GOAL,
} from "../../../shared/tools/goals";
import type { ToolOutcome } from "../runner/turn-loop";
import type { UnattendedToolkit } from "../runner/unattended";
import {
  type GoalPatch,
  GoalNotFound,
  GoalsFull,
  type GoalStore,
  type GoalView,
} from "./store";

/**
 * 목표's four tools, carried out by this server (muse-shape plan §3.4, phase 9).
 *
 * BEHIND THE BRIDGE. Named `mcp__goals__…` so the bridge files them as deferred
 * (`shared/tools/goals.ts`): their names ride in the conversation's context layer and nothing rides
 * at the head of the prompt. A chat turn offers all four (`turns/chat-tools.ts`); a run of a routine
 * linked to a goal offers `log_progress` for that goal alone (`withGoal`, below); every other run
 * offers none.
 *
 * THE PERSON DECIDES, IN CODE. `save_goal` is refused — `laf:goal_needs_yes` — unless the turn holds
 * an askApproval card the person answered 예 on, not yet spent on another goal, whose words name
 * this goal's title. The turn starts at the person's message, so the yes came after it. A Bot that
 * saves without asking, saves one goal on another's yes, or saves twice on one yes is refused. Muse
 * lets its agent keep goals of its own ("tracking"); LAF does not.
 *
 * THE STATUS IS THE PERSON'S. No tool reaches 완료 or 그만두기: those are the page's buttons.
 */

type Store = Pick<
  GoalStore,
  "active" | "find" | "create" | "update" | "log" | "linkRoutine"
>;

/**
 * The yeses a turn has collected: every askApproval card the person answered 예 on, with the words
 * it showed them. Made once per turn; a yes is spent by the goal it named.
 */
export type GoalApprovals = {
  /** A card the person approved, as the Bot drew it. */
  approved(card: Record<string, unknown>): void;
  /** Spend the newest unspent yes whose card named `title`. False when there is none. */
  spend(title: string): boolean;
};

/**
 * THE CARD'S HEADLINE, NOT ANY WORD ON IT (2026-09-27 code sprint). A yes used to be matched by the
 * goal's title appearing anywhere in the card — title, summary, every detail — so a short title
 * ("운동") was covered by a yes to any card that mentioned it ("운동화 결제"). A yes now counts for
 * the goal named by the card's title or its summary — the two lines a person reads as what they are
 * agreeing to (the skill puts the goal's title in the title; a model may ask "이 목표로 할까요?" and
 * put it in the summary) — and only when the goal's words are that line, or most of it ("목표: 토익
 * 800점 넘기기" for "토익 800점 넘기기"). Details never carry a yes.
 */
const MOST_OF_THE_CARD = 0.6;

function matchesCard(cardTitle: string, wanted: string): boolean {
  if (!cardTitle || !wanted) return false;
  if (cardTitle === wanted) return true;
  return (
    cardTitle.includes(wanted) &&
    wanted.length >= cardTitle.length * MOST_OF_THE_CARD
  );
}

export function goalApprovals(): GoalApprovals {
  const yeses: { lines: string[]; spent: boolean }[] = [];
  const line = (value: unknown) =>
    typeof value === "string" ? goalWords(value) : "";
  return {
    approved(card) {
      yeses.push({
        lines: [line(card.title), line(card.summary)],
        spent: false,
      });
    },
    spend(title) {
      const wanted = goalWords(title);
      if (!wanted) return false;
      for (let index = yeses.length - 1; index >= 0; index -= 1) {
        const yes = yeses[index];
        if (
          yes &&
          !yes.spent &&
          yes.lines.some((shown) => matchesCard(shown, wanted))
        ) {
          yes.spent = true;
          return true;
        }
      }
      return false;
    },
  };
}

const refused = (
  code: string,
  facts: Record<string, unknown> = {},
): ToolOutcome => ({ ok: false, code, reason: toolResultText(code), ...facts });

const invalid = (field: string) => refused("laf:goal_invalid", { field });

const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

/** A goal as the model reads it back: the facts, no bookkeeping. */
const forModel = (goal: GoalView) => ({
  id: goal.id,
  category: goal.category,
  title: goal.title,
  target: goal.target,
  ...(goal.dueOn ? { dueOn: goal.dueOn } : {}),
  ...(goal.measure ? { measure: goal.measure } : {}),
  ...(goal.momentum ? { momentum: goal.momentum } : {}),
  ...(goal.latestValue !== null ? { latestValue: goal.latestValue } : {}),
  ...(goal.routines.length
    ? { routines: goal.routines.map((one) => one.name) }
    : {}),
});

const TOOLS: Tool[] = GOAL_TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
}));

export type GoalToolkit = {
  tools: Tool[];
  execute(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
};

/**
 * The four tools for one turn of one Bot for one person. `approvals` is the turn's; without it
 * nothing can be saved, which is what a run nobody is watching gets.
 */
export function goalTools(input: {
  store: Store;
  userId: string;
  agentId: string;
  /** The chat turn or routine run the entries are filed under. */
  runId: string;
  approvals?: GoalApprovals;
}): GoalToolkit {
  const { store, userId, agentId } = input;

  const notFound = async () =>
    refused("laf:goal_not_found", {
      goals: (await store.active(userId, agentId)).map((goal) => ({
        id: goal.id,
        title: goal.title,
      })),
    });

  const save = async (args: Record<string, unknown>): Promise<ToolOutcome> => {
    if (!isCategory(args.category)) return invalid("category");
    const title = text(args.title);
    const target = text(args.target);
    if (!title || title.length > GOAL_TITLE_MAX) return invalid("title");
    if (!target || target.length > GOAL_TARGET_MAX) return invalid("target");
    const dueOn =
      args.dueOn === undefined || args.dueOn === null || args.dueOn === ""
        ? null
        : dueOnOf(args.dueOn);
    if (dueOn === null && args.dueOn && args.dueOn !== "") {
      return invalid("dueOn");
    }
    const measure = measureOf(args.measure);
    if (measure === "invalid") return invalid("measure");
    // Checked last, so a malformed call is told what is malformed and does not spend the yes.
    if (!input.approvals?.spend(title)) return refused("laf:goal_needs_yes");
    try {
      const goal = await store.create({
        userId,
        agentId,
        category: args.category,
        title,
        target,
        measure,
        dueOn,
      });
      return {
        ok: true,
        code: "laf:goal_saved",
        goal: forModel(goal),
        reason: toolResultText("laf:goal_saved"),
      };
    } catch (error) {
      if (error instanceof GoalsFull) return refused(error.code);
      throw error;
    }
  };

  const update = async (
    args: Record<string, unknown>,
  ): Promise<ToolOutcome> => {
    const found = await store.find(userId, agentId, text(args.goal));
    if (!found) return notFound();
    const patch: GoalPatch = {};
    if (args.title !== undefined) {
      const title = text(args.title);
      if (!title || title.length > GOAL_TITLE_MAX) return invalid("title");
      patch.title = title;
    }
    if (args.target !== undefined) {
      const target = text(args.target);
      if (!target || target.length > GOAL_TARGET_MAX) return invalid("target");
      patch.target = target;
    }
    if (args.dueOn !== undefined) {
      if (args.dueOn === null || args.dueOn === "") patch.dueOn = null;
      else {
        const dueOn = dueOnOf(args.dueOn);
        if (!dueOn) return invalid("dueOn");
        patch.dueOn = dueOn;
      }
    }
    if (args.measure !== undefined) {
      const measure = measureOf(args.measure);
      if (measure === "invalid") return invalid("measure");
      patch.measure = measure;
    }
    let linked: { id: string; name: string } | null = null;
    const routine = text(args.routine);
    if (routine) {
      const link = await store.linkRoutine({
        agentId,
        goalId: found.id,
        routineName: routine,
      });
      if ("names" in link) {
        return refused("laf:goal_routine_not_found", { routines: link.names });
      }
      linked = link;
    }
    const goal = await store.update({ userId, agentId, id: found.id, patch });
    return {
      ok: true,
      code: "laf:goal_updated",
      goal: forModel(goal),
      ...(linked ? { routine: linked.name } : {}),
      reason: toolResultText("laf:goal_updated"),
    };
  };

  const log = async (args: Record<string, unknown>): Promise<ToolOutcome> => {
    const found = await store.find(userId, agentId, text(args.goal));
    if (!found) return notFound();
    const said = text(args.text);
    if (!said || said.length > GOAL_ENTRY_MAX) return invalid("text");
    let value: number | null = null;
    if (args.value !== undefined && args.value !== null && args.value !== "") {
      value = Number(args.value);
      if (!Number.isFinite(value)) return invalid("value");
    }
    if (args.momentum !== undefined && !isMomentum(args.momentum)) {
      return invalid("momentum");
    }
    if (args.kind !== undefined && !isEntryKind(args.kind)) {
      return invalid("kind");
    }
    try {
      const { goal } = await store.log({
        userId,
        agentId,
        goalId: found.id,
        kind: isEntryKind(args.kind) ? args.kind : "check_in",
        text: said,
        value,
        momentum: isMomentum(args.momentum) ? args.momentum : null,
        source: "bot",
        runId: input.runId,
      });
      return {
        ok: true,
        code: "laf:goal_logged",
        goal: forModel(goal),
        reason: toolResultText("laf:goal_logged"),
      };
    } catch (error) {
      if (error instanceof GoalNotFound) return notFound();
      throw error;
    }
  };

  return {
    tools: TOOLS,
    async execute(name, args) {
      switch (name) {
        case SAVE_GOAL:
          return save(args);
        case UPDATE_GOAL:
          return update(args);
        case LOG_PROGRESS:
          return log(args);
        case LIST_GOALS:
          return {
            ok: true,
            goals: (await store.active(userId, agentId)).map(forModel),
          };
        default:
          return refused("laf:tool_unknown");
      }
    },
  };
}

/**
 * A run of a routine linked to a goal: `log_progress` beside its tools, for that goal alone —
 * whatever id the model names, the entry goes on the goal this routine checks. Every other run is
 * handed the toolkit without it.
 */
export function withGoal(
  toolkit: UnattendedToolkit,
  input: {
    store: Store;
    userId: string;
    agentId: string;
    runId: string;
    goalId: string;
  },
): UnattendedToolkit {
  const goals = goalTools({
    store: input.store,
    userId: input.userId,
    agentId: input.agentId,
    runId: input.runId,
  });
  const offered = goals.tools.find((tool) => tool.name === LOG_PROGRESS);
  return {
    tools: offered ? [...toolkit.tools, offered] : toolkit.tools,
    execute: async (name, args, call) =>
      name === LOG_PROGRESS
        ? goals.execute(name, { ...args, goal: input.goalId })
        : toolkit.execute(name, args, call),
  };
}
