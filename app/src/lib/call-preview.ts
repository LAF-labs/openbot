/**
 * What an outward call will send, from the browser's side: reading it off the wire, and the words a
 * card puts around it.
 *
 * Measured 2026-09-16 (audit R4-01): an 알림톡, a mail, an invitation, a review reply and an order
 * status change each stopped on a card naming only the tool, so a person approved a send without
 * seeing who it went to or what it said. The server now puts a bounded preview beside the question
 * — facts only, cut to size (`server/src/plugins/call-preview.ts`) — and this module turns those
 * facts into labelled lines. The server sends facts; the surface owns the words.
 *
 * Every label is a `t()` call on a string literal, in a switch, rather than a table read through
 * a variable, so `i18n-coverage.test.ts` and `owner-vocabulary.test.ts` both see each one without
 * a list of their own. A field added to the type below is a typecheck error in `labelOf` until
 * somebody names it; one the server adds without this file is dropped by `callPreviewOf` rather
 * than drawn unlabelled, and `approval-preview.test.ts` reads the server's list to catch that.
 */
import { t } from "@/lib/i18n";

/** Mirrors `CallPreviewField` in `server/src/computer/approvals.ts`. */
export type CallPreviewField =
  | "recipients"
  | "attendees"
  | "subject"
  | "title"
  | "starts"
  | "ends"
  | "location"
  | "template"
  | "text"
  | "review"
  | "order"
  | "status";

export type CallPreviewEntry = {
  field: CallPreviewField;
  values: string[];
  /** How many values the call carried, when more than are shown. */
  total?: number;
  /** The server cut a value short. */
  cut?: true;
};

export type CallPreview = CallPreviewEntry[];

/**
 * The order the lines are drawn in, whatever order the facts arrived in: who it reaches first,
 * what it is called, when and where, and the words it says last — they are the longest.
 */
const FIELD_ORDER = [
  "recipients",
  "attendees",
  "subject",
  "title",
  "starts",
  "ends",
  "location",
  "template",
  "order",
  "status",
  "review",
  "text",
] as const satisfies readonly CallPreviewField[];

const FIELDS = new Set<string>(FIELD_ORDER);

/**
 * Bounds for what this surface will hold, whatever arrived.
 *
 * The server's own bounds are tighter (`server/src/plugins/call-preview.ts`); these exist so a
 * frame from somewhere else cannot put a megabyte on a card.
 */
const MAX_VALUES = 20;
const MAX_VALUE_CHARS = 2_000;

/**
 * The preview out of a reply or a frame, or undefined when there is nothing this surface can
 * vouch for.
 *
 * Entry by entry: a field it has no word for, a value that is not a string or a list that is not a
 * list is dropped, and the rest is drawn. A card is no worse for a line it could not read, and
 * every line it does draw says what it is.
 */
export function callPreviewOf(value: unknown): CallPreview | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: CallPreview = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { field, values, total, cut } = item as Record<string, unknown>;
    if (typeof field !== "string" || !FIELDS.has(field) || seen.has(field)) {
      continue;
    }
    if (!Array.isArray(values)) continue;
    const strings = values
      .filter((one): one is string => typeof one === "string")
      .slice(0, MAX_VALUES)
      .map((one) => one.slice(0, MAX_VALUE_CHARS));
    if (strings.length === 0) continue;
    seen.add(field);
    entries.push({
      field: field as CallPreviewField,
      values: strings,
      ...(typeof total === "number" &&
      Number.isInteger(total) &&
      total > strings.length
        ? { total }
        : {}),
      ...(cut === true ? { cut: true as const } : {}),
    });
  }
  return entries.length > 0 ? entries : undefined;
}

/** One line of the card: what it is, what the call carries, and what is not shown of it. */
export type PreviewLine = {
  field: CallPreviewField;
  label: string;
  value: string;
  note?: string;
};

function labelOf(field: CallPreviewField): string {
  switch (field) {
    case "recipients":
      return t("To");
    case "attendees":
      return t("Invitations to");
    case "subject":
      return t("Subject");
    case "title":
      return t("Event");
    case "starts":
      return t("Starts");
    case "ends":
      return t("Ends");
    case "location":
      return t("Where");
    case "template":
      return t("Template");
    case "text":
      return t("Content");
    case "review":
      return t("Review");
    case "order":
      return t("Order number");
    case "status":
      return t("Change to");
  }
}

/**
 * An RFC 3339 time as a date and a clock, with the offset it was written in.
 *
 * Never converted: the offset is part of what goes to the calendar, and showing the event in the
 * viewer's own zone would show a different time from the one the invitation carries. Anything
 * that is not that shape is shown as it came.
 */
function whenOf(value: string): string {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  return match ? `${match[1]} ${match[2]} (${match[3]})` : value;
}

/** The 알림톡 templates a Bot may send, by the name a shop owner knows them by. */
function templateName(code: string): string | undefined {
  switch (code) {
    case "laf_reservation":
      return t("Booking confirmation");
    case "laf_review":
      return t("Review request");
    default:
      return undefined;
  }
}

/**
 * The Cafe24 order statuses this product's own tool description names, in words.
 *
 * Only those: a status code this table does not know is shown as the code, which is honest, where
 * a guessed meaning would not be.
 */
function orderStatusName(code: string): string | undefined {
  switch (code) {
    case "N00":
      return t("Awaiting payment");
    case "N10":
      return t("Preparing the item");
    case "N30":
      return t("Shipping");
    case "N40":
      return t("Delivered");
    default:
      return undefined;
  }
}

function shownValue(
  entry: CallPreviewEntry,
  toolRef: string | undefined,
): string {
  if (entry.field === "starts" || entry.field === "ends") {
    return entry.values.map(whenOf).join(", ");
  }
  if (
    entry.field === "template" &&
    toolRef === "kakao-alimtalk/alimtalk_send"
  ) {
    return entry.values.map((code) => templateName(code) ?? code).join(", ");
  }
  if (entry.field === "status" && toolRef === "cafe24/update_order_status") {
    return entry.values
      .map((code) => {
        const name = orderStatusName(code);
        return name ? `${code} (${name})` : code;
      })
      .join(", ");
  }
  const joined = entry.values.join(", ");
  // The ellipsis sits where the words stop, so the note after it is about the text rather than
  // about the last word.
  return entry.cut && entry.field === "text" ? `${joined}…` : joined;
}

/**
 * The lines a card draws for one preview, in the card's own order.
 *
 * `toolRef` (`<server>/<tool>`) is what lets a vendor's own code be named: `N30` means 배송 중 on
 * Cafe24 and nothing in particular anywhere else.
 */
export function previewLines(
  preview: CallPreview,
  toolRef?: string,
): PreviewLine[] {
  const byField = new Map(preview.map((entry) => [entry.field, entry]));
  const lines: PreviewLine[] = [];
  for (const field of FIELD_ORDER) {
    const entry = byField.get(field);
    if (!entry) continue;
    const notes = [
      ...(entry.total !== undefined && entry.total > entry.values.length
        ? [t("and {count} more", { count: entry.total - entry.values.length })]
        : []),
      ...(entry.cut ? [t("(the rest is not shown)")] : []),
    ];
    lines.push({
      field,
      label: labelOf(field),
      value: shownValue(entry, toolRef),
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    });
  }
  return lines;
}
