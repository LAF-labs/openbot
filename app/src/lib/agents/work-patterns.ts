/**
 * The eight kinds of work this product is for — the business plan's eight work patterns, not eight
 * kinds of software.
 *
 * A shop owner does not go looking for "communication"; they know they are short-staffed
 * overnight, or that they reconcile a card settlement every morning, or that reviews need
 * answering. Naming the pattern is what makes a suggestion recognisable as their own job rather
 * than as a feature. The first-task chips on a Bot's first conversation are dealt by it
 * (`first-tasks.ts`), and a place a person uses every day says which one it is
 * (`shared/shop/catalogue.ts`).
 *
 * It was `presets.ts`, and held thirty-two ready-made Bots — a name, a job title and a standing
 * instruction each — for a row of "kinds of work" on a new Bot's card. That card and those presets
 * were removed on 2026-09-24: a person has one Bot, its profile is a name and a face, and what it
 * does is settled by talking to it (docs/laf/deployment-model.md, "봇은 하나다").
 */

import {
  type BusinessKindId,
  dailyPlaceById,
  type ShopProfile,
} from "@shared/shop/catalogue";

/** The eight patterns, as the plan names them. */
export type WorkPatternId =
  | "night-watch"
  | "approval"
  | "settlement"
  | "enquiries"
  | "schedule"
  | "stock"
  | "reputation"
  | "paperwork";

export type WorkPattern = {
  id: WorkPatternId;
  /** What this kind of work is called on the card. */
  name: string;
  /**
   * What this pattern usually leans on, in the four words the product owns.
   *
   * Not a promise and not a setting — a Bot reaches whatever it is given. It answers the question
   * somebody actually asks in front of these cards: "what would it be using to do that?"
   */
  connection: string;
};

export const WORK_PATTERNS: readonly WorkPattern[] = [
  { id: "night-watch", name: "Night watch", connection: "Browser" },
  { id: "approval", name: "Approval helper", connection: "Email" },
  {
    id: "settlement",
    name: "Settlement and reconciliation",
    connection: "Sheets",
  },
  { id: "enquiries", name: "Enquiry replies", connection: "Email" },
  {
    id: "schedule",
    name: "Bookings and schedule",
    connection: "Connected apps",
  },
  { id: "stock", name: "Stock and ordering", connection: "Sheets" },
  { id: "reputation", name: "Reviews and reputation", connection: "Browser" },
  {
    id: "paperwork",
    name: "Receipts and paperwork",
    connection: "Connected apps",
  },
] as const;

/**
 * Which kinds of work each trade leads with, likeliest first (`shared/shop/catalogue.ts`).
 *
 * It was derived from thirty-two presets reordered per trade — a restaurant's settlement card was
 * the platform payouts, a salon's schedule card the booking desk — for the row of kinds of work on
 * a new Bot's card. The presets went with that card on 2026-09-24 (a Bot's profile is its name and
 * face); what the first-task chips needed from them was only this order, written down as it was.
 *
 * 그 밖에 names none: the person told us their trade is not one of these, and a guess on their
 * behalf would be a worse order than no preference at all.
 */
export const KIND_PATTERNS: Readonly<
  Record<BusinessKindId, readonly WorkPatternId[]>
> = {
  food: [
    "reputation",
    "settlement",
    "stock",
    "schedule",
    "enquiries",
    "night-watch",
    "paperwork",
    "approval",
  ],
  online: [
    "enquiries",
    "stock",
    "settlement",
    "reputation",
    "night-watch",
    "approval",
    "paperwork",
  ],
  store: [
    "stock",
    "settlement",
    "reputation",
    "enquiries",
    "schedule",
    "paperwork",
  ],
  beauty: ["schedule", "reputation", "enquiries", "settlement", "stock"],
  education: [
    "enquiries",
    "approval",
    "schedule",
    "settlement",
    "reputation",
    "night-watch",
  ],
  health: [
    "schedule",
    "reputation",
    "enquiries",
    "night-watch",
    "paperwork",
    "stock",
  ],
  office: [
    "approval",
    "schedule",
    "paperwork",
    "enquiries",
    "settlement",
    "night-watch",
  ],
  other: [],
};

/**
 * The shop answers as an order of work: kinds of work, most wanted first. Everything not here keeps
 * its place after them.
 *
 * THE PLACES LEAD, THEN THE TRADE. "I am on 배민 every morning" is a more exact statement than "I
 * run a restaurant", so the kinds of work of the places picked — in the order they were picked —
 * come first, and the trade's own list fills in behind them. An answer with nothing in it says
 * nothing.
 */
export function shopPatternOrder(shop: ShopProfile): WorkPatternId[] {
  const patterns: WorkPatternId[] = [];
  const add = (pattern: WorkPatternId | undefined) => {
    if (pattern && !patterns.includes(pattern)) patterns.push(pattern);
  };
  for (const id of shop.places) add(dailyPlaceById(id)?.pattern);
  for (const pattern of shop.kind ? KIND_PATTERNS[shop.kind] : []) {
    add(pattern);
  }
  return patterns;
}
