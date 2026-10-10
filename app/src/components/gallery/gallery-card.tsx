import type { z } from "zod";
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

/** The card and its checked arguments, or null: not a card drawn anywhere, or not its shape. */
export function cardToDraw(name: unknown, args: unknown): CardToDraw | null {
  if (typeof name !== "string") return null;
  const card = DRAWN.get(name);
  if (!card) return null;
  const checked = (card.parameters as z.ZodType).safeParse(args);
  if (!checked.success) return null;
  const props = checked.data;
  return props !== null && typeof props === "object"
    ? { Component: card.Component, props: props as Record<string, unknown> }
    : null;
}

export function GalleryCard({ card }: { card: CardToDraw }) {
  const { Component, props } = card;
  return <Component {...props} />;
}
