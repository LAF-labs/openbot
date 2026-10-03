import type { ComponentProps } from "react";
import type { BrowsingCard } from "../../src/components/computer/browsing-card";

/**
 * A BROWSING CARD WITH THE TRANSCRIPT'S PART BESIDE IT: WHICH TASKS THE PERSON OPENED.
 *
 * A task that is over is one row, and whether it was opened is kept by whoever draws the
 * conversation, not by the card (`chat-transcript.tsx`, `isTaskUnfolded`). A test that mounts the
 * card alone has no such keeper, and a row handed a press that goes nowhere stays a row — so this
 * stands in for it, one task at a time, the way the transcript does it: the card says what was
 * pressed, and is told the answer.
 *
 * Imported lazily, as everything that renders is (`mount.tsx` says why).
 */
type FoldingCardProps = Omit<
  ComponentProps<typeof BrowsingCard>,
  "isUnfolded" | "onFold"
>;

export async function foldingCard() {
  const { useState } = await import("react");
  const { BrowsingCard: Card } = await import(
    "../../src/components/computer/browsing-card"
  );
  return function FoldingCard(props: FoldingCardProps) {
    const [isUnfolded, setIsUnfolded] = useState(false);
    return <Card {...props} isUnfolded={isUnfolded} onFold={setIsUnfolded} />;
  };
}

/**
 * The button a task that is over is folded and opened by: its row, or the head of its card. Told
 * from 한 일, the card's other disclosure, by what that one has and this has not — a list it names.
 */
export function foldOf(card: Element): HTMLButtonElement | null {
  return card.querySelector<HTMLButtonElement>(
    "button[aria-expanded]:not([aria-controls])",
  );
}
