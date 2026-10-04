/**
 * A Bot's tabs in the deployment's one browser: how many it may hold, and how long they may sit
 * unused.
 */
import type { Page } from "playwright";
import { log } from "./log";
import { originOf } from "./navigation-guard";
import { titleOf } from "./page-text";

/** One tab in a Bot's browser, as the snapshot lists them. */
export type TabSummary = {
  /** Position in the Bot's own list, which is what `computer_switch_tab` takes. */
  index: number;
  title: string;
  url: string;
  /** The one the Bot's next action lands on. */
  active: boolean;
};

/** A tab index that names nothing. Its own type so the route can answer 400 rather than 502. */
export class TabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TabError";
  }
}

/**
 * A tab index read from a list that has changed since. Its own type so the route can say to look
 * again (409) rather than that there is no such tab: there may well be one, and it is another.
 */
export class TabListError extends Error {
  constructor() {
    super("laf:stale_refs");
    this.name = "TabListError";
  }
}

/**
 * How long a Bot may leave its tabs untouched before they are closed.
 *
 * Ten minutes. Four of five Bots are usually asleep between a routine at nine and one at noon, and a
 * tab nobody is looking at still costs a renderer; closing them costs the next call a page load and
 * gives the machine its memory back. The cookies are on the volume and the profile is shared, so
 * nothing is signed out by it — and when the last Bot's tabs go, so does the browser.
 */
export const IDLE_CLOSE_MS = 10 * 60_000;

/** How often idleness is checked. Coarse on purpose: this is housekeeping, not a deadline. */
export const IDLE_SWEEP_MS = 60_000;

/**
 * How many tabs one Bot holds. One more is opened, and the one it used longest ago is closed.
 *
 * WHY THERE IS A NUMBER AT ALL. Nothing counted a Bot's tabs and nothing closed one while the Bot
 * kept calling: every `target=_blank` link and every window a site opens is adopted (`adoptOpened`),
 * no route closes a tab, and the idle close looks at the Bot's last call (`IDLE_CLOSE_MS`), so it
 * never comes for a Bot that is working. Measured 2026-10-05 against a real Chromium
 * (`tests/tab-cap.test.ts`, before this): one Bot, thirty opens — twenty-seven `_blank` clicks and
 * three `window.open` — and its tabs went 2, 3, 4 … 31, one more for every open.
 *
 * WHAT A TAB COSTS, measured the same day in the stable image under `mem_limit: 3g`, on
 * news.naver.com: no browser 292 MiB and 19 processes; the browser and one tab 524 MiB and 87; five
 * tabs 1,082 MiB and 142; ten 1,724 MiB and 208 (1,752 MiB twenty seconds later). So 130–140 MiB and
 * 13–14 processes for every tab after the first, and about twenty such tabs is the whole container
 * — which Naver's results, each opening in a tab of its own, reach inside one long task.
 *
 * WHY SIX. What a task needs is small: a sign-in window and the page that opened it is two, a
 * payment window with its 본인인증 window three, a list and a handful of the pages off it five or
 * six. Six heavy tabs is about 1.2 GiB with the process around them, two fifths of the limit —
 * room for pages twice as heavy, for the seventh tab that exists for a moment before the oldest is
 * closed, and for a second Bot of a legacy account at its own six (about 2 GiB together; five Bots
 * all at six would be 4.4 GiB, and never fit before this either). And six is more than the tabs
 * that may not be closed can ever be (`keepToCap`: at most five), so there is always one to close.
 *
 * A CONSTANT, NOT A SETTING. The number follows from the image's memory limit and what a page
 * costs, both of which are this repository's; a deployment has no reason to hold another.
 */
export const TAB_CAP = 6;

/** The shortest time between two lines of one kind about one Bot. See `say`. */
const LINE_MS = 60_000;

/**
 * The tab a Bot was on, gone from under it: how, and which site it was showing — the origin only,
 * for the reason a log line carries no more (a path and a query are the page's).
 */
export type TabLost = { cause: "crashed" | "closed"; origin: string };

/**
 * The tabs of a Bot's closed to keep them to {@link TAB_CAP} since it last read its list: how many,
 * and the site the last of them was showing — the origin only, as everywhere a tab is spoken of.
 * Never the tab the Bot was on.
 */
type TabCapped = { origin: string; closed: number };

/** What is kept for a Bot for as long as it has tabs. See `live`. */
type Live = {
  /** The tab the Bot's next call lands on. */
  page: Page;
  /** When the Bot last did anything. See IDLE_CLOSE_MS. */
  usedAt: number;
  since: string;
  /**
   * How many of its tabs were closed for the cap, and that count as it stood when the Bot last
   * read its list. While the two differ the list an index was read from has changed (`switchTab`).
   * Here and not with the Bot's session, because they are facts about this list and end with it:
   * a Bot whose tabs were all closed — idle, stopped — starts again with one tab and nothing to
   * be told about the ones before.
   */
  capped: number;
  listed: number;
  /** The site the last tab closed for the cap was showing. */
  cappedOrigin?: string;
};

/** What the bookkeeping needs from the browser it keeps the books of. */
type TabsBrowser = {
  /** Every page the deployment's browser has open, none while it is not running. */
  pages: () => Page[];
  now: () => number;
  /** Told of every page the moment it becomes a Bot's (`ProfileOptions.onPage`). */
  onPage: (botId: string, page: Page) => void;
  /**
   * Told when the tab a Bot was ON goes from under it — its renderer died, or its site closed it
   * (`ProfileOptions.onTabLost`). Not for a tab this process closed, and not for one the Bot had
   * open and was not on: the Bot is still where it last looked.
   */
  onLost: (botId: string, lost: TabLost) => void;
  /**
   * Whether something outside these books is holding this tab of the Bot's open: a person's hands,
   * the picture a person is watching, something the Bot asked a person for on it
   * (`ProfileOptions.holdsTab`). Such a tab is never the one closed for the cap.
   */
  holds: (botId: string, page: Page) => boolean;
};

/**
 * Which tab is whose, in a browser every Bot shares.
 *
 * Returns its two maps along with what reads and writes them, because `profiles.ts` decides when the
 * browser starts and stops and clears both when it does.
 */
export function createTabs(browser: TabsBrowser) {
  const { now } = browser;

  /**
   * Which Bot each open tab belongs to.
   *
   * The cookie jar is shared and the tabs are not. Without this, one Bot's `/snapshot` would describe
   * whatever page another Bot happened to open last, and `computer_switch_tab` would hand it the
   * wheel of a tab it never opened.
   */
  const owners = new Map<Page, string>();

  /** Each Bot's current tab, when it last did anything, and what became of its list. */
  const live = new Map<string, Live>();

  /**
   * The tabs whose renderer died, for as long as the browser still lists them.
   *
   * A crashed tab is let go of at once and closed a moment later, and in that moment — or for
   * ever, when the close never comes back — it is open and nobody's: exactly what a Bot with no tab
   * is handed as the spare (`profiles.page`). Asked there, so no Bot is handed a dead tab, and by
   * `/navigate`, to tell a renderer that died from a site that would not answer.
   */
  const crashed = new WeakSet<Page>();

  /**
   * The tabs closed for the cap, for as long as the browser still lists them: let go of at once
   * and closed a moment later, like a crashed one, and like it never the spare a Bot is handed.
   */
  const capped = new WeakSet<Page>();

  /**
   * When each tab was last the one its Bot was on, as a place in the order of every such moment.
   *
   * A COUNT, NOT A CLOCK. Which tab was used longest ago is a question about order, and two tabs
   * touched in one millisecond — a click and the tab it opened — must still have one. Per tab,
   * where `live` keeps one time for the whole Bot: that one decides when everything goes, this one
   * which tab goes first.
   */
  const used = new WeakMap<Page, number>();
  let uses = 0;
  const use = (page: Page): void => {
    uses += 1;
    used.set(page, uses);
  };

  /** The tab that opened each tab a site opened, as the browser said when it was adopted. */
  const openers = new WeakMap<Page, Page>();

  /** This Bot's open tabs, in the browser's own order. */
  const pagesOf = (botId: string): Page[] =>
    browser
      .pages()
      .filter((page) => !page.isClosed() && owners.get(page) === botId);

  /** Whether this is the tab the Bot's next call would have landed on. */
  const isOn = (botId: string, page: Page): boolean =>
    live.get(botId)?.page === page;

  /** When the last line of each kind about each Bot was written, and how many since went unsaid. */
  const lines = new Map<string, { at: number; unsaid: number }>();

  /**
   * One warn line about a Bot's tab — its renderer died, it was closed for the cap — and no more
   * than one a minute of each kind for a Bot. A tab is named by its site's origin only: a path, a
   * query and a title are the page's.
   *
   * BOUNDED, BECAUSE A LOOP IS POSSIBLE. A dead tab is replaced by an empty one, which has nothing
   * to die of; but a machine too short of memory to keep any renderer loses the replacement too,
   * and while a person has the live screen open a replacement is asked for every second
   * (`live-screen.ts`). That is a line a second for as long as it lasts. And a Bot working through
   * a list of results closes a tab for the cap with every one it opens. The ones not written are
   * counted on the next one that is.
   */
  const say = (
    event: "tab_crashed" | "tab_capped" | "tab_cap_exceeded",
    botId: string | undefined,
    facts: Record<string, string | number>,
  ): void => {
    const key = `${event} ${botId ?? ""}`;
    const last = lines.get(key);
    if (last && now() - last.at < LINE_MS) {
      last.unsaid += 1;
      return;
    }
    log.warn(event, {
      ...(botId ? { bot: botId } : {}),
      ...facts,
      ...(last?.unsaid ? { unsaid: last.unsaid } : {}),
    });
    lines.set(key, { at: now(), unsaid: 0 });
  };

  /*
   * A TAB WHOSE RENDERER DIED IS NOBODY'S TAB.
   *
   * Measured 2026-10-05: one Bot, 57 browsing tasks on heavy Korean pages, and then every
   * `/navigate` answered `laf:navigation_failed` — nineteen in a row, still ten minutes later —
   * while the container stayed healthy, logged nothing and a Bot with another name worked at
   * once. A renderer that dies — ended by DevTools, or by the system as one that runs out of
   * memory is — leaves its tab neither closed nor detached (`isClosed()` false). So the tab stayed
   * in this Bot's list, Playwright refused every `goto` on it in a millisecond (`Page crashed`),
   * and the idle close never came because the Bot kept asking. Reproduced in
   * `tests/crashed-tab.test.ts`: 502 in 0–4 ms, for as long as it was asked. That it was memory on
   * the day was not reproduced; that a dead renderer leaves exactly the day's shape was.
   *
   * So a renderer's death ends the tab's time as anybody's. `live` is left as it is, the way it is
   * when a site closes a tab: `profiles.page` sees its tab is no longer the Bot's and falls back to
   * another the Bot has, or opens one. NOT HERE, because a tab opened the moment a renderer died
   * for want of memory is one more renderer — but not only on the Bot's next call either: whoever
   * asks for the Bot's tab next opens it, and while a person is watching, the live screen asks once
   * a second (`live-screen.ts`).
   *
   * LEARNED TWO WAYS, COUNTED ONCE. The browser's own `crash` event, heard on every tab from the
   * moment it exists (`hear`); and, for a death nothing heard, the call that fails on the tab
   * (`profiles.deadTab`, from the door). Whichever comes first lets go of it.
   *
   * THE CLOSE IS ASKED FOR, NEVER WAITED FOR. A browser that has just lost a renderer may not
   * answer it, and nothing is listening for the answer: the tab is already out of every list.
   */
  const died = (page: Page): void => {
    if (crashed.has(page)) return;
    crashed.add(page);
    const origin = originOf(page.url());
    const botId = owners.get(page);
    if (botId === undefined) {
      // Nobody's: one no Bot had been handed yet, or one this process had already let go of.
      say("tab_crashed", undefined, { origin, tabs: 0 });
    } else {
      // Counted with the dead one still in it: how many tabs the Bot was holding when it died.
      const had = pagesOf(botId).length;
      const wasOn = isOn(botId, page);
      owners.delete(page);
      say("tab_crashed", botId, { origin, tabs: had });
      if (wasOn) browser.onLost(botId, { cause: "crashed", origin });
    }
    void page.close().catch(() => undefined);
  };

  /** The tabs already listened to, so no tab is listened to twice. */
  const heard = new WeakSet<Page>();

  /**
   * Listen for a tab's renderer dying, from the moment the tab exists and whoever's it becomes.
   *
   * NOT FROM THE MOMENT IT IS OWNED, which is where the listening began: a tab a site opened is
   * owned only once the browser has said who opened it (`adoptOpened`), and the tab a browser
   * starts with is owned by nobody until a Bot takes it (`profiles.page`). One that died in between
   * was adopted dead — the Bot's tab, and failing every call for ever — or handed out as the spare.
   */
  const hear = (page: Page): void => {
    if (heard.has(page)) return;
    heard.add(page);
    page.once("crash", () => died(page));
  };

  /**
   * Mark a tab as this Bot's, and stop saying so once it is closed or its renderer has died.
   *
   * A TAB THAT CLOSES WHILE IT IS STILL THE BOT'S WAS CLOSED BY ITS SITE. Everything this process
   * closes it lets go of first — a stop, a tab replaced after a deadline, a dead renderer, a tab
   * closed for the cap, the browser itself. So when the tab the Bot was ON closes that way, the
   * Bot is somewhere it has not looked, exactly as when its renderer dies, and whoever keeps the
   * Bot's session is told the same thing (`onLost`).
   */
  const own = (botId: string, page: Page): void => {
    owners.set(page, botId);
    hear(page);
    page.once("close", () => {
      if (owners.get(page) !== botId) return;
      const wasOn = isOn(botId, page);
      owners.delete(page);
      if (wasOn) {
        browser.onLost(botId, {
          cause: "closed",
          origin: originOf(page.url()),
        });
      }
    });
  };

  /** Note that this Bot has a tab, without moving `since` if it already had one. */
  const touch = (botId: string, page: Page): Page => {
    live.set(botId, {
      since: new Date().toISOString(),
      capped: 0,
      listed: 0,
      ...live.get(botId),
      page,
      usedAt: now(),
    });
    use(page);
    return page;
  };

  /** Close this Bot's tabs and forget it is here. Says whether it had any. */
  const closeTabsOf = async (botId: string): Promise<boolean> => {
    const pages = pagesOf(botId);
    live.delete(botId);
    for (const page of pages) owners.delete(page);
    await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
    return pages.length > 0;
  };

  /**
   * Whether a tab is open, nobody's, and may be handed to a Bot that has none (`profiles.page`).
   * Never one this process has let go of and the browser has not closed yet.
   */
  const isSpare = (page: Page): boolean =>
    !page.isClosed() &&
    !owners.has(page) &&
    !crashed.has(page) &&
    !capped.has(page);

  /*
   * A BOT HOLDS `TAB_CAP` TABS, AND THE ONE IT USED LONGEST AGO MAKES ROOM FOR A NEW ONE.
   *
   * Asked whenever a tab becomes a Bot's that it did not have (`adoptOpened`, the one place a
   * Bot's tabs grow), so the new tab exists before the old one goes: closing first would close a
   * tab for a window that then never opened.
   *
   * WHICH TAB MAY NOT GO, whatever its place in the order:
   *
   *  - the tab the Bot is on. That would be the loss `tab-loss.ts` guards, done by this process;
   *  - the tab that opened the one the Bot is on. A sign-in window reports to the page that
   *    opened it, and a page closed behind its own window is a sign-in that lands nowhere;
   *  - a tab somebody outside these books holds (`holds`): the one a person has the wheel of, the
   *    one a live screen is casting, the one a value or a hand was asked for on.
   *
   * ONLY THE OPENER OF THE TAB THE BOT IS ON, not of every tab it has: every tab a `_blank` link
   * opened has one, and a rule that kept them all would keep a chain of pages opened one from
   * the next whole, however long.
   *
   * At most five tabs — those two and the three a session can hold — so with seven there is
   * always another. If ever there is not, nothing is closed: the Bot is over the cap by the tab
   * that just opened, a line says so, and the next tab that opens asks again.
   *
   * ANOTHER BOT'S TABS ARE NOT IN THIS COUNT AND NEVER GO FOR IT. A legacy account's Bots share the
   * browser and each has its own six.
   *
   * NOT A LOSS, AND NOT SAID AS ONE. The Bot is where it was, so nothing is frozen and no ask
   * ends. What changed is the list its `computer_switch_tab` index was read from, so the close is
   * counted: an index from before is refused (`switchTab`), and the Bot's next list says once
   * that an old tab was closed (`listRead`, `tab-cap.ts`).
   *
   * LET GO OF BEFORE IT IS CLOSED, like everything this process closes, so `own`'s listener does
   * not take the close for the site's; and the close is asked for, never waited for.
   */
  const keepToCap = (botId: string): void => {
    const running = live.get(botId);
    if (!running) return;
    for (;;) {
      const mine = pagesOf(botId);
      if (mine.length <= TAB_CAP) return;
      const on = running.page;
      const opener = openers.get(on);
      const oldest = mine
        .filter(
          (page) =>
            page !== on && page !== opener && !browser.holds(botId, page),
        )
        .sort((one, other) => (used.get(one) ?? 0) - (used.get(other) ?? 0))[0];
      if (!oldest) {
        say("tab_cap_exceeded", botId, { tabs: mine.length, cap: TAB_CAP });
        return;
      }
      const origin = originOf(oldest.url());
      owners.delete(oldest);
      capped.add(oldest);
      // Counted with the closed one still in it: how many the Bot held when one had to go.
      say("tab_capped", botId, { origin, tabs: mine.length });
      running.capped += 1;
      running.cappedOrigin = origin;
      void oldest.close().catch(() => undefined);
    }
  };

  /*
   * A TAB A SITE OPENED BELONGS TO THE BOT WHOSE CLICK OPENED IT.
   *
   * 네이버 opens half its links with `target=_blank`. Without this the Bot clicked, the page it
   * asked for opened in a tab nothing here held a handle to, and both the Bot and the person
   * watching the screencast went on looking at the page they had left — the click "worked" and
   * nothing about the answer was true. Adopting the newest page is what a person does: the tab
   * that just opened is the one they are looking at.
   *
   * WHOSE it is now has to be worked out rather than assumed, because the browser is everyone's.
   * `opener()` is the browser's own answer to "which page opened this one", so the new tab lands
   * with the Bot that clicked the link and in nobody else's list. A tab we opened ourselves has
   * already been claimed by the time this resolves, and is left alone.
   */
  const adoptOpened = (opened: Page): void => {
    // Before the browser is asked whose it is: a tab can die while that is being answered.
    hear(opened);
    void (async () => {
      if (owners.has(opened)) return;
      const opener = await opened.opener().catch(() => null);
      if (owners.has(opened)) return;
      // Gone already — its renderer died, or it closed itself — and never anybody's: the Bot is
      // still on the tab it clicked in, and a dead tab made its own would be all it had.
      if (crashed.has(opened) || opened.isClosed()) return;
      const botOf = opener ? owners.get(opener) : undefined;
      // Not ours to hand to anybody: a tab with no opener we did not open. Left unowned rather
      // than guessed at — a page in the wrong Bot's list is a click landing on a stranger's page.
      if (!botOf) return;
      own(botOf, opened);
      if (opener) openers.set(opened, opener);
      touch(botOf, opened);
      browser.onPage(botOf, opened);
      keepToCap(botOf);
    })();
  };

  /**
   * Every tab this Bot has open, in the browser's own order.
   *
   * Reported on every snapshot rather than only when asked: a Bot that cannot see that a second
   * tab exists cannot decide to go to it, and the tab a click opened is usually the one holding
   * the answer. Another Bot's tabs are not in this list — they are on the same browser, not in
   * this Bot's hands.
   */
  const tabs = async (botId: string): Promise<TabSummary[]> => {
    const running = live.get(botId);
    if (!running) return [];
    return Promise.all(
      pagesOf(botId).map(async (page, index) => ({
        index,
        // A page that navigates while we are describing it costs its title, not the list — and a
        // tab between documents has none, never Playwright's `Loading <address>` (see `titleOf`).
        title: await titleOf(page),
        url: page.url(),
        active: page === running.page,
      })),
    );
  };

  /**
   * How many of this Bot's tabs have been closed for the cap, for a look to keep as it reads the
   * list (`tabs`) and hand back when its answer is written (`listRead`).
   */
  const cappedOf = (botId: string): number => live.get(botId)?.capped ?? 0;

  /**
   * The Bot has been handed its list as it stood at that count: an index is a place in that one
   * now. Returns what was closed for the cap since the list before it, once — undefined when
   * nothing was, or when the list this count was read from is gone and another begun.
   */
  const listRead = (botId: string, capped: number): TabCapped | undefined => {
    const running = live.get(botId);
    if (!running || capped <= running.listed || capped > running.capped) {
      return undefined;
    }
    const closed = capped - running.listed;
    running.listed = capped;
    return { origin: running.cappedOrigin ?? "", closed };
  };

  /**
   * Move the Bot to one of them. Refuses an index that names nothing rather than picking one —
   * and an index read before a tab was closed for the cap, which names a place in a list that has
   * moved up since: the same number is another tab now (`TabListError`).
   */
  const switchTab = async (
    botId: string,
    index: number,
  ): Promise<TabSummary[]> => {
    const running = live.get(botId);
    if (!running) {
      throw new TabError("laf:tab_missing");
    }
    if (running.listed !== running.capped) throw new TabListError();
    const wanted = pagesOf(botId)[index];
    if (!wanted) {
      throw new TabError("laf:tab_missing");
    }
    running.page = wanted;
    running.usedAt = now();
    use(wanted);
    // Chromium keeps rendering a background tab differently — animations pause, some lazy content
    // never loads — so the tab the Bot is on is brought to the front as a person's would be.
    await wanted.bringToFront().catch(() => undefined);
    return tabs(botId);
  };

  return {
    owners,
    live,
    /** Whether this tab's renderer died. See `crashed`. */
    hasCrashed: (page: Page): boolean => crashed.has(page),
    isSpare,
    hear,
    died,
    pagesOf,
    own,
    touch,
    use,
    closeTabsOf,
    adoptOpened,
    tabs,
    cappedOf,
    listRead,
    switchTab,
  };
}
