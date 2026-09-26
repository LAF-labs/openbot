/**
 * The mark left in a mail tool's result where a one-time code or an account link was taken out.
 *
 * TWO READERS, ONE MARK. The model reads it in the tool result, which is resent every turn for the
 * rest of the conversation — that is the whole reason the value itself is not there
 * (`server/src/plugins/mail-secrets.ts`). The surface reads it too, off the same result text, so the
 * control that shows the owner the value can be drawn on that call's line after a reload as well as
 * the moment the call returns: CopilotKit hands a finished tool call's renderer the result it stored,
 * and nothing else about the call survives the page.
 *
 * `[[withheld:code:Ab12Cd34Ef56]]` when a person is watching and the value was kept for them for a
 * while; `[[withheld:code]]` when nobody is (a routine), and the value was kept nowhere. Double square
 * brackets because markdown draws them as the characters they are and no mail writes them by accident
 * — and when a mail does, forging one, the id it names is looked up for the Bot and the person asking
 * and nobody else, so a forged mark is a button that finds nothing.
 */

/** What was taken out. The surface owns the words for each; these are facts. */
export const WITHHELD_KINDS = ["code", "reset_link", "login_link"] as const;

export type WithheldKind = (typeof WITHHELD_KINDS)[number];

/** A reference id: what `withheldMark` writes and the pattern below reads back. */
const ID = "[A-Za-z0-9_-]{8,32}";

/** Every mark in a text. Global, so it is always used through `matchAll` or `replace`. */
const MARK = new RegExp(
  `\\[\\[withheld:(${WITHHELD_KINDS.join("|")})(?::(${ID}))?\\]\\]`,
  "g",
);

/** The mark for one withheld value: with its reference when it was kept, without when it was not. */
export function withheldMark(kind: WithheldKind, id?: string | null): string {
  return id ? `[[withheld:${kind}:${id}]]` : `[[withheld:${kind}]]`;
}

export type WithheldMark = { kind: WithheldKind; id: string | null };

/**
 * The marks in a result, in order, each reference once.
 *
 * A value that appeared twice in a mail is one reference written twice, and the owner is offered it
 * once. Marks without a reference are kept — the surface says a code was there even when there is
 * nothing to show — but only one per kind, for the same reason.
 */
export function withheldMarksIn(text: string): WithheldMark[] {
  const seen = new Set<string>();
  const marks: WithheldMark[] = [];
  for (const match of text.matchAll(MARK)) {
    const kind = match[1] as WithheldKind;
    const id = match[2] ?? null;
    const key = id ?? `kind:${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    marks.push({ kind, id });
  }
  return marks;
}

/** The text with every mark replaced by what `say` writes for it. */
export function replaceWithheldMarks(
  text: string,
  say: (mark: WithheldMark) => string,
): string {
  return text.replace(MARK, (_whole, kind: string, id: string | undefined) =>
    say({ kind: kind as WithheldKind, id: id ?? null }),
  );
}
