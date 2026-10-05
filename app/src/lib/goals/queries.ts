import type {
  GoalEntryView,
  GoalStatus,
  GoalView,
  Momentum,
} from "@shared/goals";
import { CATEGORIES, type Category } from "@shared/persona";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { josa } from "@/lib/josa";
import { requestOrRefusal } from "@/lib/refusals";

/**
 * 목표 on the wire, and what the page says (muse-shape plan §3.4, phase 9).
 *
 * The server answers goals and their timelines as facts (`server/src/goals/`); every word the page
 * draws is this module's or the component's, through `t()`. A goal's title, target and entries are
 * the person's and the Bot's own words from the conversation — the same standing as its answers.
 */

export type GoalsAnswer = { goals: GoalView[]; active: number };
export type GoalDetail = { goal: GoalView; entries: GoalEntryView[] };

export const goalKeys = {
  all: ["goals"] as const,
  list: ["goals", "list"] as const,
  one: (id: string) => ["goals", "one", id] as const,
};

/** The refusals the doors answer with, as the codes they send. */
export const GOAL_REFUSALS: Readonly<Record<string, string>> = {
  "laf:goal_not_found": "That goal is no longer there.",
  "laf:goal_invalid": "That did not go through. Try again.",
};

/**
 * HOW IT IS GOING, IN OUR WORDS (teardown §4's three states): the chip on a goal. English keys,
 * walked by `app/tests/goals.test.ts`.
 */
export const MOMENTUM_LABELS: Readonly<Record<Momentum, string>> = {
  on_track: "On track",
  at_risk: "Slipping a little",
  behind: "Falling behind",
};

export const STATUS_LABELS: Readonly<Record<GoalStatus, string>> = {
  active: "In progress",
  done: "Done",
  dropped: "Gave up",
};

const goalRequest = (path: string, init?: RequestInit) =>
  requestOrRefusal(path, init, GOAL_REFUSALS);

/**
 * Every goal, and how many are active. Read again whenever the window comes forward: a goal is made
 * in the conversation, and the page should have it when the person comes back to it.
 */
export function goalsQueryOptions() {
  return queryOptions({
    queryKey: goalKeys.list,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    queryFn: async () =>
      (await goalRequest("/api/goals")) as unknown as GoalsAnswer,
  });
}

export function goalQueryOptions(id: string) {
  return queryOptions({
    queryKey: goalKeys.one(id),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    queryFn: async () =>
      (await goalRequest(
        `/api/goals/${encodeURIComponent(id)}`,
      )) as unknown as GoalDetail,
  });
}

export async function setGoalStatus(
  queryClient: QueryClient,
  id: string,
  status: GoalStatus,
): Promise<void> {
  await goalRequest(`/api/goals/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
  await queryClient.invalidateQueries({ queryKey: goalKeys.all });
}

export async function removeGoal(
  queryClient: QueryClient,
  id: string,
): Promise<void> {
  await goalRequest(`/api/goals/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  queryClient.removeQueries({ queryKey: goalKeys.one(id) });
  await queryClient.invalidateQueries({ queryKey: goalKeys.list });
}

/** A category's name in the person's language. */
export function categoryName(category: Category): string {
  const known = CATEGORIES.find((one) => one.id === category);
  return known ? t(known.name) : category;
}

/**
 * What [대화에서 시작] sends as the person's message: "공부·성장 목표를 같이 세워 줘". Korean
 * through `t()` — Muse sends an English category word even in Korean (teardown §4).
 */
export function goalStartSentence(category: Category): string {
  return t("Help me set a goal for {category}", {
    category: categoryName(category),
  });
}

/** 대화에서 바꾸기: "'12월 토익 800'을 이렇게 바꿔 줘: ", for the person to finish. */
export function goalEditDraft(title: string): string {
  return t("Change the goal “{title}” like this: ", {
    title,
    josa: josa(title, "을/를"),
  });
}

/** "720 → 800 점" when a goal watches a number; null when it does not. */
export function measureLine(goal: GoalView): string | null {
  const measure = goal.measure;
  if (!measure || measure.goal === undefined) return null;
  const now = goal.latestValue ?? measure.start;
  // Korean units sit on the number: 800점, 30개.
  const unit = measure.unit ?? "";
  return now === undefined || now === null
    ? t("Goal: {goal}{unit}", { goal: measure.goal, unit })
    : t("Now {now} · goal {goal}{unit}", { now, goal: measure.goal, unit });
}
