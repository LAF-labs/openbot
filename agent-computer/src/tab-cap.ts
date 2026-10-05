/**
 * A Bot's tabs, kept to a number — which of them the Bot's session holds open against that, and
 * what the Bot is told when one is closed.
 *
 * `tabs.ts` counts a Bot's tabs and, when one more than `TAB_CAP` is open, closes the one the Bot
 * used longest ago of those that may go. It keeps the order, and it knows which tab the Bot is on
 * and which tabs an open window reports to. What it cannot know is in the Bot's session, and is
 * asked for here.
 *
 * NOT THE LOSS `tab-loss.ts` GUARDS. The Bot was not on the tab that went. It is where it was, on
 * a page it has seen, and its refs name what they named — so nothing is frozen, no ask ends, and
 * the Bot is not told its tab went from under it. That would be a lie about a tab it still has.
 *
 * WHAT DID CHANGE IS THE LIST. `computer_switch_tab` names a tab by its place in the list the Bot
 * last read, and every tab after the closed one has moved up: the same number is another tab now.
 * `tabs.ts` refuses a switch until the Bot has read the list again, with the code a switch is
 * already answered with after a loss — look again (`laf:stale_refs`). Measured 2026-10-05 with
 * the cap in and the refusal taken out (`tests/tab-cap.test.ts`): six tabs, a seventh opens, the
 * second is closed, and a switch to index 2 — the third tab in the list the Bot had read —
 * answered 200 on the fourth, which had moved into that place.
 *
 * REFUSED, RATHER THAN THE INDEX MADE A NAME. A number that stayed a tab's own for as long as it
 * was open would need no refusal — and would stop being a place: the tool's own description says
 * the first tab is 0, the server's schema calls it a position, and a Bot whose tab was replaced
 * after a deadline is told `index: 0` about the new one (`tests/hung-site.test.ts`). The refusal
 * costs a Bot one snapshot, which it takes after a click anyway — and a tab is only ever closed
 * for the cap by the tab a click, or a page, has just opened.
 *
 * THE FACT RIDES ON THE LIST, ONCE, AND ONLY ON THE BOT'S OWN. `laf:old_tab_closed`, with how
 * many tabs went and the sites they showed, on the snapshot that hands the Bot its list as it now
 * is. Not put in the queue every answer drains, for the reason a lost tab is not (`tab-loss.ts`):
 * a person's screen takes snapshots too, and would carry it off in an answer the server throws
 * away.
 *
 * AND THE ROUND ENDS ON THAT SNAPSHOT. A model may ask for a look and a switch in one reply, and
 * the look re-arms the Bot here before the model has read the list it carried: the old index
 * would land. The turn loop is where a round's steps stop, so a result carrying this fact — or
 * `laf:tab_replaced` — leaves the acting steps after it in that reply untried
 * (`server/src/runner/round-stop.ts`).
 */
import type { Page } from "playwright";
import type { NoteCode } from "./codes";
import type { Profiles } from "./profiles";
import { type BotSession, note } from "./sessions";

/**
 * The fact for tabs closed to keep a Bot's tabs to their number: never the one it was on. `closed`
 * — how many went since the Bot last read its list — and `origins`, the sites they were showing,
 * each once, ride beside it.
 */
const OLD_TAB_CLOSED: NoteCode = "laf:old_tab_closed";

/**
 * Whether this session is holding a tab open, whatever its place in the order (`ProfileOptions.holdsTab`).
 *
 *  - THE TAB BEING CAST. It is the picture a person is watching, and the tab their clicks and keys
 *    go to once they have the wheel (`live-screen.ts`). The cast follows the Bot's tab a second
 *    behind, so for that second it is not the tab the Bot is on.
 *  - THE TAB A VALUE WAS ASKED FOR ON, while it is wanted: a person's value goes into that tab or
 *    into none (`control-routes.ts`).
 *  - THE TAB A HAND WAS ASKED FOR ON, OR THE WHEEL TAKEN ON, while the ask stands or the person
 *    holds the wheel: it is the page they were handed, and where the Bot goes on from.
 *
 * HELD EVEN AT THE CEILING. Past `TAB_CEILING` a tab goes whatever window reports to it, and these
 * still do not: they are a person's hands and a person's answer. They are three tabs at most, so
 * the ceiling always has something else to close.
 *
 * A session this process has not made holds nothing.
 */
export function holdsTab(session: BotSession | undefined, page: Page): boolean {
  if (!session) return false;
  if (session.viewer?.page === page) return true;
  if (session.secretTab !== page && session.wheelTab !== page) return false;
  const state = session.control.get();
  return (
    (session.secretTab === page && Boolean(state.secretWanted)) ||
    (session.wheelTab === page && (state.requested || state.holder === "human"))
  );
}

/**
 * The Bot's own look carried its list of tabs: an index is a place in that list now, and the Bot
 * is told once if an old tab was closed since the list before.
 *
 * Called by a snapshot that worked, just before its answer is written, and only for a look the
 * Bot's model will read (`tab-loss.ts`, `isBotsLook`). `capped` is the count as it stood in the
 * tick the list was read, not as it stands now: a tab closed while the look was being written is
 * a tab that list still shows, and the next one says so.
 */
export function listRead(
  session: BotSession,
  profiles: Pick<Profiles, "listRead">,
  botId: string,
  capped: number,
): void {
  const closed = profiles.listRead(botId, capped);
  if (closed) note(session, { code: OLD_TAB_CLOSED, ...closed });
}
