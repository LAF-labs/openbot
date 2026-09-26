/*
 * RELATIVE, NOT `@shared`: the model eval builds its briefing scenario with the functions in this
 * file (`evals/morning-briefing.ts`), and the root's typecheck resolves no app alias. Nothing else
 * here may import through one for the same reason — the translator is handed in rather than imported.
 */
import { BUSINESS_SITES } from "../../../../shared/sites/catalogue";

/**
 * 아침 브리핑 — the routine the 7:30 chip makes, composed from what this Bot can reach when it is made.
 *
 * The chip used to repeat the row's first sentence every morning. With nothing connected that was
 * the Naver weather lookup: one fact a phone's lock screen already shows, delivered by a product
 * whose whole claim is that it saves a shop owner time every day (`~/laf/docs/korean-smb-needs-2026-09.md`
 * §7–§8). The Bot can check more than that without anybody logging in, and whatever the person has
 * connected on top of it, so the routine now asks for all of it in one message.
 *
 * WHAT IT CAN REACH, NOT WHAT THE CATALOGUE LISTS. A section is in the instruction only if the thing
 * behind it answers at 07:30 with nobody at the screen — the same rule the first-task chips follow
 * (`first-tasks.ts`, "THE CONNECTION STATE DECIDES"): a line for a site the Bot's browser is not
 * signed into is a login wall scheduled for every morning. What is composed is fixed when the chip is
 * pressed; connecting something later does not rewrite a routine the person can read and edit on
 * Routines, where they add the line themselves (or ask the Bot to).
 *
 * THE INSTRUCTION IS SHORT AND THE PROCEDURE IS A SKILL. The instruction is the list, one line per
 * section, which is what the person reads back on Routines; how to look each one up, how short the
 * answer is, when 지원사업 is asked and how the routine remembers what it already reported are the
 * package's `아침브리핑` skill (`tenant/laf/skills/morning-briefing.md`). That is the footprint ladder's
 * skill rung: one line in the prompt's index, the body read when the routine runs, and no new tool —
 * the notepad's `routine_note` already exists in a routine's own run and nowhere else.
 */

/** The package skill the instruction names. `tests/package-skills.test.ts` holds the package to it. */
export const BRIEFING_SKILL = "아침브리핑";

export type BriefingSection =
  | { kind: "weather" }
  | { kind: "calendar" }
  | { kind: "mail" }
  /**
   * A connected site or account with a first task about new orders or reviews. `name` and `task`
   * are English keys: the site's catalogue name and its first prompt, or the account's title and
   * its first task.
   */
  | { kind: "site" | "account"; id: string; name: string; task: string }
  | { kind: "support" };

/** The accounts that have a section of their own, by the catalogue key the overview reports. */
const CALENDAR = "google-calendar";
const MAIL = "gmail";

/**
 * The OAuth accounts whose first task is new orders or new reviews, with that task.
 *
 * The sentences are `ACCOUNT_FIRST_TASKS`'s own (`morning-briefing.test.ts` holds them equal) rather
 * than imported, for the reason at the top of this file. Sheets, Drive and Notion are not here: a
 * spreadsheet, a drive and a notebook have no "new since this morning" that anybody waits for.
 */
export const BRIEFING_ACCOUNT_TASKS: Readonly<Record<string, string>> = {
  cafe24: "Sort out the orders that came in today.",
  "google-business-profile": "Sort out the reviews that came in this week.",
};

/** The two facts per connection the composition reads, from what `/api/connections` answers. */
export type BriefingConnections = {
  sites: readonly { id: string; status: string }[];
  accounts: readonly {
    kind: string;
    id: string;
    status: string;
    title?: string;
  }[];
};

/**
 * How many connected sites and order or review accounts one briefing visits.
 *
 * A routine run has twelve turns (`DEFAULT_MAX_STEPS`, `server/src/runner/unattended.ts`) and a
 * site is at least one of them, because the Bot has one browser and opens one page at a time. Read
 * the skill, the weather, a Monday's two searches and its note, and the answer take six or seven;
 * three sites fit beside them with room for one that needs a second look. A fourth is the run that
 * ends on its budget with the answer half written.
 */
export const BRIEFING_MAX_PLACES = 3;

/**
 * What the briefing will hold, in the order it is written.
 *
 * Weather always: it needs nothing but the Bot's own browser. Then today's calendar and the mail
 * nobody answered, where those accounts are connected. Then the connected sites whose login a
 * routine can use — `certificate` sites (홈택스) are signed into by a person with a certificate and do
 * not stay signed in until the morning — and the order and review accounts, in the catalogue's
 * order, up to {@link BRIEFING_MAX_PLACES}. 지원사업 last, where the Bot holds the 기업마당 tool; the
 * skill asks it on Mondays only, because the portal's list moves weekly and the same notices every
 * morning are how a briefing stops being read.
 */
export function briefingSections(
  overview: BriefingConnections,
  options: { supportPrograms: boolean },
): BriefingSection[] {
  const connected = (id: string) =>
    overview.accounts.some(
      (account) =>
        account.kind === "oauth" &&
        account.id === id &&
        account.status === "connected",
    );
  const sections: BriefingSection[] = [{ kind: "weather" }];
  if (connected(CALENDAR)) sections.push({ kind: "calendar" });
  if (connected(MAIL)) sections.push({ kind: "mail" });

  const places: BriefingSection[] = [];
  for (const site of BUSINESS_SITES) {
    const task = site.prompts[0];
    if (!task || site.handoff !== "login") continue;
    const state = overview.sites.find((known) => known.id === site.id);
    if (state?.status !== "connected") continue;
    places.push({ kind: "site", id: site.id, name: site.name, task });
  }
  for (const [id, task] of Object.entries(BRIEFING_ACCOUNT_TASKS)) {
    if (!connected(id)) continue;
    const title = overview.accounts.find((account) => account.id === id)?.title;
    places.push({ kind: "account", id, name: title || id, task });
  }
  sections.push(...places.slice(0, BRIEFING_MAX_PLACES));

  if (options.supportPrograms) sections.push({ kind: "support" });
  return sections;
}

/** `t()`'s shape. Handed in — see the top of this file. */
export type Translate = (
  source: string,
  params?: Record<string, string | number>,
) => string;

/** One section as a line of the routine's instruction: what the Bot is asked to check. */
function instructionLine(section: BriefingSection, t: Translate): string {
  switch (section.kind) {
    case "weather":
      return t("Today's weather");
    case "calendar":
      return t("Today's schedule on Google Calendar");
    case "mail":
      return t("Mail nobody has answered, in Gmail");
    case "support":
      return t("If today is Monday: new support programmes on Bizinfo");
    default:
      // Punctuation between two keys, not a sentence: nothing here for a dictionary to translate.
      return `${t(section.name)}: ${t(section.task)}`;
  }
}

/**
 * The routine's instruction: the skill named, then one line per section.
 *
 * The Bot's standing order and the person's to read back on Routines, so it is in the person's
 * language like the sentence the chip used to repeat. Eight lines at most, with everything
 * connected; three with nothing but 기업마당.
 */
export function briefingInstruction(
  sections: readonly BriefingSection[],
  t: Translate,
): string {
  return [
    t("Send this morning's briefing in one message, the way /{skill} says:", {
      skill: BRIEFING_SKILL,
    }),
    ...sections.map((section) => `- ${instructionLine(section, t)}`),
  ].join("\n");
}

/** One section as the chip names it: a word or two, so the whole list reads in one line. */
function contentLabel(section: BriefingSection, t: Translate): string {
  switch (section.kind) {
    case "weather":
      return t("the weather");
    case "calendar":
      return t("today's schedule");
    case "mail":
      return t("unanswered mail");
    case "support":
      return t("new support programmes on Mondays");
    default:
      return t(section.name);
  }
}

/** What the briefing will include, as the chip says it before anything is made. */
export function briefingContents(
  sections: readonly BriefingSection[],
  t: Translate,
): string {
  return sections.map((section) => contentLabel(section, t)).join(", ");
}
