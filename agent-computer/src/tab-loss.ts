/**
 * The tab a Bot was on, gone from under it — and what the Bot may do before it has looked again.
 *
 * A Bot's tab can go without the Bot doing anything: its renderer dies, or its site closes it (a
 * sign-in window that shuts itself). The Bot's next call then lands on another tab — one it still
 * has open, or a new, empty one (`profiles.page`) — and that is the right thing for a look and the
 * wrong thing for everything else.
 *
 * NOTHING ACTS ON A TAB THE BOT HAS NOT SEEN. Measured 2026-10-05, on the first version of the
 * crashed-tab fix (and, for a tab its site closed, on every version before it): the Bot on a page
 * opens a sign-in popup, asks a person for a password into a box on it, the popup's renderer
 * dies, the person types — and the password is filled into the box the page BEHIND the popup
 * knows by that same ref, while the trail says it went to the popup's site. The secret's door checks no
 * snapshot id, a key press and a scroll carry no ref at all, and a ref is only a name within one
 * tab's own last look. So the loss is counted, and until the Bot has looked at where it now is —
 * a snapshot, a read, a page it opened — every call that would act there is refused with the code
 * that says to look again. The asks standing on the lost tab end with it, as nobody's answer.
 */
import { log } from "./log";
import { STALE_REFS, StaleSnapshotError } from "./refs";
import { type BotSession, note } from "./sessions";
import type { TabLost } from "./tabs";

/**
 * The fact for a tab that was replaced under the Bot: what was on the page it was looking at is
 * gone — a form half filled in, a place scrolled to — and what the browser knows is not: the
 * sign-ins are the profile's. `cause` and the site's `origin` ride beside it.
 */
const TAB_REPLACED = "laf:tab_replaced";

/**
 * The tab this Bot was on is gone. Called the moment it happens (`ProfileOptions.onTabLost`).
 *
 * The refs go with it, for a call that does carry its snapshot's id; the asks, for the person who
 * would otherwise be answering about a page that is not there; and the fact is left for the Bot's
 * next look to carry — ONCE, however many tabs are lost before that look: the newest is the one
 * the Bot was last on, and one sentence about it is what there is to say.
 */
export function tabLost(
  session: BotSession,
  botId: string,
  lost: TabLost,
): void {
  session.tabsLost += 1;
  session.snapshotId += 1;
  const asked = session.control.tabLost();
  session.notes = session.notes.filter((said) => said.code !== TAB_REPLACED);
  note(session, { code: TAB_REPLACED, ...lost });
  if (asked) {
    // The one loss a person was waiting on. What they were asked for is not said: it is the
    // Bot's own words, and a label is where a page's text ends up.
    log.info("ask_ended_tab_lost", { bot: botId, ...lost });
  }
}

/** Whether the Bot has looked at the tab it is on since it was put there. */
const hasLooked = (session: BotSession): boolean =>
  session.tabsSeen === session.tabsLost;

/**
 * Refuse to act on a tab the Bot has not seen: look again, said the way a stale ref is.
 *
 * AFTER THE TAB IS ASKED FOR, NOT BEFORE. A loss is counted in the same tick the tab goes, so a
 * call that was handed the tab the Bot fell back to finds the count already moved.
 */
export function assertLooked(session: BotSession): void {
  if (!hasLooked(session)) throw new StaleSnapshotError(STALE_REFS);
}

/**
 * A look that answered: the Bot has seen where it is.
 *
 * `seen` is the count as it stood when the look took its tab, not as it stands now — a tab lost
 * while the look was being written is a tab the look did not describe.
 */
export function looked(session: BotSession, seen: number): void {
  session.tabsSeen = seen;
}
