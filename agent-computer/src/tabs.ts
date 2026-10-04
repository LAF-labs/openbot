/**
 * A Bot's tabs in the deployment's one browser, and how long they may sit unused.
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

/** The shortest time between two `tab_crashed` lines about one Bot. See `sayCrashed`. */
const CRASH_LINE_MS = 60_000;

/**
 * The tab a Bot was on, gone from under it: how, and which site it was showing — the origin only,
 * for the reason a log line carries no more (a path and a query are the page's).
 */
export type TabLost = { cause: "crashed" | "closed"; origin: string };

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

  /** Each Bot's current tab, and when it last did anything. See IDLE_CLOSE_MS. */
  const live = new Map<string, { page: Page; usedAt: number; since: string }>();

  /**
   * The tabs whose renderer died, for as long as the browser still lists them.
   *
   * A crashed tab is let go of at once and closed a moment later, and in that moment — or for
   * ever, when the close never comes back — it is open and nobody's: exactly what a Bot with no tab
   * is handed as the spare (`profiles.page`). Asked there, so no Bot is handed a dead tab, and by
   * `/navigate`, to tell a renderer that died from a site that would not answer.
   */
  const crashed = new WeakSet<Page>();

  /** This Bot's open tabs, in the browser's own order. */
  const pagesOf = (botId: string): Page[] =>
    browser
      .pages()
      .filter((page) => !page.isClosed() && owners.get(page) === botId);

  /** Whether this is the tab the Bot's next call would have landed on. */
  const isOn = (botId: string, page: Page): boolean =>
    live.get(botId)?.page === page;

  /** When each Bot's last `tab_crashed` line was written, and how many deaths since went unsaid. */
  const lines = new Map<string, { at: number; unsaid: number }>();

  /**
   * One line for a renderer that died, by the site's origin only — a path, a query and a title
   * are the page's — and no more than one a minute for a Bot.
   *
   * BOUNDED, BECAUSE A LOOP IS POSSIBLE. A dead tab is replaced by an empty one, which has nothing
   * to die of; but a machine too short of memory to keep any renderer loses the replacement too,
   * and while a person has the live screen open a replacement is asked for every second
   * (`live-screen.ts`). That is a line a second for as long as it lasts. The ones not written are
   * counted on the next one that is.
   */
  const sayCrashed = (
    botId: string | undefined,
    origin: string,
    tabs: number,
  ): void => {
    const key = botId ?? "";
    const last = lines.get(key);
    if (last && now() - last.at < CRASH_LINE_MS) {
      last.unsaid += 1;
      return;
    }
    log.warn("tab_crashed", {
      ...(botId ? { bot: botId } : {}),
      origin,
      tabs,
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
      sayCrashed(undefined, origin, 0);
    } else {
      // Counted with the dead one still in it: how many tabs the Bot was holding when it died.
      const had = pagesOf(botId).length;
      const wasOn = isOn(botId, page);
      owners.delete(page);
      sayCrashed(botId, origin, had);
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
   * closes it lets go of first — a stop, a tab replaced after a deadline, a dead renderer, the
   * browser itself. So when the tab the Bot was ON closes that way, the Bot is somewhere it has
   * not looked, exactly as when its renderer dies, and whoever keeps the Bot's session is told the
   * same thing (`onLost`).
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
    const existing = live.get(botId);
    live.set(botId, {
      page,
      usedAt: now(),
      since: existing?.since ?? new Date().toISOString(),
    });
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
      touch(botOf, opened);
      browser.onPage(botOf, opened);
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

  /** Move the Bot to one of them. Refuses an index that names nothing rather than picking one. */
  const switchTab = async (
    botId: string,
    index: number,
  ): Promise<TabSummary[]> => {
    const running = live.get(botId);
    if (!running) {
      throw new TabError("laf:tab_missing");
    }
    const wanted = pagesOf(botId)[index];
    if (!wanted) {
      throw new TabError("laf:tab_missing");
    }
    running.page = wanted;
    running.usedAt = now();
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
    hear,
    died,
    pagesOf,
    own,
    touch,
    closeTabsOf,
    adoptOpened,
    tabs,
    switchTab,
  };
}
