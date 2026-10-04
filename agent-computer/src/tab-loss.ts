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
 * knows by that same ref, while the trail says it went to the popup's site. The secret's door
 * checked no snapshot id, a key press and a scroll carry no ref at all, and a ref is only a name
 * within one tab's own last look. So the loss is counted, and until the Bot has looked at where it
 * now is — a snapshot, a read, a page it opened — every call that would act there is refused with
 * the code that says to look again. The asks standing on the lost tab end with it, as nobody's
 * answer.
 *
 * THE LOOK IS THE BOT'S OWN, AND THE FACT RIDES ON IT. The second version counted any read, and
 * left the fact in the queue every answer drains. A person pressing 다 했어요 on a site hand-off
 * reads the page too (`server/src/computer/site-routes.ts`): that read let the Bot act again and
 * carried the fact off in an answer the server throws away. And a navigation held at a new host
 * for the gateway to judge drained it into an answer the gateway drops before asking again — the
 * likeliest first call after a loss. So only a look taken for the Bot's model counts
 * (`shared/bots-look.ts`), and that look is what says the tab is gone: on the answer the model
 * reads, never on a hop that was held or a call that failed.
 */
import { LOOK_HEADER, PERSONS_LOOK } from "../../shared/bots-look";
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
 * would otherwise be answering about a page that is not there; and which tab it was is kept for
 * the Bot's next look to say — the newest only: it is the one the Bot was last on.
 */
export function tabLost(
  session: BotSession,
  botId: string,
  lost: TabLost,
): void {
  session.tabsLost += 1;
  session.snapshotId += 1;
  session.lostTab = lost;
  if (session.control.tabLost()) {
    // The one loss a person was waiting on. What they were asked for is not said: it is the
    // Bot's own words, and a label is where a page's text ends up.
    log.info("ask_ended_tab_lost", { bot: botId, ...lost });
  }
}

/**
 * Whether a look is taken for the Bot's model, which is what the server says with each one.
 *
 * A person's is the one that is named. A call that says nothing is the Bot's, as every look was
 * before the header existed (`shared/bots-look.ts` says why an older server must not be read as a
 * person).
 */
export function isBotsLook(request: Request): boolean {
  return (
    request.headers.get(LOOK_HEADER)?.trim().toLowerCase() !== PERSONS_LOOK
  );
}

/**
 * Refuse to act on a tab the Bot has not seen: look again, said the way a stale ref is.
 *
 * AFTER THE TAB IS ASKED FOR, NOT BEFORE. A loss is counted in the same tick the tab goes, so a
 * call that was handed the tab the Bot fell back to finds the count already moved.
 */
export function assertLooked(session: BotSession): void {
  if (session.tabsSeen !== session.tabsLost) {
    throw new StaleSnapshotError(STALE_REFS);
  }
}

/**
 * The Bot's own look answered: it has seen where it is, and is told once why it is not where it
 * was.
 *
 * Called by a look that worked, just before its answer is written, and only for a look the Bot's
 * model will read (`isBotsLook`). `seen` is the count as it stood when the look took its tab, not
 * as it stands now — a tab lost while the look was being written is a tab the look did not
 * describe, and the next look says that one.
 */
export function looked(session: BotSession, seen: number): void {
  if (seen > session.tabsSeen && session.lostTab) {
    note(session, { code: TAB_REPLACED, ...session.lostTab });
  }
  session.tabsSeen = seen;
}
