import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@ag-ui/core";
import type { Source } from "../src/components/channels/sources";
import { ko } from "../src/lib/i18n-ko";
import { handleShellLinks } from "../src/lib/notifications/shell-links";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  removeAppDom,
} from "./support/app-router";
import { type Mounted, mount, unmountAll } from "./support/mount";
import { answered, asked, called, said } from "./support/step-fixtures";

/**
 * WHERE AN ANSWER CAME FROM IS A PILL AT THE END OF ITS WORDS.
 *
 * It was "출처 N개", a fold that opened to a list of links. The owner, 2026-10-04: "출처를 그렇게
 * 표시하지 마. 그냥 글 마지막에 pill형태로 표시하는거로 해. 출처가 여럿이면 첫번째 항목+n 식으로
 * 표시하고 클릭 시 새 탭에서 연다." Which answers have sources, and which pages they are, is
 * `answer-sources.test.ts`; this is what is drawn for them.
 *
 * happy-dom lays nothing out, so where the pills stand against the controls under an answer is
 * held here by the two classes that decide it; the boxes themselves were read in headless Chromium
 * and WebKit (`sources-row.tsx` has the numbers).
 */

/** What the shell was asked to open, and the way to take its listener down again. */
const handedOut: string[] = [];
let stopShell: (() => void) | null = null;

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  stopShell?.();
  stopShell = null;
  handedOut.length = 0;
  (globalThis as { __TAURI__?: unknown }).__TAURI__ = undefined;
  await unmountAll();
});
setDefaultTimeout(30_000);
afterAll(removeAppDom);

const STYLES = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");
/** One step of the theme's grid, in pixels: `h-6` is six of these. */
const GRID = Number(/--spacing:\s*(\d+)px;/.exec(STYLES)?.[1]);

/** What a spacing utility on an element comes to, in pixels: `sized("h", …)` of `h-6`. */
function sized(utility: string, classes: string): number | null {
  const found = classes
    .split(/\s+/)
    .map((name) => new RegExp(`^${utility}-(\\d+(?:\\.\\d+)?)$`).exec(name))
    .find((match) => match !== null);
  return found ? Number(found[1]) * GRID : null;
}

const NEWS: Source = {
  url: "https://news.naver.com/main/read?oid=001&aid=1",
  title: "내년도 최저임금 '1만 700원'으로 결정",
  host: "news.naver.com",
};
const BRIEFING: Source = {
  url: "https://www.korea.kr/news/policyNewsView.do?newsId=1",
  title: "2027년 적용 최저임금 고시",
  host: "korea.kr",
};
/** A page whose title the browser did not report: measured, a navigation often hands back none. */
const COUNCIL: Source = {
  url: "https://www.minimumwage.go.kr/",
  title: "",
  host: "minimumwage.go.kr",
};

/** The row on its own, and what is in it. */
async function row(sources: readonly Source[]) {
  const { SourcesRow } = await import("../src/components/channels/sources-row");
  const view = await mount(<SourcesRow sources={sources} />);
  return { view, ...drawnIn(view.host) };
}

/** What a sources row holds, read afresh each time: a press changes it. */
function drawnIn(within: Element) {
  const rows = () => [
    ...within.querySelectorAll<HTMLElement>('[data-testid="answer-sources"]'),
  ];
  return {
    rows,
    links: () =>
      rows().flatMap((found) => [
        ...found.querySelectorAll<HTMLAnchorElement>("a"),
      ]),
    buttons: () =>
      rows().flatMap((found) => [
        ...found.querySelectorAll<HTMLButtonElement>("button"),
      ]),
  };
}

/** Waits for something to be drawn: a look taken at once is taken too soon on a busy machine. */
async function until(view: Mounted, met: () => boolean, what: string) {
  const started = Date.now();
  while (!met()) {
    if (Date.now() - started > 8000) throw new Error(`never drawn: ${what}`);
    await view.settle(20);
  }
}

describe("an answer's sources", () => {
  test("one source is one pill, and the pill is the link to it in a new window", async () => {
    const { rows, links, buttons } = await row([NEWS]);

    expect(rows().length).toBe(1);
    expect(buttons().length).toBe(0);
    expect(
      links().map((link) => ({
        href: link.getAttribute("href"),
        target: link.getAttribute("target"),
        rel: link.getAttribute("rel"),
        says: link.textContent,
      })),
    ).toEqual([
      {
        href: NEWS.url,
        target: "_blank",
        rel: "noopener noreferrer",
        says: "Naver News",
      },
    ]);
  });

  test("three are the first and +2 — and a press on +2 draws all three as links, and the +2 goes", async () => {
    const { view, links, buttons } = await row([NEWS, BRIEFING, COUNCIL]);

    expect(links().map((link) => link.getAttribute("href"))).toEqual([
      NEWS.url,
    ]);
    expect(buttons().map((button) => button.textContent)).toEqual(["+2"]);
    // A button, and not one that sends a form it happens to be drawn in.
    expect(buttons()[0]?.getAttribute("type")).toBe("button");

    await view.press(buttons()[0] as HTMLButtonElement);

    expect(buttons().length).toBe(0);
    expect(
      links().map((link) => [
        link.getAttribute("href"),
        link.getAttribute("target"),
        link.getAttribute("rel"),
        link.textContent,
      ]),
    ).toEqual([
      [NEWS.url, "_blank", "noopener noreferrer", "Naver News"],
      [BRIEFING.url, "_blank", "noopener noreferrer", "korea.kr"],
      [COUNCIL.url, "_blank", "noopener noreferrer", "minimumwage.go.kr"],
    ]);
  });

  /*
   * The press removes the button it was made on. A control that goes while it has the focus hands
   * the focus to the page, and the next Tab begins at the top of the app.
   */
  test("the focus goes to the first pill the press drew, not to the page", async () => {
    const { view, links, buttons } = await row([NEWS, BRIEFING, COUNCIL]);
    const more = buttons()[0] as HTMLButtonElement;
    more.focus();
    expect(document.activeElement === more).toBe(true);

    await view.press(more);

    expect(document.activeElement?.getAttribute("href")).toBe(BRIEFING.url);
    expect(document.activeElement === links()[1]).toBe(true);
  });

  /*
   * WebKit, the installed app's engine on a Mac, leaves a link and a bare button out of Tab's path
   * unless they name a place in it. Pressed in headless WebKit against the running app: Tab from
   * the first pill went past the "+4" beside it to 복사.
   */
  test("the pill and the +n are both on Tab's path, in every engine", async () => {
    const { view, links, buttons } = await row([NEWS, BRIEFING, COUNCIL]);
    expect(links().map((link) => link.getAttribute("tabindex"))).toEqual(["0"]);
    expect(buttons().map((button) => button.getAttribute("tabindex"))).toEqual([
      "0",
    ]);
    await view.press(buttons()[0] as HTMLButtonElement);
    expect(links().map((link) => link.getAttribute("tabindex"))).toEqual([
      "0",
      "0",
      "0",
    ]);
  });

  test("two are the first and +1", async () => {
    const { links, buttons } = await row([NEWS, COUNCIL]);
    expect(links().length).toBe(1);
    expect(buttons().map((button) => button.textContent)).toEqual(["+1"]);
    expect(buttons()[0]?.getAttribute("aria-label")).toBe("Sources: 1 more");
  });

  test("with no sources nothing is drawn", async () => {
    const { view, rows } = await row([]);
    expect(rows().length).toBe(0);
    expect(view.host.innerHTML).toBe("");
  });
});

describe("what a pill is called", () => {
  test("the site as people name it, as a browsing task is — and the host where nobody has a name for it", async () => {
    const page = (host: string): Source => ({
      url: `https://${host}/a`,
      title: "",
      host,
    });
    const { view, links, buttons } = await row([
      page("news.naver.com"),
      // The most specific name wins, and a host under a named one counts.
      page("search.shopping.naver.com"),
      // A site a Bot signs in to, by the name the 연결 screen has for it.
      page("ceo.baemin.com"),
      page("minimumwage.go.kr"),
      // `sources.ts` hands the host over without its `www.`; one that kept it loses it here.
      page("www.example.org"),
    ]);
    await view.press(buttons()[0] as HTMLButtonElement);

    expect(links().map((link) => link.textContent)).toEqual([
      "Naver News",
      "Naver Shopping",
      "Baemin for Owners",
      "minimumwage.go.kr",
      "example.org",
    ]);
    // And in Korean those names are the ones people say.
    expect(ko["Naver News"]).toBe("네이버 뉴스");
    expect(ko["Naver Shopping"]).toBe("네이버 쇼핑");
  });

  test("says it is a source and that it opens in a new tab; the page's title is its description, where there is one", async () => {
    const { view, links, buttons } = await row([NEWS, COUNCIL]);
    await view.press(buttons()[0] as HTMLButtonElement);

    expect(
      links().map((link) => ({
        name: link.getAttribute("aria-label"),
        title: link.getAttribute("title"),
        hasTitle: link.hasAttribute("title"),
      })),
    ).toEqual([
      {
        name: "Source: Naver News, opens in a new tab",
        title: NEWS.title,
        hasTitle: true,
      },
      // No title reported: no empty tooltip, and nothing made up to fill it.
      {
        name: "Source: minimumwage.go.kr, opens in a new tab",
        title: null,
        hasTitle: false,
      },
    ]);
    // The globe is decoration: the name is the label's.
    expect(
      links().map((link) =>
        link.querySelector("svg")?.getAttribute("aria-hidden"),
      ),
    ).toEqual(["true", "true"]);
  });

  test("+n says how many more, to a screen reader and to a pointer", async () => {
    const { buttons } = await row([NEWS, BRIEFING, COUNCIL]);
    expect(buttons()[0]?.getAttribute("aria-label")).toBe("Sources: 2 more");
    expect(buttons()[0]?.getAttribute("title")).toBe("Sources: 2 more");
  });

  test("both names have Korean, and the fold's count is gone from the dictionary", () => {
    expect(ko["Source: {site}, opens in a new tab"]).toBe(
      "출처: {site}, 새 탭에서 열림",
    );
    expect(ko["Sources: {count} more"]).toBe("출처 {count}개 더");
    expect("{count} sources" in ko).toBe(false);
  });
});

describe("how a pill is drawn", () => {
  test("24px high, the link and the +n alike, in the small size", async () => {
    const { rows, links, buttons } = await row([NEWS, BRIEFING]);
    expect(GRID).toBe(4);
    const link = links()[0] as HTMLElement;
    const more = buttons()[0] as HTMLElement;
    expect(sized("h", link.className)).toBe(24);
    expect(sized("h", more.className)).toBe(24);
    expect(rows()[0]?.classList.contains("text-xs")).toBe(true);
    // One look: the +n has every class the link has, and one more.
    const extra = [...more.classList].filter(
      (name) => !link.classList.contains(name),
    );
    expect(extra).toEqual(["shrink-0"]);
    expect(
      [...link.classList].filter((name) => !more.classList.contains(name)),
    ).toEqual([]);
    expect(link.classList.contains("rounded-full")).toBe(true);
  });

  /*
   * NO FAVICON. A site's own icon is fetched from the site: every source's host would be called
   * from the person's device, for pages they have not chosen to open.
   */
  test("nothing in it is fetched from anywhere: one globe, drawn here, for every site", async () => {
    const { view, links, buttons } = await row([NEWS, BRIEFING, COUNCIL]);
    await view.press(buttons()[0] as HTMLButtonElement);
    expect(
      view.host.querySelectorAll(
        "img, picture, image, use, [src], [srcset], [style]",
      ).length,
    ).toBe(0);
    const globes = links().map(
      (link) => link.querySelector("svg")?.outerHTML ?? "",
    );
    expect(globes.length).toBe(3);
    expect(new Set(globes).size).toBe(1);
  });

  /*
   * "First +n" is read as one thing. Measured at 375px in headless Chromium with a host longer
   * than the phone is wide: on a row that wrapped, the pill took the line and the "+7" stood
   * alone on the next.
   */
  test("closed, the row is one line and it is the pill that gives way; opened, the pills wrap", async () => {
    const { view, rows, links, buttons } = await row([NEWS, BRIEFING, COUNCIL]);
    const classes = () => [...(rows()[0]?.classList ?? [])];
    expect(classes()).toContain("flex");
    expect(classes()).not.toContain("flex-wrap");
    // The pill may be cut off inside itself; the +n may not shrink.
    expect(links()[0]?.classList.contains("min-w-0")).toBe(true);
    expect(links()[0]?.classList.contains("max-w-full")).toBe(true);
    expect(
      links()[0]?.querySelector("span")?.classList.contains("truncate"),
    ).toBe(true);
    expect(buttons()[0]?.classList.contains("shrink-0")).toBe(true);

    await view.press(buttons()[0] as HTMLButtonElement);
    expect(classes()).toContain("flex-wrap");
  });
});

/*
 * THE INSTALLED APP HAS NO SECOND WINDOW. A `_blank` link opens nothing in a webview; the shell
 * hands it to the system's browser by a listener on the document that looks for an anchor
 * (`shell-links.test.ts`). So a pill has to be one — a press handler that opened the page itself
 * would open nothing in the app people install.
 */
function inShell(): void {
  (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: async (command: string, args: { url?: string }) => {
        if (command === "open_external" && args?.url) handedOut.push(args.url);
      },
    },
  };
  stopShell = handleShellLinks();
}

/** A press as the shell's listener meets one: on whatever is under the pointer, inside the pill. */
function pressOn(target: Element): boolean {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("a pill in the installed app", () => {
  test("a press on its words or its globe is handed to the system's browser", async () => {
    const { view, links, buttons } = await row([NEWS, BRIEFING, COUNCIL]);
    inShell();

    expect(pressOn(links()[0]?.querySelector("span") as Element)).toBe(true);
    expect(handedOut).toEqual([NEWS.url]);

    // The +n is the app's own: nothing leaves, and the rest are drawn.
    await view.press(buttons()[0] as HTMLButtonElement);
    expect(handedOut).toEqual([NEWS.url]);
    expect(links().length).toBe(3);

    expect(pressOn(links()[2]?.querySelector("svg") as Element)).toBe(true);
    expect(pressOn(links()[1] as Element)).toBe(true);
    expect(handedOut).toEqual([NEWS.url, COUNCIL.url, BRIEFING.url]);
  });
});

/** A search the turn made, as its call and its result sit in the conversation. */
const searched = (id: string, pages: readonly Source[]): Message[] => [
  called(id, "mcp__web-search__search"),
  answered(
    id,
    JSON.stringify({
      results: pages.map(({ url, title }) => ({ url, title, snippet: "…" })),
    }),
  ),
];

/** A transcript drawn on its own, as `plain-answer.test.tsx` draws one. */
async function transcript(messages: Message[], busy = false) {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { ChatTranscript } = await import(
    "../src/components/channels/chat-transcript"
  );
  const client = new QueryClient();
  const drawn = (isBusy: boolean) => (
    <QueryClientProvider client={client}>
      <ChatTranscript busy={isBusy} messages={messages} />
    </QueryClientProvider>
  );
  const view = await mount(drawn(busy));
  const rowOf = (id: string) =>
    view.host.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  const saidIn = (id: string) =>
    rowOf(id)?.querySelector('[data-slot="bubble-content"]')?.textContent ?? "";
  return {
    view,
    rowOf,
    saidIn,
    /** The same conversation with its turn over, or still going. */
    redraw: (isBusy: boolean) => view.render(drawn(isBusy)),
    sourcesOf: (id: string) => drawnIn(rowOf(id) ?? view.host),
  };
}

const TALK: Message[] = [
  asked("q-wage", "내년 최저임금 얼마야?"),
  ...searched("1", [NEWS, BRIEFING, COUNCIL]),
  said("answer-wage", "시간급 1만 700원이에요."),
  asked("q-thanks", "고마워"),
  said("answer-thanks", "별말씀을요."),
];

describe("the pills, in the conversation", () => {
  test("stand at the end of the answer's words, inside its wrapper, with the controls after them", async () => {
    const { view, rowOf, saidIn, sourcesOf } = await transcript(TALK);
    await until(
      view,
      () => saidIn("answer-thanks") === "별말씀을요.",
      "the conversation",
    );

    const { rows, links, buttons } = sourcesOf("answer-wage");
    expect(rows().length).toBe(1);
    expect(links().map((link) => link.textContent)).toEqual(["Naver News"]);
    expect(buttons().map((button) => button.textContent)).toEqual(["+2"]);

    // In the wrapper the controls hang from: the words, then the pills, then the controls.
    const wrapper = rowOf("answer-wage")?.querySelector(
      '[data-slot="message-arriving"]',
    );
    expect(
      [...(wrapper?.children ?? [])].map(
        (child) =>
          child.getAttribute("data-slot") ?? child.getAttribute("data-testid"),
      ),
    ).toEqual(["answer", "answer-sources", "reply-actions"]);

    /*
     * FROM THE WORDS' LEFT EDGE AND NO WIDER THAN THE WORDS: the answer's own measure, and nothing
     * that moves it sideways.
     */
    const measure = rowOf("answer-wage")?.querySelector('[data-slot="answer"]');
    const row = rows()[0] as HTMLElement;
    expect(sized("max-w", row.className)).toBe(
      sized("max-w", measure?.className ?? ""),
    );
    expect(sized("max-w", row.className)).toBe(680);
    expect(
      [...row.classList].filter((name) => /^-?(?:m[lrx]|p[lrx])-/.test(name)),
    ).toEqual([]);

    // An answer that read nothing has none.
    expect(sourcesOf("answer-thanks").rows().length).toBe(0);
    expect(view.host.querySelectorAll("details, summary").length).toBe(0);
  });

  /*
   * THE CONTROLS UNDER AN ANSWER ARE THERE WHETHER OR NOT THEY ARE DRAWN — `opacity: 0` takes
   * nothing out of the way of a press — and they are pulled up into the foot of the wrapper the
   * pills end. Laid out in headless Chromium and WebKit, 2026-10-04: the fold's "출처 3개" lost its
   * lowest 6px, across its first 52px, to 복사 and 더 보기. The room under the pills is what keeps
   * the two apart, so it may not be less than the pull.
   */
  test("keep, under them, at least the room the controls are pulled up by", async () => {
    const { view, rowOf, saidIn, sourcesOf } = await transcript(TALK);
    await until(
      view,
      () => saidIn("answer-thanks") === "별말씀을요.",
      "the conversation",
    );
    const row = sourcesOf("answer-wage").rows()[0] as HTMLElement;
    const controls = rowOf("answer-wage")?.querySelector(
      '[data-slot="reply-actions"]',
    );
    const pulledUp = [...(controls?.classList ?? [])]
      .map((name) => /^-mt-(\d+(?:\.\d+)?)$/.exec(name))
      .find((match) => match !== null);
    expect(Number(pulledUp?.[1]) * GRID).toBe(6);
    expect(sized("pb", row.className)).toBe(8);
    expect(sized("pb", row.className) ?? 0).toBeGreaterThanOrEqual(
      Number(pulledUp?.[1]) * GRID,
    );
  });

  /*
   * An answer still being written may yet read another page, and a "+2" that turned into "+3"
   * under it is a count nobody can trust (`unsettledFrom`).
   */
  test("are not drawn while the turn is still going, and are once it is over", async () => {
    const going = TALK.slice(0, 4);
    const { view, saidIn, sourcesOf, redraw } = await transcript(going, true);
    await until(
      view,
      () => saidIn("answer-wage") === "시간급 1만 700원이에요.",
      "the answer",
    );
    expect(sourcesOf("answer-wage").rows().length).toBe(0);

    await redraw(false);
    await until(
      view,
      () => sourcesOf("answer-wage").rows().length === 1,
      "the pills",
    );
    expect(
      sourcesOf("answer-wage")
        .buttons()
        .map((button) => button.textContent),
    ).toEqual(["+2"]);
  });
});
