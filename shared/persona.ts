/**
 * Who the person is, in one of four words: 학생 · 직장인 · 사장님 · 기타.
 *
 * The owner, 2026-09-27: "학생도 쓸 수 있어야해. 그러므로 처음에 학생/직장인/사장님/기타를 먼저 묻고
 * 시작한다. 빠르게 개인화할 수 있도록." — and, the same day: "학생이고 사장님이고간에 참고만 하는 거지
 * 메뉴체계가 바뀌어선 안 돼. 사장님도 학생이 쓰는 기능을 한번쯤은 쓸거란말이지."
 *
 * A HINT THAT ORDERS, NEVER A GATE. It decides which first chips lead, how the Bot addresses the
 * person and what it assumes when it has nothing else to go on
 * (`~/laf/docs/muse-shape-plan-2026-09-27.md` §2.3). It never hides a tab, a screen, a setting, a
 * skill or a tool, and nothing that decides whether an action stops reads it
 * (`server/tests/shop-boundary.test.ts`).
 *
 * WRITTEN BY A PERSON'S PRESS ONLY: the greeting's four rows and Settings, through
 * `PUT /api/me/persona` (`server/src/account/shop.ts`). No tool a Bot holds reaches it — the same
 * rule as the shop answers it sits beside, for the same reason: a Bot that could rewrite what it is
 * told about the person would be writing its own brief.
 *
 * IN `shared/` BECAUSE BOTH SIDES READ IT the same way: the server refuses anything outside the four
 * and tells every run the effective persona; the surface orders its chips by the same effective
 * persona. Two copies of `effectivePersona` would disagree about somebody who never answered.
 */
import type { ShopProfile } from "./shop/catalogue";

export const PERSONAS = ["student", "worker", "owner", "other"] as const;

export type Persona = (typeof PERSONAS)[number];

/** The refusal a malformed answer gets. A code: the surface owns the words. */
export const PERSONA_INVALID = "laf:persona_invalid";

export const isPersona = (value: unknown): value is Persona =>
  typeof value === "string" && (PERSONAS as readonly string[]).includes(value);

/**
 * `{ persona }` as a request carries it, or a refusal. Null is an answer too: "not answered", which
 * nothing on the surface sends today but a person clearing it would.
 */
export function parsePersonaAnswer(
  body: unknown,
): { ok: true; value: Persona | null } | { ok: false; code: string } {
  const refused = { ok: false, code: PERSONA_INVALID } as const;
  if (!body || typeof body !== "object" || Array.isArray(body)) return refused;
  const input = body as Record<string, unknown>;
  if (!("persona" in input)) return refused;
  const persona = input.persona;
  if (persona !== null && !isPersona(persona)) return refused;
  return { ok: true, value: persona };
}

/** The stored value, read back tolerantly: a word the list has since dropped reads as unanswered. */
export function personaFrom(value: unknown): Persona | null {
  return isPersona(value) ? value : null;
}

/**
 * The persona every reader acts on.
 *
 * NO BACKFILL, AND NO STORED GUESS. Somebody who answered the shop questions before the persona
 * question existed runs a business, so they read as 사장님 — computed here, on every read, and never
 * written. Somebody who answered neither is unknown, and every reader has an answer for unknown.
 */
export function effectivePersona(
  persona: Persona | null | undefined,
  shop: Pick<ShopProfile, "kind" | "places"> | undefined,
): Persona | null {
  if (persona) return persona;
  if (shop && (shop.kind !== null || shop.places.length > 0)) return "owner";
  return null;
}

/**
 * The follow-up for 학생: what they study. English keys, Korean in `app/src/lib/i18n-ko.ts`.
 *
 * It starts at 중·고등학생: sign-up is for 만 14세 이상 only, and nothing here may imply otherwise.
 */
export const STUDENT_STAGES = [
  { id: "school", name: "Middle or high school" },
  { id: "university", name: "University" },
  { id: "graduate", name: "Graduate school" },
  { id: "exam", name: "Preparing for an exam or a job" },
  { id: "other", name: "Something else" },
] as const;

/** The follow-up for 직장인: what kind of work. */
export const WORK_FIELDS = [
  { id: "office", name: "Office and planning" },
  { id: "sales", name: "Sales and marketing" },
  { id: "it", name: "Software and IT" },
  { id: "design", name: "Design and content" },
  { id: "education", name: "Teaching and research" },
  { id: "care", name: "Health and care" },
  { id: "field", name: "Production and field work" },
  { id: "other", name: "Something else" },
] as const;

/** How long the typed half of a follow-up may be. One line on 수첩, not a paragraph. */
export const FOLLOW_UP_MAX_LENGTH = 60;

/**
 * ONE LIST OF KINDS OF LIFE FOR EVERYONE: 일·가게 · 공부·성장 · 돈·세금 · 건강 · 관계 · 생활 · 기타
 * (muse-shape plan §2.4). The ideas are filed under these now, and the goals will be.
 *
 * One list rather than one per persona because a person's persona changes — a 학생 takes a job, a
 * 직장인 opens a shop — and what they asked for before should still be where it was. "일·가게" reads
 * right to a 사장님, to an office worker and to a student with a part-time job.
 */
export const CATEGORIES = [
  { id: "work", name: "Work and business" },
  { id: "study", name: "Study and growth" },
  { id: "money", name: "Money and tax" },
  { id: "health", name: "Health" },
  { id: "relationships", name: "People" },
  { id: "life", name: "Everyday life" },
  { id: "other", name: "Other" },
] as const;

export type Category = (typeof CATEGORIES)[number]["id"];

/** The two categories each persona sees first; the rest keep the list's own order. */
export const CATEGORY_LEAD: Readonly<Record<Persona, readonly Category[]>> = {
  owner: ["work", "money"],
  student: ["study", "money"],
  worker: ["work", "study"],
  other: ["life", "health"],
};

/**
 * The seven, in the order this person reads them. Every one is always there: the persona puts two
 * first and hides none. Unknown keeps the list's own order.
 */
export function categoryOrder(persona: Persona | null): Category[] {
  const lead = persona ? CATEGORY_LEAD[persona] : [];
  return [
    ...lead,
    ...CATEGORIES.map((category) => category.id).filter(
      (id) => !lead.includes(id),
    ),
  ];
}
