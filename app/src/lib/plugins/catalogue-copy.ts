import { GENERIC_MARK } from "@/components/connections/connection-mark";

/**
 * The catalogue entries' words, as this surface's own.
 *
 * The API sends each entry's summary in English, because the server sends facts and owns no Korean
 * (CLAUDE.md: server prose does not cross to the surface). The catalogue is frozen in code on the
 * server, so its keys are finite and known here too — which is what makes a checked-in table the
 * honest translation seam rather than piping the server's sentence through `t()` and hoping.
 *
 * An entry the server ships that this table does not know falls back to the server's English,
 * which is the visible-and-fixable failure: a new vendor lands, the screen shows an English line,
 * and the walking test in `plugin-catalogue-copy.test.ts` fails until the words are written.
 *
 * `can` IS WHAT REPLACED THE SCOPE STRING. The 연결 row used to print the vendor's own grant
 * verbatim — `https://www.googleapis.com/auth/spreadsheets.readonly` in a `<code>` block — under
 * the heading "Granted access". It is the most precise thing on the screen and it tells a shop
 * owner nothing whatsoever; worse, it looks like an error. So the row says what the Bot can now do,
 * in one sentence, and the precise version is between this deployment and the vendor where it
 * belongs.
 */
export const CATALOGUE_COPY: Readonly<
  Record<string, { summary: string; can: string; mark: string }>
> = {
  notion: {
    mark: "notion",
    summary: "Pages and databases of whoever is asking.",
    can: "Reads the pages you have shared, and writes new ones.",
  },
  "google-drive": {
    mark: "google",
    summary: "Files in the Drive of whoever is asking.",
    can: "Finds files in your Drive and reads what is in them.",
  },
  "google-sheets": {
    mark: "google",
    summary: "Rows in the spreadsheets of whoever is asking.",
    can: "Reads your spreadsheets and fills rows in for you.",
  },
  gmail: {
    mark: "google",
    summary: "Mail in the mailbox of whoever is asking.",
    can: "Reads your mail and writes replies for you to send.",
  },
  "google-calendar": {
    mark: "google",
    summary: "The calendar of whoever is asking.",
    can: "Reads your calendar and books time on it.",
  },
  "google-business-profile": {
    mark: "google",
    summary: "Locations and reviews of the business asking.",
    can: "Reads the reviews left on your shop and writes replies.",
  },
  cafe24: {
    mark: "cafe24",
    summary: "Orders, products and board posts of one mall.",
    can: "Reads your shop's orders and products, and answers board posts.",
  },
  /*
   * The partner entry. The gesture on its row is different — a code to a phone — but the one line
   * saying what the Bot can do afterwards is the same kind of sentence, and the row draws it from
   * the same table.
   */
  "kakao-alimtalk": {
    mark: "kakao",
    summary: "Template messages from this business's own KakaoTalk channel.",
    can: "Sends booking confirmations and review requests from your own channel.",
  },
};

/**
 * Which mark the 연결 row draws for this entry.
 *
 * The globe for a vendor this table has not caught up with, which is the honest answer: a wrong
 * brand mark on a login row is worse than a plain one.
 */
export function catalogueMark(key: string): string {
  return CATALOGUE_COPY[key]?.mark ?? GENERIC_MARK;
}

/** The English key `t()` should be handed for this entry's summary, or the server's own line. */
export function catalogueSummaryKey(key: string, fallback: string): string {
  return CATALOGUE_COPY[key]?.summary ?? fallback;
}

/**
 * The English key for this entry's one line of what the Bot can do.
 *
 * Falls back to the summary key for an entry this table has not caught up with, which reads as a
 * description rather than as a capability but is at least about the right vendor.
 */
export function catalogueCanKey(key: string, fallback: string): string {
  return CATALOGUE_COPY[key]?.can ?? catalogueSummaryKey(key, fallback);
}
