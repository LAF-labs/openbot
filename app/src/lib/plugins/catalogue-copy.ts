/**
 * The catalogue entries' one-line summaries, as this surface's own words.
 *
 * The API sends each entry's summary in English, because the server sends facts and owns no Korean
 * (CLAUDE.md: server prose does not cross to the surface). The catalogue is frozen in code on the
 * server, so its keys are finite and known here too — which is what makes a checked-in table the
 * honest translation seam rather than piping the server's sentence through `t()` and hoping.
 *
 * An entry the server ships that this table does not know falls back to the server's English,
 * which is the visible-and-fixable failure: a new vendor lands, the screen shows an English line,
 * and the walking test in `plugin-catalogue-copy.test.ts` fails until the words are written.
 */
export const CATALOGUE_COPY: Readonly<Record<string, { summary: string }>> = {
  notion: { summary: "Pages and databases of whoever is asking." },
  "google-drive": { summary: "Files in the Drive of whoever is asking." },
  "google-sheets": {
    summary: "Rows in the spreadsheets of whoever is asking.",
  },
  gmail: { summary: "Mail in the mailbox of whoever is asking." },
  "google-calendar": { summary: "The calendar of whoever is asking." },
  "google-business-profile": {
    summary: "Locations and reviews of the business asking.",
  },
  cafe24: { summary: "Orders, products and board posts of one mall." },
};

/** The English key `t()` should be handed for this entry's summary, or the server's own line. */
export function catalogueSummaryKey(key: string, fallback: string): string {
  return CATALOGUE_COPY[key]?.summary ?? fallback;
}
