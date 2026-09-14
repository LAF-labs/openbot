/**
 * `/help`, opened: which of the guide's sections the address named, and the one request per visit
 * that says so (`POST /api/support/help-opened`).
 *
 * WHY ANYTHING IS SENT. The launch plan asks whether anybody reads the help at all, and the page
 * left nothing anywhere to count — laf-control's `insights` listed it as a question no row could
 * answer. One row per visit is the answer; the page sends it once when it is opened
 * (`help-page.tsx`), never per render and never per scroll.
 *
 * KEYS, NOT HEADINGS. The guide's headings are Korean prose in `help/guide.md`; the server is told a
 * key from this table or nothing. `help-page.test.ts` holds the table to the guide's five headings
 * in order, so a heading renamed there fails here instead of quietly becoming a section no link
 * can name.
 */

export const HELP_SECTIONS = [
  { key: "bots", heading: "봇 만들기" },
  { key: "connections", heading: "연결" },
  { key: "approvals", heading: "승인" },
  { key: "routines", heading: "루틴" },
  { key: "trouble", heading: "문제가 생기면" },
] as const;

export type HelpSection = (typeof HELP_SECTIONS)[number]["key"];

/** The section an address's fragment names (`/help#routines`), or null for none this guide has. */
export function helpSectionFrom(hash: string): HelpSection | null {
  const named = hash.replace(/^#/, "");
  return HELP_SECTIONS.find((section) => section.key === named)?.key ?? null;
}

/** The key a heading of the guide is anchored at, so `/help#<key>` has somewhere to land. */
export function helpSectionOfHeading(heading: string): HelpSection | null {
  const text = heading.trim();
  return HELP_SECTIONS.find((section) => section.heading === text)?.key ?? null;
}

/** What `POST /api/support/help-opened` is sent. Null when the address named no section. */
export function helpOpenedBody(section: HelpSection | null): {
  section: HelpSection | null;
} {
  return { section };
}

/**
 * Say the guide was opened. Not awaited by anybody and silent when it fails: a visit that was not
 * counted is a missing count, not something to show a person who came here because they are stuck.
 */
export function reportHelpOpened(
  section: HelpSection | null,
  // `fetch` looked up at the moment of the call, and called as itself rather than detached.
  send: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
    fetch(url, init),
): void {
  void (async () => {
    try {
      await send("/api/support/help-opened", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(helpOpenedBody(section)),
      });
    } catch {
      // See above.
    }
  })();
}
