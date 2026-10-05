/**
 * 목표 — A GOAL THE PERSON SET, REFINED IN THE ONE CONVERSATION AND TRACKED ON ITS OWN PAGE
 * (muse-shape plan §3.4, phase 9; D2 "its own small record, built last").
 *
 * WHY A RECORD OF ITS OWN. A routine is a schedule, not an outcome with a status; a 수첩 line has no
 * status and no progress. Bending either to carry "12월 토익 800, 지금 720, 조금 밀렸어요" would
 * make both lie about what they are.
 *
 * THE PERSON DECIDES. A goal is written only after the person pressed 예 on the card the Bot asked
 * with (`laf:goal_needs_yes`, `server/src/goals/tools.ts`) — enforced in code, never only in the
 * skill. Muse keeps goals its agent made up on its own ("tracking"); LAF does not: topics created by
 * the Bot are a recorded never (`one-bot-product-direction.md` §4).
 *
 * ONE LIST OF CATEGORIES FOR EVERYONE (`CATEGORIES` in `persona.ts`, plan §2.4): the persona orders
 * it and marks two, and hides none.
 *
 * IN `shared/` because the server refuses anything outside these words and the surface draws them.
 */
import { type Category, CATEGORIES } from "./persona";

export const GOAL_STATUSES = ["active", "done", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * HOW IT IS GOING, IN THREE WORDS — the idea taken from Muse's goals (teardown §4), said our way:
 * 잘 가고 있어요 · 조금 밀렸어요 · 늦어지고 있어요. The Bot sets it with each check-in, from what it
 * measured; the page shows it as a chip, cheaper to read than a timeline and fitting a phone. The
 * Bot's own sentence stays an entry's text, never the page's heading.
 */
export const MOMENTUMS = ["on_track", "at_risk", "behind"] as const;
export type Momentum = (typeof MOMENTUMS)[number];

export const ENTRY_KINDS = ["check_in", "note", "milestone"] as const;
export type GoalEntryKind = (typeof ENTRY_KINDS)[number];

/** Who wrote an entry: the Bot (from a run, or from what the person said in chat), or the person. */
export type GoalEntrySource = "bot" | "owner";

export const GOAL_TITLE_MAX = 80;
export const GOAL_TARGET_MAX = 200;
export const GOAL_UNIT_MAX = 20;
export const GOAL_ENTRY_MAX = 300;
/**
 * How many goals may be active at once. Enough for a life's worth of things being worked on; a
 * Bot asked to "make ten goals" is told the page is full rather than filling it.
 */
export const GOALS_ACTIVE_MAX = 20;

/** A number to watch: where it started, where it should get to, in what unit. All optional. */
export type GoalMeasure = { unit?: string; start?: number; goal?: number };

/**
 * A GOAL AND AN ENTRY ON THE WIRE, said once for both sides: what the server's store answers
 * (`server/src/goals/store.ts`) and what the page draws (`app/src/lib/goals/`). A VIEW, not the
 * row: the last entry, the count, the latest value and the linked routines are read beside it.
 */
export type GoalView = {
  id: string;
  agentId: string;
  category: Category;
  title: string;
  target: string;
  measure: GoalMeasure | null;
  dueOn: string | null;
  status: GoalStatus;
  momentum: Momentum | null;
  createdAt: string;
  updatedAt: string;
  lastEntryAt: string | null;
  entryCount: number;
  /** The last value logged, for a goal with a number to watch. */
  latestValue: number | null;
  /** The routines linked to it as its check-in (`laf_routines.goal_id`). */
  routines: { id: string; name: string }[];
};

export type GoalEntryView = {
  id: string;
  at: string;
  kind: GoalEntryKind;
  text: string;
  value: number | null;
  momentum: Momentum | null;
  source: GoalEntrySource;
  runId: string | null;
};

export const isGoalStatus = (value: unknown): value is GoalStatus =>
  typeof value === "string" &&
  (GOAL_STATUSES as readonly string[]).includes(value);

export const isMomentum = (value: unknown): value is Momentum =>
  typeof value === "string" && (MOMENTUMS as readonly string[]).includes(value);

export const isEntryKind = (value: unknown): value is GoalEntryKind =>
  typeof value === "string" &&
  (ENTRY_KINDS as readonly string[]).includes(value);

export const isCategory = (value: unknown): value is Category =>
  typeof value === "string" && CATEGORIES.some((one) => one.id === value);

/** `YYYY-MM-DD` that is a real calendar day, or null. */
export function dueOnOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const at = new Date(`${trimmed}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) &&
    at.toISOString().slice(0, 10) === trimmed
    ? trimmed
    : null;
}

/** A measure as a call carries it, or null when it names nothing usable. Refused, never guessed. */
export function measureOf(value: unknown): GoalMeasure | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return "invalid";
  const input = value as Record<string, unknown>;
  const measure: GoalMeasure = {};
  if (input.unit !== undefined) {
    if (typeof input.unit !== "string") return "invalid";
    const unit = input.unit.trim();
    if (unit.length > GOAL_UNIT_MAX) return "invalid";
    if (unit) measure.unit = unit;
  }
  for (const key of ["start", "goal"] as const) {
    if (input[key] === undefined || input[key] === null) continue;
    const number = Number(input[key]);
    if (!Number.isFinite(number)) return "invalid";
    measure[key] = number;
  }
  return Object.keys(measure).length > 0 ? measure : null;
}

/**
 * Words compared the way a person reads them: spaces, punctuation and case gone. The approval card
 * and the saved goal have to name the same thing, and a model that wrote "12월 토익 800점" on the
 * card and "12월 토익 800점!" in the call named the same thing.
 */
export function goalWords(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}
