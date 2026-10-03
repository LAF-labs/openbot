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
import { toolErrorText } from "@shared/tools/step-result";
import type { StandingFailure } from "../src/lib/channels/retry";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import { mount, unmountAll } from "./support/mount";
import {
  ASKED,
  answered,
  asked,
  called,
  done,
  said,
} from "./support/step-fixtures";
import {
  installTurnStreams,
  removeTurnStreams,
  turnServer,
} from "./support/turn-server";

/**
 * THE BOT'S ANSWER IS WORDS ON THE PAGE: NO PLATE, ONE READING COLUMN, AND TWO CONTROLS UNDER IT.
 *
 * The owner, 2026-10-04, looking at the app beside Grok Bot and Muse: it shows far too many words.
 * Of the mock-ups for the conversation the choice was "proposal A". The steps of work had gone the
 * same day (`step-fold.test.tsx`); this is how the answer itself is drawn. Until now it was a grey
 * bubble with five controls under it, in a transcript the width of the pane.
 *
 * happy-dom lays nothing out and reads no stylesheet, so what is held here is what decides the
 * layout: which element the words are in, the classes on it, and that the transcript and the
 * composer are given the same column. The sizes those classes come to are worked out from the
 * theme's own grid (`--spacing`), read from the stylesheet. None of it was looked at in a browser.
 *
 * The menu the second control opens is pressed in a process of its own, where it can be opened
 * (`step-fold.test.tsx`, `answer-rating-render.test.ts`).
 */

beforeAll(async () => {
  await installAppDom();
  installTurnStreams();
}, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
  await unmountAll();
});
setDefaultTimeout(30_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

const STYLES = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");
/** One step of the theme's grid, in pixels: `max-w-180` is 180 of these. */
const GRID = Number(/--spacing:\s*(\d+)px;/.exec(STYLES)?.[1]);

/** What a spacing utility on an element comes to, in pixels: `sized("max-w", …)` of `max-w-180`. */
function sized(utility: string, classes: string): number | null {
  const found = classes
    .split(/\s+/)
    .map((name) => new RegExp(`^${utility}-(\\d+(?:\\.\\d+)?)$`).exec(name))
    .find((match) => match !== null);
  return found ? Number(found[1]) * GRID : null;
}

/** The classes on an element that would draw a plate round what is in it, or pad one. */
const plate = (element: Element | null | undefined) =>
  [...(element?.classList ?? [])].filter((name) =>
    /^(?:bg-|rounded|border|shadow|ring|p[xytrbl]?-)/.test(name),
  );

/** A transcript drawn on its own, as `copied-reply.test.tsx` draws one. */
async function transcript(
  messages: Message[],
  options: {
    channelId?: string;
    failures?: Record<string, StandingFailure>;
  } = {},
) {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { ChatTranscript } = await import(
    "../src/components/channels/chat-transcript"
  );
  const { answerRatingKeys } = await import(
    "../src/lib/support/answer-ratings"
  );
  const client = new QueryClient();
  // What the server holds for the conversation, already read: nothing rated yet.
  if (options.channelId) {
    client.setQueryData(answerRatingKeys.channel(options.channelId), {});
  }
  const view = await mount(
    <QueryClientProvider client={client}>
      <ChatTranscript busy={false} messages={messages} {...options} />
    </QueryClientProvider>,
  );
  await view.settle(120);
  const rowOf = (id: string) =>
    view.host.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  return {
    view,
    rowOf,
    /** The words of a row: the same element on both sides, by the name 복사 finds it by. */
    wordsOf: (id: string) =>
      rowOf(id)?.querySelector<HTMLElement>('[data-slot="bubble-content"]') ??
      null,
    /** The names of the controls under a row, in order. */
    controlsOf: (id: string) =>
      [
        ...(rowOf(id)?.querySelectorAll<HTMLButtonElement>(
          '[data-slot="reply-actions"] button',
        ) ?? []),
      ].map((button) => button.getAttribute("aria-label") ?? ""),
  };
}

const TALK: Message[] = [
  asked("q-1", "오늘 날씨 어때?"),
  said("a-1", "춘천은 **구름 많고** 18도예요."),
];

describe("the Bot's answer", () => {
  test("is words on the page, with no plate round them — and the person's message still has its bubble", async () => {
    const { wordsOf } = await transcript(TALK);

    const answer = wordsOf("a-1");
    expect(answer?.textContent).toBe("춘천은 구름 많고 18도예요.");
    // In no bubble at all: it was `data-variant="agent"`, the grey one.
    expect(answer?.closest('[data-slot="bubble"]') === null).toBe(true);
    const measure = answer?.closest('[data-slot="answer"]');
    expect(plate(measure)).toEqual([]);
    /*
     * A colour of its own, as the bubble gave it one. Inherited, it came through the row, whose
     * colours are on a 700ms transition: laid out in headless Chromium and WebKit with the theme
     * switched, the answer's words were the old theme's ink on the new theme's page for most of
     * a second.
     */
    expect(measure?.classList.contains("text-foreground")).toBe(true);
    /*
     * The one padding on the words is not a plate's: 4px either side, taken back out by a margin
     * of the same 4px, so that what is cut off at the sides (a formula wider than a phone) is cut
     * off beyond a focus ring and not at the letters. The words begin at the column's own edge.
     */
    expect(plate(answer)).toEqual(["px-1"]);
    expect(answer?.classList.contains("-mx-1")).toBe(true);
    expect(sized("px", answer?.className ?? "")).toBe(4);
    expect(answer?.classList.contains("overflow-x-clip")).toBe(true);

    const said = wordsOf("q-1");
    const bubble = said?.closest('[data-slot="bubble"]');
    expect(bubble?.getAttribute("data-variant")).toBe("user");
    expect(bubble?.getAttribute("data-align")).toBe("end");
    expect(bubble?.className).toContain("bg-bubble-user");
    expect(plate(said)).toEqual(
      expect.arrayContaining(["rounded-3xl", "px-3", "py-2"]),
    );
  });

  test("is 680px across at most — a little inside the column — and the whole row where the row is narrower", async () => {
    const { wordsOf } = await transcript(TALK);
    const measure = wordsOf("a-1")?.closest('[data-slot="answer"]');
    const classes = measure?.className ?? "";
    expect(sized("max-w", classes)).toBe(680);
    expect(classes.split(/\s+/)).toContain("w-full");
    // The same at every width: nothing on it waits for a breakpoint.
    expect(classes.split(/\s+/).filter((name) => name.includes(":"))).toEqual(
      [],
    );
  });

  test("that a failed turn got half of out is faded and says it is only that", async () => {
    const { rowOf, wordsOf } = await transcript(TALK, {
      failures: { "a-1": { code: "laf:turn_unreachable", askedId: "q-1" } },
    });
    const measure = wordsOf("a-1")?.closest('[data-slot="answer"]');
    expect(measure?.classList.contains("opacity-60")).toBe(true);
    expect(rowOf("a-1")?.textContent).toContain("Received up to here");
    // And a whole one is neither.
    const whole = await transcript(TALK);
    expect(
      whole
        .wordsOf("a-1")
        ?.closest('[data-slot="answer"]')
        ?.classList.contains("opacity-60"),
    ).toBe(false);
    expect(whole.rowOf("a-1")?.textContent).not.toContain(
      "Received up to here",
    );
  });
});

/*
 * THE RHYTHM, WITHOUT THE PLATE. The rows are spaced by their own padding. A bubble's 8px of
 * padding stood between the Bot's words and everything round them; with the bubble gone the row
 * carries it, so two answers of one turn are a paragraph's distance apart and read as one block,
 * and an answer is not drawn hard under the person's bubble.
 */
describe("the space round an answer", () => {
  test("an answer's row carries the plate's 8px; the person's rows are as they were", async () => {
    const { rowSpacing } = await import(
      "../src/components/channels/chat-transcript"
    );
    // The person's side: 2px above and below, 12px above the first of a run.
    expect(rowSpacing("user", true)).toBe("py-0.5");
    expect(rowSpacing("user", false)).toBe("py-0.5 pt-3");
    // The Bot's: 8px above and below, and the 12 and the 8 above the first of a run.
    expect(sized("py", rowSpacing("assistant", true))).toBe(8);
    expect(sized("py", rowSpacing("assistant", false))).toBe(8);
    expect(sized("pt", rowSpacing("assistant", false))).toBe(20);
    expect(sized("pt", rowSpacing("assistant", true))).toBeNull();
  });

  test("in the conversation: clear of the person's bubble on both sides, and two answers of a turn a paragraph apart", async () => {
    const { rowOf } = await transcript([
      asked("q-1", "오늘 일정 알려줘"),
      said("a-1", "오전에 회의가 하나 있어요."),
      said("a-2", "오후는 비어 있어요."),
      asked("q-2", "고마워"),
      asked("q-3", "내일은?"),
    ]);
    const spacing = (id: string) =>
      [...(rowOf(id)?.classList ?? [])].filter((name) => /^p[tby]-/.test(name));
    expect(spacing("q-1")).toEqual(["py-0.5", "pt-3"]);
    // 2px under the question and 20px over the answer: where the plate's top edge used to help.
    expect(spacing("a-1")).toEqual(["py-2", "pt-5"]);
    // 8px under one and 8px over the next: the 16px the renderer puts between two paragraphs.
    expect(spacing("a-2")).toEqual(["py-2"]);
    // 8px under the answer and the person's own 12px.
    expect(spacing("q-2")).toEqual(["py-0.5", "pt-3"]);
    expect(spacing("q-3")).toEqual(["py-0.5"]);
  });

  test("the corners that join a run are the person's bubbles' alone", async () => {
    const { wordsOf, view } = await transcript([
      asked("q-1", "오늘 일정 알려줘"),
      asked("q-2", "아, 내일 것도"),
      said("a-1", "오전에 회의가 하나 있어요."),
      said("a-2", "오후는 비어 있어요."),
    ]);
    const joined = (id: string) => {
      const bubble = wordsOf(id)?.closest('[data-slot="bubble"]');
      return {
        prev: bubble?.hasAttribute("data-joined-prev") === true,
        next: bubble?.hasAttribute("data-joined-next") === true,
      };
    };
    expect(joined("q-1")).toEqual({ prev: false, next: true });
    expect(joined("q-2")).toEqual({ prev: true, next: false });
    // Two bubbles in the whole conversation, and neither is the Bot's.
    expect(view.host.querySelectorAll('[data-slot="bubble"]').length).toBe(2);
    expect(
      view.host.querySelectorAll("[data-joined-prev], [data-joined-next]")
        .length,
    ).toBe(2);
  });
});

describe("the controls under an answer", () => {
  test("are two — 복사 and 더 보기 — where the answer can be quoted and rated, and under the person's message none", async () => {
    const { controlsOf, rowOf } = await transcript(TALK, {
      channelId: "channel_plain",
    });
    expect(controlsOf("a-1")).toEqual(["Copy this reply", "More"]);
    expect(controlsOf("q-1")).toEqual([]);
    // Nothing of the five there were is left in the row itself.
    expect(rowOf("a-1")?.querySelectorAll("button").length).toBe(2);
  });

  test("are two where all the menu holds is what the Bot did, and 복사 alone where it would hold nothing", async () => {
    // No conversation to quote into or rate in — the compose screen — so the record is all there is.
    const { controlsOf } = await transcript([
      ASKED,
      ...done("1"),
      said("a-steps", "한 통 와 있어요."),
      asked("q-2", "고마워"),
      said("a-bare", "별말씀을요."),
    ]);
    expect(controlsOf("a-steps")).toEqual(["Copy this reply", "More"]);
    // A menu with nothing in it would be a control that does nothing: it is not drawn.
    expect(controlsOf("a-bare")).toEqual(["Copy this reply"]);
  });

  /*
   * A FAILED STEP IS BEHIND THE SECOND CONTROL. A step that did not work is put away like any
   * other, and the icon that opened the record said so in its colour and its name. That icon is a
   * row of the menu now, so the button the menu hangs from says it.
   */
  test("the second is in the warning colour, and says so in its name, where a step did not work", async () => {
    const { rowOf } = await transcript([
      ASKED,
      ...done("1"),
      called("2"),
      answered("2", toolErrorText("quota exceeded")),
      said("a-failed", "두 번째는 안 됐어요."),
      asked("q-2", "다시 해 줘"),
      ...done("3"),
      said("a-worked", "이번엔 됐어요."),
    ]);
    const more = (id: string) =>
      rowOf(id)?.querySelector<HTMLButtonElement>(
        '[data-slot="answer-more"] button',
      );
    const told = (id: string) => ({
      name: more(id)?.getAttribute("aria-label"),
      // What a pointer is told on hover is the same.
      title: more(id)?.getAttribute("title"),
      warns: more(id)?.classList.contains("text-warning"),
      muted: more(id)?.classList.contains("text-muted-foreground"),
      // An icon and nothing else.
      text: more(id)?.textContent,
      opensAMenu: more(id)?.getAttribute("aria-haspopup"),
    });
    expect(told("a-failed")).toEqual({
      name: "More. A step did not work",
      title: "More. A step did not work",
      warns: true,
      muted: false,
      text: "",
      opensAMenu: "menu",
    });
    expect(told("a-worked")).toEqual({
      name: "More",
      title: "More",
      warns: false,
      muted: true,
      text: "",
      opensAMenu: "menu",
    });
  });

  test("the name that says a step did not work has Korean", async () => {
    const { ko } = await import("../src/lib/i18n-ko");
    expect(ko["More. A step did not work"]).toBe("더 보기 · 안 된 단계 있음");
    expect(ko.More).toBe("더 보기");
  });
});

/*
 * ONE READING COLUMN. The transcript was the width of the pane ("the bubble caps its own measure,
 * so the column does not need to") and the composer with it. Words with no plate have no measure
 * of their own, so the column is back — and the composer is in it, because the box a person types
 * into has to sit under the width it types into.
 */
describe("the one reading column", () => {
  test("is 720px across with its 16px each side inside it, and the same at every width", async () => {
    const { readingColumn } = await import(
      "../src/components/channels/reading-column"
    );
    expect(GRID).toBe(4);
    expect(sized("max-w", readingColumn)).toBe(720);
    expect(sized("px", readingColumn)).toBe(16);
    const names = readingColumn.split(" ");
    // Centred, and the whole width — with that same 16px — where the window is narrower.
    expect(names).toContain("mx-auto");
    expect(names).toContain("w-full");
    // Nothing in it waits for a breakpoint: below 720px it is what a phone drew before.
    expect(names.filter((name) => name.includes(":"))).toEqual([]);
  });

  test("holds the conversation's rows, its greeting and the composer, edge for edge", async () => {
    const { readingColumn } = await import(
      "../src/components/channels/reading-column"
    );
    const channelId = "channel_plain-column";
    const server = turnServer({ channelId, history: [ASKED, ...TALK] });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.waitFor(
      () =>
        view.host
          .querySelector('[role="log"]')
          ?.textContent?.includes(String(ASKED.content)) === true,
      "the conversation",
      8000,
    );

    const rows = view.host.querySelector<HTMLElement>(
      '[data-slot="message-scroller-content"]',
    );
    const typing = view.host.querySelector<HTMLElement>(
      '[data-slot="composer-column"]',
    );
    /** The widths an element is given: its cap, its side padding, and whether it is centred. */
    const width = (element: Element | null) =>
      [...(element?.classList ?? [])]
        .filter((name) => /^(?:max-w-|w-|mx-|px-|pl-|pr-)/.test(name))
        .sort();
    const column = readingColumn.split(" ").sort();
    // It was `max-w-none` on the rows and no cap at all on the composer.
    expect(width(rows)).toEqual(column);
    expect(width(typing)).toEqual(column);

    // The composer fills the column it is in.
    const composer = typing?.querySelector('[data-testid="composer"]');
    expect(composer?.parentElement?.classList.contains("w-full")).toBe(true);
    expect(composer?.parentElement?.parentElement === typing).toBe(true);

    /*
     * AND THE TWO COLUMNS ARE CUT FROM THE SAME WIDTH: the composer's is a child of the box the
     * transcript fills, and nothing between that box and the rows caps or pads them.
     *
     * One thing between them can still differ, and is not a class anybody chose here: the
     * transcript scrolls, and its viewport keeps room for a scrollbar (`scrollbar-gutter-stable`).
     * Where scrollbars are drawn over the page — a Mac by default, every phone — that room is
     * nothing and the two are edge for edge. Where a scrollbar takes width, the rows are centred
     * in a box that much narrower than the composer's. That was so before the column, too.
     */
    const pane = typing?.parentElement ?? null;
    expect(pane?.contains(rows) === true).toBe(true);
    const between: string[] = [];
    for (
      let box = rows?.parentElement ?? null;
      box && box !== pane;
      box = box.parentElement
    ) {
      between.push(...width(box).filter((name) => !/^w-full$/.test(name)));
    }
    expect(between).toEqual([]);

    // The greeting is the top of the same conversation, and is in the same column.
    const greeting = view.host.querySelector("[data-greeting]");
    expect(greeting !== null).toBe(true);
    const viewport = rows?.parentElement ?? null;
    const head = [...(viewport?.children ?? [])].find((child) =>
      child.contains(greeting),
    );
    expect(width(head ?? null)).toEqual(column);

    server.close();
    await view.unmount();
  });
});
