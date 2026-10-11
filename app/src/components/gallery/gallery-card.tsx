import { z } from "zod";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { GALLERY as CARDS } from "./cards";
import { GALLERY as CHARTS } from "./charts";
import { GALLERY as QUOTES } from "./quote";

/**
 * A GALLERY CARD, DRAWN WHERE THERE IS NO CONVERSATION (2026-10-10, record §2, piece 7-1).
 *
 * Until now a card was drawn in one place and by one hand: the Bot's runtime registered each as a
 * tool and drew it when the Bot called it (`lib/copilot/gallery-tools.tsx`). 홈 is not a
 * conversation, and the panels a person will ask for (§2) are these same cards composed — so the
 * drawing is here, apart from the calling: a name and what it was called with, and nothing of the
 * runtime.
 *
 * NAMED ONE BY ONE, NOT FOUND. The registry finds every gallery file through Vite, and among them
 * are the cards that ask (a question needs somebody to answer to), the one that reads the
 * deployment's data (which is granted before it is read), and the file and connection cards, which
 * act. Importing the registry here would put all of that — and whatever it reaches — on the first
 * screen (`vite.config.ts` refuses a bundle whose first screen reaches the runtime). What can be
 * drawn anywhere is what only shows: the cards, the charts, the quote.
 *
 * WHAT IT WAS CALLED WITH IS CHECKED AGAINST THE CARD'S OWN SCHEMA, as the runtime checks a call
 * before drawing it. The arguments come from a stored conversation — a card from before a schema
 * changed, or anything at all — and a card handed the wrong shape throws while drawing.
 *
 * THE BOT'S GRANT IS NOT ASKED AGAIN. In a conversation a card the Bot no longer holds is drawn as
 * a refusal, by grants the window polls. This draws only what the server lists as having reached
 * this person's screen (`server/src/agents/made.ts`): nothing is shown that was not shown, and
 * the poll that would be needed runs on every screen for the life of the window.
 */
const DRAWN: ReadonlyMap<string, GalleryComponent> = new Map(
  [...CARDS, ...CHARTS, ...QUOTES]
    .filter((card) => card.kind !== "decision" && card.reads === undefined)
    .map((card) => [card.name, card]),
);

/** The names this can draw: for a test, and for whoever needs to know before asking. */
export const DRAWABLE_ANYWHERE: readonly string[] = [...DRAWN.keys()].sort();

export type CardToDraw = {
  Component: GalleryComponent["Component"];
  props: Record<string, unknown>;
};

/**
 * WHAT A CALL WAS MADE WITH, CHECKED AGAINST THE CARD'S OWN SCHEMA, or null where it is not the
 * card's shape. 홈's gate (`cardToDraw`): what is drawn there is drawn on every screen for the life
 * of the window with a line to stand in for it, so it is drawn only when the schema vouches for it.
 */
export function argsToDraw(
  card: Pick<GalleryComponent, "parameters">,
  args: unknown,
): Record<string, unknown> | null {
  const checked = (card.parameters as z.ZodType).safeParse(args);
  if (!checked.success) return null;
  const props = checked.data;
  return props !== null && typeof props === "object"
    ? (props as Record<string, unknown>)
    : null;
}

/**
 * WHETHER A CALL'S ARGUMENTS HOLD ANYTHING A CARD CAN SHOW: the conversation's gate, asked once a
 * call is complete (`CardCall`, `lib/copilot/gallery-tools.tsx`). An object, with at least one of
 * the fields the card's schema names holding something — a word, a figure, a flag, or a row that
 * itself holds one (`metrics: [{}]` is a frame around nothing, as `{}` is).
 *
 * NOT THE SCHEMA, ON PURPOSE. The schema is what the Bot is told to write and carries bounds the
 * renderers do not need: a seventh figure (`metrics.max(6)`) is drawn, a tone outside the four is a
 * plain badge, a record with a title and a status and no `fields` is a record, a checklist item
 * with no `done` is an open item, a chart point written as "12" is a bar. Every renderer takes a
 * partial shape, because every card is drawn from a partial parse while it streams (#179) — and a
 * card the person watched grow on screen, taken away the moment the result lands because the
 * Bot wrote seven figures, is the regression the first cut of this gate made (review of #189).
 *
 * WHAT IT REFUSES is the case the gate exists for (2026-10-11): a call that arrived as `{}`, was
 * answered "on screen" by a runtime that checks nothing, and stood in the conversation for the rest
 * of its life as an empty rounded frame — above the Bot's own words that it was trying again and the
 * real card under them. Nothing in it, nothing drawn; the Bot's words say what happened.
 *
 * DIFFERENT FROM 홈'S GATE, AND WHY. 홈 draws the newest made thing on every screen, with a line
 * that names it standing in where the card is refused, and it never drew the card first: refusing
 * a seventh figure there costs a line in place of a card. The conversation has no line — the Bot's
 * words are the stand-in — and the card was already on the screen while it was written: refusing
 * it there costs a card the person was reading. The ranges a card's data may fall outside of are
 * the renderers' to survive in the conversation (`server-run-step-line.test.tsx` holds them to
 * that); 홈 never hands them over (`home-cards.test.ts`).
 */
export function holdsSomethingToDraw(
  card: Pick<GalleryComponent, "parameters">,
  args: unknown,
): args is Record<string, unknown> {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return false;
  }
  const given = args as Record<string, unknown>;
  // The fields the card shows, by the schema the Bot was told to write; any field where the schema
  // is not an object of named fields (none of the gallery's is not).
  const schema: unknown = card.parameters;
  const named =
    schema instanceof z.ZodObject
      ? Object.keys(schema.shape)
      : Object.keys(given);
  return named.some(
    (key) => Object.hasOwn(given, key) && holdsSomething(given[key]),
  );
}

/**
 * A value with something in it: not blank, not a number that is no number — and a list or an object
 * only when something inside it is.
 */
function holdsSomething(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(holdsSomething);
  if (typeof value === "object") {
    return Object.values(value).some(holdsSomething);
  }
  return false;
}

/** The card and its checked arguments, or null: not a card drawn anywhere, or not its shape. */
export function cardToDraw(name: unknown, args: unknown): CardToDraw | null {
  if (typeof name !== "string") return null;
  const card = DRAWN.get(name);
  if (!card) return null;
  const props = argsToDraw(card, args);
  return props ? { Component: card.Component, props } : null;
}

export function GalleryCard({ card }: { card: CardToDraw }) {
  const { Component, props } = card;
  return <Component {...props} />;
}
