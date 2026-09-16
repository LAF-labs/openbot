import type {
  CallPreview,
  CallPreviewEntry,
  CallPreviewField,
} from "../computer/approvals";

/**
 * The pieces an adapter builds its {@link CallPreview} from, cut the same way everywhere.
 *
 * WHY THE BOUNDS ARE HERE AND NOT IN EACH ADAPTER. A preview travels in a 409 body, on a room
 * frame and in the list a card polls, and it is drawn inside a transcript line. Five adapters each
 * choosing how much of a mail to carry would be five answers to one question, and the one that
 * forgot would put a whole mailbox thread on a card. So an adapter says WHICH value is which fact,
 * and this says how much of it travels.
 *
 * PURE: the arguments in, facts out. Nothing here may read a row, an environment or a vendor — a
 * preview is built before anybody has agreed to anything.
 */

/** Addresses or numbers shown before the card says how many more there are. */
export const PREVIEW_LIST_ITEMS = 10;

/** One line: a subject, a title, an order number, one address. */
export const PREVIEW_VALUE_CHARS = 200;

/**
 * The words that leave. A thousand characters holds an 알림톡 whole — the longest customer template
 * in `alimtalk/templates.ts` is 77 characters with its blanks still empty — and most replies and
 * short mails; past it the card says the rest is not shown rather than showing a fragment as if it
 * were everything.
 */
export const PREVIEW_TEXT_CHARS = 1_000;

/**
 * A value cut to `limit` characters, counted the way a person counts them.
 *
 * By code point, not by UTF-16 unit: a cut through the middle of an emoji leaves half a surrogate
 * pair, which renders as a replacement character on the one card that exists to be read closely.
 */
function cutTo(value: string, limit: number): { value: string; cut: boolean } {
  const characters = [...value];
  return characters.length <= limit
    ? { value, cut: false }
    : { value: characters.slice(0, limit).join(""), cut: true };
}

/** One value, as a list of at most one entry, so an adapter can spread what it has. */
export function previewValue(
  field: CallPreviewField,
  value: string | null | undefined,
  limit: number = PREVIEW_VALUE_CHARS,
): CallPreviewEntry[] {
  // An absent field is not a fact about the call; a card line saying "제목:" and nothing would be.
  if (!value) return [];
  const shown = cutTo(value, limit);
  return [
    {
      field,
      values: [shown.value],
      ...(shown.cut ? { cut: true as const } : {}),
    },
  ];
}

/** The words a call sends, with the longer bound. */
export function previewText(
  field: CallPreviewField,
  value: string | null | undefined,
): CallPreviewEntry[] {
  return previewValue(field, value, PREVIEW_TEXT_CHARS);
}

/**
 * Several values — recipients, guests — the first few shown and the rest counted.
 *
 * Nothing is filtered here. The list is the one the adapter is about to send, cleaned by the
 * adapter itself; a preview that tidied it on the way would show a person a list the vendor
 * never receives.
 */
export function previewList(
  field: CallPreviewField,
  values: readonly string[],
): CallPreviewEntry[] {
  if (values.length === 0) return [];
  const shown = values
    .slice(0, PREVIEW_LIST_ITEMS)
    .map((value) => cutTo(value, PREVIEW_VALUE_CHARS));
  return [
    {
      field,
      values: shown.map((value) => value.value),
      ...(values.length > shown.length ? { total: values.length } : {}),
      ...(shown.some((value) => value.cut) ? { cut: true as const } : {}),
    },
  ];
}

/** Null rather than an empty preview: "nothing to show" and "shows nothing" are the same answer. */
export function previewOf(entries: CallPreviewEntry[]): CallPreview | null {
  return entries.length > 0 ? entries : null;
}
