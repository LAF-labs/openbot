/**
 * A CARD THAT ASKS A PERSON FOR VALUES THE BOT MUST NOT BE TOLD: which boxes, and what to call each.
 *
 * Written down once because four programs read it and must agree: the tool the model calls
 * (`shared/tools/computer.ts`), the server that judges the request and holds what it judged
 * (`server/src/computer/gateway/secrets.ts`), the computer that keeps the ask and puts the values
 * in (`agent-computer/src/control.ts`), and the card a person types into
 * (`app/src/components/computer/help-card.tsx`).
 *
 * ONE CARD, SEVERAL BOXES (2026-10-10, record §6). The tool took one box, and a sign-in was two
 * cards a person answered one after the other — the Bot waiting on each, and looking at the page
 * again in between. A card holds every box of one form now, and a person answers once.
 */

/** One box of the card: the field it goes in, as a ref of the snapshot, and what the Bot calls it. */
export type SecretField = { ref: string; label: string };

/**
 * How many boxes one card may hold. A sign-in is two and changing a password is three; a form
 * with more than this is asked about in parts, and a model that lists a page's every input is
 * told so before a person is shown a wall of masked boxes.
 */
export const SECRET_FIELDS_MAX = 6;

/** What a box is called when the Bot gave it no name of its own. */
const UNNAMED = "the value this page is asking for";

/** One line, bounded: it is drawn above a masked box and written into the trail. */
export const SECRET_LABEL_MAX = 120;

function labelOf(value: unknown): string {
  const said =
    typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (said || UNNAMED).slice(0, SECRET_LABEL_MAX);
}

/**
 * The boxes a request names, read from either shape it has been written in: `fields`, or the one
 * `label` and `ref` the tool took until 2026-10-10 — which a conversation from before that still
 * holds in its history, and a model reading it may write again.
 *
 * `null` WHEN IT NAMES NO BOX, TOO MANY, OR THE SAME BOX TWICE. Two values for one field is not
 * something a person can answer: the second replaces the first, and which of their two passwords
 * a page ends up holding would be an accident of order.
 */
export function secretFieldsOf(
  args: { fields?: unknown; ref?: unknown; label?: unknown } | null | undefined,
): SecretField[] | null {
  if (!args) return null;
  const listed = Array.isArray(args.fields)
    ? args.fields
    : args.fields === undefined && args.ref !== undefined
      ? [{ ref: args.ref, label: args.label }]
      : null;
  if (!listed || listed.length === 0 || listed.length > SECRET_FIELDS_MAX) {
    return null;
  }
  const fields: SecretField[] = [];
  for (const entry of listed) {
    if (!entry || typeof entry !== "object") return null;
    const { ref, label } = entry as { ref?: unknown; label?: unknown };
    if (typeof ref !== "string" || !ref.trim()) return null;
    if (fields.some((field) => field.ref === ref.trim())) return null;
    fields.push({ ref: ref.trim(), label: labelOf(label) });
  }
  return fields;
}

/** What the whole card is called where one line has to stand for it: its boxes' names, in order. */
export function secretAskName(fields: readonly { label: string }[]): string {
  return fields.map((field) => field.label).join(", ");
}

/**
 * Whether two asks are the same ask: the same boxes in the same order, made with the same
 * snapshot. What a value says it answers, what a server takes back, and what a card looks for when
 * it is drawn again are all this, so that none of them is a comparison of labels a model wrote.
 */
export function isSameAsk(
  one: { refs: readonly string[]; snapshotId?: number | undefined },
  other: { refs: readonly string[]; snapshotId?: number | undefined },
): boolean {
  return (
    one.snapshotId === other.snapshotId &&
    one.refs.length === other.refs.length &&
    one.refs.every((ref, index) => ref === other.refs[index])
  );
}
