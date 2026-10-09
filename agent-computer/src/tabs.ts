/**
 * A Bot's tabs in the deployment's one browser: how many it may hold, and how long they may sit
 * unused.
 */
import type { Page } from "playwright";
import { log } from "./log";
import { originOf } from "./navigation-guard";
import { titleOf } from "./page-text";
import { within } from "./within";

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
 * (`tests/tab-cap.test.ts`, run against the source as it was before this): one Bot, thirty opens —
 * twenty-seven `_blank` clicks and three `window.open` — and its tabs went 2, 3, 4 … 31, one more
 * for every open.
 *
 * WHAT A TAB COSTS, measured the same day in the stable image under `mem_limit: 3g`, on
 * news.naver.com: no browser 292 MiB and 19 processes; the browser and one tab 524 MiB and 87; five
 * tabs 1,082 MiB and 142; ten 1,724 MiB and 208 (1,752 MiB twenty seconds later). So 130–140 MiB and
 * 13–14 processes for every tab after the first, and about twenty such tabs is the whole container
 * — which Naver's results, each opening in a tab of its own, reach inside one long task.
 *
 * WHY SIX. What a task needs is small: a sign-in window and the page that opened it is two, a
 * payment window with its 본인인증 window and the page under them three — each kept by rule while
 * the window that reports to it is open (`keepToCap`), not by having been used lately — a list and
 * a handful of the pages off it five or six. Six heavy tabs is about 1.2 GiB with the process
 * around them, two fifths of the limit — room for pages twice as heavy, for the seventh tab that
 * exists for a moment before another is closed, and for a second Bot of a legacy account at its
 * own six (about 2 GiB together; five Bots all at six would be 4.4 GiB, and never fit before this
 * either).
 *
 * A CONSTANT, NOT A SETTING. The number follows from the image's memory limit and what a page
 * costs, both of which are this repository's; a deployment has no reason to hold another.
 */
export const TAB_CAP = 6;

/**
 * How many tabs a Bot holds when the ones over its cap may not go: past this, one of them goes
 * anyway.
 *
 * WHY THE CAP IS NOT ENOUGH. A tab an open window reports to is not closed for the cap
 * (`keepToCap`), and a window that opens a window that opens a window is a chain in which every
 * tab but the newest is reported to. The Bot is moved onto each as it opens, so none of them may
 * go: the first version with that rule (`1b230f33`) grew by one for every such window, with a
 * line saying so and no end but the container's memory. It needs no Bot to press anything — a
 * page's own script opens the first, each one's `onload` the next, and this browser blocks no
 * popup (Playwright's switches include `--disable-popup-blocking`) — and the idle close never
 * comes, because every adoption is the Bot's tabs being used.
 *
 * WHY TWELVE. By what a tab costs (above): ten heavy tabs measured 1,724 MiB, so twelve is about
 * 2.0 GiB, two thirds of the limit, and a legacy account's second Bot at its own six beside it is
 * eighteen tabs, about 2.8 GiB — which still fits. Nineteen is 2.9 GiB and twenty is the limit: a
 * Bot allowed thirteen leaves its neighbour no tab to spare, and one allowed fourteen does not
 * fit beside it. Twelve is also twice the cap, which is more than any chain a sign-in or a
 * payment needs — those are three or four windows deep.
 *
 * WHAT GOES. Never the tab the Bot is on, and never one a person or an ask holds. Of the rest,
 * the one used longest ago, whatever reports to it: in a chain that is its root, the page
 * furthest from where the Bot is.
 */
export const TAB_CEILING = 2 * TAB_CAP;

/** The shortest time between two lines of one kind about one Bot. See `say`. */
const LINE_MS = 60_000;

/**
 * How many closed tabs' sites are kept for a Bot that has not read its list since. The count of
 * them is exact however many go; the sites are the last few.
 */
const CLOSED_SITES_KEPT = 6;

/** How long the browser is given to say whether a new tab can report to the one that opened it. */
const REPORTS_WAIT_MS = 1_000;

/**
 * How long a tab may be nobody's before the idle sweep closes it.
 *
 * A tab is adopted on the browser's own `page` event, within one question to the browser of its
 * opening (`adoptOpened`), and a tab this process opens is claimed in the tick it exists
 * (`profiles.page`). A minute is some thousands of times that.
 *
 * COUNTED FROM THE SWEEP THAT FIRST FINDS THE TAB NOBODY'S, so a stray lives one to three minutes
 * from the moment it became one. The sweep comes once a minute (`IDLE_SWEEP_MS`), so it is first
 * seen up to a minute late; and the strays are looked at after that sweep has closed and waited
 * for the idle Bots' tabs (`profiles.closeIdle`), so two looks can be a little under a minute
 * apart — and then it is the look after that, two minutes on, that closes it.
 */
export const STRAY_GRACE_MS = 60_000;

/**
 * The tab a Bot was on, gone from under it: how, and which site it was showing — the origin only,
 * for the reason a log line carries no more (a path and a query are the page's).
 */
export type TabLost = {
  /** `values`: closed by this process, for what a person had put into it (`closeFor`). */
  cause: "crashed" | "closed" | "values";
  origin: string;
};

/** How long a tab is given to close when its closing is waited for. A healthy one takes a moment. */
const CLOSE_WAIT_MS = 5_000;

/**
 * The tabs of a Bot's closed to keep them to {@link TAB_CAP} since it last read its list: how many,
 * and the sites they were showing — origins only, as everywhere a tab is spoken of, each once, and
 * of the last few when many went ({@link CLOSED_SITES_KEPT}). Never the tab the Bot was on.
 */
type TabCapped = { closed: number; origins: string[] };

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
  /** The sites of the tabs closed for the cap and not yet read of, oldest first, one a close. */
  unread: string[];
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
  /**
   * Whether a tab a site opened can reach the window that opened it — the browser's own answer
   * (`canAccessOpener`), never the page's. See `openers`.
   */
  reportsToOpener: (page: Page) => Promise<boolean>;
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
   * The tabs this process is closing — for the cap, or for being nobody's — for as long as the
   * browser still lists them: let go of at once and closed a moment later, like a crashed one,
   * and like it never the spare a Bot is handed.
   */
  const closing = new WeakSet<Page>();

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

  /**
   * The tab each tab reports to: the one that opened it, where the new tab can reach it.
   *
   * NOT EVERY TAB THAT WAS OPENED BY ANOTHER. Playwright's `opener()` names the page a tab came
   * from, and names it for every tab alike. Measured 2026-10-05 on 1.62.1, a tab opened six ways:
   * `opener()` was the page for all six; `window.opener` in the new tab, and the browser's
   * `canAccessOpener` for it, were set for `window.open(url)`, `window.open(url, name, "popup")`
   * and `<a target=_blank rel=opener>`, and not for a plain `<a target=_blank>`, one with
   * `rel=noopener`, or `window.open(url, "_blank", "noopener")`. A sign-in window is the first
   * kind and hands its result to the page behind it. A result opened from a list is the second:
   * it has nothing to say to the list, and keeping every such page for the tab it opened would
   * keep a chain of them whole — a Bot reading one related article after another would have no
   * number at all.
   *
   * KEPT FROM THE MOMENT THE TAB IS ADOPTED, AND TAKEN BACK WHEN THE BROWSER SAYS NO. The answer
   * is a question to the browser, and a second tab can open while it is on its way: until it
   * comes the opener is kept, which costs a tab and breaks nothing.
   *
   * AN ANSWER THAT DID NOT COME IS ASKED FOR AGAIN, NOT TAKEN AS A YES FOR THE TAB'S LIFE. A
   * browser short of memory is the one that fails to answer, and the first version of this kept
   * such a tab's opener for ever: exactly when the cap mattered, a chain of plain `_blank`
   * results became a chain nothing could be closed from. So a tab whose answer never came is
   * remembered (`unanswered`) and asked about again each time its Bot is over its number, before
   * a tab is chosen to go — and at `TAB_CEILING` no opener is kept at all, answered or not.
   */
  const openers = new WeakMap<Page, Page>();

  /** The tabs the browser has not yet said of whether they can reach their opener. */
  const unanswered = new WeakSet<Page>();

  /** Ask the browser whether a tab reports to its opener, and keep the opener only on a yes. */
  const ask = async (page: Page): Promise<void> => {
    const reports = await within(
      REPORTS_WAIT_MS,
      browser.reportsToOpener(page),
    );
    if (reports === undefined) {
      unanswered.add(page);
      return;
    }
    unanswered.delete(page);
    if (!reports) openers.delete(page);
  };

  /** When the idle sweep first found each tab nobody's. See `closeStrays`. */
  const strays = new WeakMap<Page, number>();

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
    event:
      | "tab_crashed"
      | "tab_capped"
      | "tab_cap_exceeded"
      | "tab_ceiling_closed"
      | "tab_open_refused"
      | "tab_stray_closed",
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
      unread: [],
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
    !closing.has(page);

  /*
   * A BOT HOLDS `TAB_CAP` TABS, AND ONE IT HAS NOT USED FOR LONGEST MAKES ROOM FOR A NEW ONE.
   *
   * Asked whenever a tab becomes a Bot's that it did not have (`adoptOpened`, the one place a
   * Bot's tabs grow), so the new tab exists before the old one goes: closing first would close a
   * tab for a window that then never opened.
   *
   * WHICH TAB MAY NOT GO, whatever its place in the order:
   *
   *  - the tab the Bot is on. That would be the loss `tab-loss.ts` guards, done by this process;
   *  - a tab that an open tab of the Bot's reports to (`openers`). A sign-in window hands its
   *    result to the page that opened it, and a page closed behind its own window is a sign-in
   *    that lands nowhere. For as long as the window is open, and whichever tab the Bot is on —
   *    so a payment window, its 본인인증 window and the page under them are kept all the way up:
   *    each is open, and each reports to the one before it;
   *  - a tab somebody outside these books holds (`holds`): the one a person has the wheel of, the
   *    one a live screen is casting, the one a value or a hand was asked for on.
   *
   * So the tab that goes is the one used longest ago AMONG THOSE THAT MAY, which is not always the
   * one used longest ago of all. And there may be none: seven windows each opened from the one
   * before it, or everything held. Then nothing is closed — the Bot is over its number by the tab
   * that just opened, a line says so, and the next tab that opens asks again, closing as many as
   * it takes.
   *
   * UP TO `TAB_CEILING`, AND NO FURTHER. Past it a tab goes whatever reports to it: the one used
   * longest ago of every tab but the one the Bot is on and the ones that are held, said in a line
   * of its own (`tab_ceiling_closed`) and to the Bot as any tab closed for the cap is. A chain of
   * windows is trimmed from its root, one for each window that opens, and stays at the ceiling.
   * And when even that leaves nothing — every other tab held — the tab that is opening is not
   * taken at all (`adoptOpened`, `tab_open_refused`), so the ceiling is the most a Bot holds.
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
      const reportedTo = new Set(mine.map((page) => openers.get(page)));
      // What may go at all, and of that what nothing reports to.
      const may = mine.filter(
        (page) => page !== on && !browser.holds(botId, page),
      );
      const free = may.filter((page) => !reportedTo.has(page));
      const pastCeiling = free.length === 0 && mine.length > TAB_CEILING;
      const oldest = oldestOf(pastCeiling ? may : free);
      if (!oldest) {
        say("tab_cap_exceeded", botId, { tabs: mine.length, cap: TAB_CAP });
        return;
      }
      const origin = originOf(oldest.url());
      owners.delete(oldest);
      closing.add(oldest);
      // Counted with the closed one still in it: how many the Bot held when one had to go.
      if (pastCeiling) {
        say("tab_ceiling_closed", botId, {
          origin,
          tabs: mine.length,
          ceiling: TAB_CEILING,
        });
      } else {
        say("tab_capped", botId, { origin, tabs: mine.length });
      }
      closedFor(running, origin);
      void oldest.close().catch(() => undefined);
    }
  };

  /** The tab used longest ago of these, or none. */
  const oldestOf = (pages: Page[]): Page | undefined =>
    [...pages].sort(
      (one, other) => (used.get(one) ?? 0) - (used.get(other) ?? 0),
    )[0];

  /**
   * Close these tabs because of what was put into them — a person's value, in a run that has now
   * ended (`filled-values.ts`). Says whether every one of them is closed by the end.
   *
   * LET GO OF BEFORE CLOSED, like everything this process closes, so `own`'s listener does not
   * take the close for the site's. AND WAITED FOR, unlike the cap's: what the caller does next is
   * stop hiding what these pages held, and it may do that only once they are gone.
   *
   * SAID AS A LOSS, ONCE, whichever of them the Bot was on: the list its `computer_switch_tab`
   * index was read from is another list now, and its next look is told why (`tab-loss.ts`) rather
   * than left to find a page missing.
   */
  const closeFor = async (botId: string, pages: Page[]): Promise<boolean> => {
    const open = pages.filter((page) => !page.isClosed());
    const mine = open.filter((page) => owners.get(page) === botId);
    const told = mine.find((page) => isOn(botId, page)) ?? mine[0];
    const origin = told ? originOf(told.url()) : undefined;
    for (const page of mine) owners.delete(page);
    for (const page of open) closing.add(page);
    if (origin !== undefined)
      browser.onLost(botId, { cause: "values", origin });
    await Promise.all(
      open.map((page) =>
        within(
          CLOSE_WAIT_MS,
          page.close().catch(() => undefined),
        ),
      ),
    );
    return pages.every((page) => page.isClosed());
  };

  /** Count a tab closed for the cap against the list the Bot last read, with the site it showed. */
  const closedFor = (running: Live, origin: string): void => {
    running.capped += 1;
    running.unread.push(origin);
    if (running.unread.length > CLOSED_SITES_KEPT) running.unread.shift();
  };

  /**
   * Whether a Bot at the ceiling could still be brought back to it if it took one more tab: there
   * is a tab besides the one it is on that nobody holds. Below the ceiling there is always room.
   */
  const hasRoom = (botId: string): boolean => {
    const mine = pagesOf(botId);
    if (mine.length < TAB_CEILING) return true;
    const on = live.get(botId)?.page;
    return mine.some((page) => page !== on && !browser.holds(botId, page));
  };

  /*
   * A TAB THAT IS NOBODY'S IS CLOSED ONCE IT HAS BEEN NOBODY'S FOR A MINUTE.
   *
   * Every count above is of a Bot's tabs, and some tabs are no Bot's: one whose opener had closed
   * before the browser could say who opened it, one the browser opened by itself, and anything
   * such a tab goes on to open (`adoptOpened` hands a tab to the Bot its opener belongs to, and
   * that opener belongs to nobody). No list shows them, no cap counts them and no idle close
   * reaches them, so they stayed for as long as any Bot had a tab — the same leak, by another door.
   *
   * ON THE IDLE SWEEP, AND ONLY AFTER {@link STRAY_GRACE_MS}: a tab is nobody's for a moment on
   * its way to being somebody's, and that moment must never be the one it is closed in. So a sweep
   * that finds a tab nobody's writes down when, a sweep that finds it owned forgets it, and only
   * one that finds it still nobody's a minute on closes it.
   *
   * NEVER THE LAST TAB THE BROWSER LISTS. A browser's one remaining tab that is nobody's is the
   * spare a Bot with no tab is handed (`profiles.page`), and this must not fight that: closing it
   * would only have the next call open another. When nobody has a tab at all it is the browser
   * that goes, and that is the idle close's own work. "Lists" is what is counted (`left`): a tab
   * already asked to close and not yet gone — a crashed one, one closed for the cap — is still
   * listed, so a stray beside only such a tab is closed, and the next Bot opens a tab instead of
   * being handed one.
   *
   * A tab this process has already let go of — its renderer dead, or closed for the cap — has
   * been asked to close and is not asked again. One bounded line, by the tab's origin only.
   */
  const closeStrays = (): number => {
    const open = browser.pages().filter((page) => !page.isClosed());
    let left = open.length;
    let closed = 0;
    for (const page of open) {
      if (owners.has(page)) {
        strays.delete(page);
        continue;
      }
      if (crashed.has(page) || closing.has(page)) continue;
      const since = strays.get(page);
      if (since === undefined) {
        strays.set(page, now());
        continue;
      }
      if (now() - since < STRAY_GRACE_MS || left <= 1) continue;
      left -= 1;
      closed += 1;
      // Never the spare from here on, like every tab this process is closing.
      closing.add(page);
      say("tab_stray_closed", undefined, {
        origin: originOf(page.url()),
        pages: open.length,
      });
      void page.close().catch(() => undefined);
    }
    return closed;
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
      /*
       * AT THE CEILING WITH NOTHING THAT MAY GO, THE TAB IS NOT TAKEN. Every other tab the Bot
       * has is held by a person or an ask, and taking this one would put the Bot past the most it
       * may hold with no way back. Closed before it is the Bot's, so the Bot is still on the tab
       * it was on and has lost nothing; counted like a tab closed for the cap, so the Bot's next
       * list says a tab was closed, and which site's.
       */
      const running = live.get(botOf);
      if (running && !hasRoom(botOf)) {
        const origin = originOf(opened.url());
        closing.add(opened);
        say("tab_open_refused", botOf, {
          origin,
          tabs: pagesOf(botOf).length,
          ceiling: TAB_CEILING,
        });
        closedFor(running, origin);
        void opened.close().catch(() => undefined);
        return;
      }
      own(botOf, opened);
      if (opener) openers.set(opened, opener);
      touch(botOf, opened);
      browser.onPage(botOf, opened);
      /*
       * AFTER THE TAB IS THE BOT'S, NOT BEFORE: a Bot's next look must find it on the tab its
       * click opened (`actions.ts`, `POPUP_GRACE_MS`), and this is one more question to the
       * browser. Only a plain no takes the opener back — see `openers`.
       */
      if (opener) await ask(opened);
      // Over its number: the tabs whose answer never came are asked about again, together,
      // before one is chosen to go (`unanswered`).
      const mine = pagesOf(botOf);
      if (mine.length > TAB_CAP) {
        await Promise.all(
          mine
            .filter((page) => page !== opened && unanswered.has(page))
            .map(ask),
        );
      }
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
   *
   * EVERY ONE OF THEM, NOT THE LAST. Two tabs can go between two looks — a page that opens two
   * windows, a person with the wheel pressing two links — and a Bot told of one would look for
   * the other. A tab closed after this list was read is not in it: it is left for the next.
   */
  const listRead = (botId: string, capped: number): TabCapped | undefined => {
    const running = live.get(botId);
    if (!running || capped <= running.listed || capped > running.capped) {
      return undefined;
    }
    const closed = capped - running.listed;
    const later = running.capped - capped;
    const read = running.unread.length - later;
    const origins = [...new Set(running.unread.slice(0, Math.max(0, read)))];
    running.unread = running.unread.slice(Math.max(0, read));
    running.listed = capped;
    return { closed, origins };
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
    closeFor,
    closeStrays,
    adoptOpened,
    tabs,
    cappedOf,
    listRead,
    switchTab,
  };
}
