/**
 * AN ANSWER'S "MORE" MENU, OPENED AND PRESSED THE WAY A PERSON PRESSES IT — IN A PROCESS OF ITS OWN.
 *
 * WHY NOT IN THE SUITE'S PROCESS. What the Bot did for an answer is opened from the answer's menu
 * (`answer-more.tsx`), and the menu is Base UI's. Base UI decides once, when it is first evaluated,
 * whether there is a document — its layout effect is React's, or nothing — and `bun test` shares
 * one module registry across every file. A file that pulled it in before any DOM existed leaves
 * every file after it with menus that do not open. Measured 2026-10-04 on the mounted app: the
 * sidebar's two menus opened with their rows when the file ran alone; after `account-copy.test.ts`
 * (a route module, and it sorts first) in the same process, a press on either left `aria-expanded`
 * unset and drew nothing. `confirm-dialog.test.tsx` records the same wall for the dialog. Here the
 * DOM is registered before any app module is imported.
 *
 * ONE PROCESS FOR ALL OF THEM. Each scenario is one conversation of `step-fold.test.tsx`: mounted,
 * pressed, and what the screen showed written down at each point. The test file runs this once and
 * holds each scenario to what it wrote down. Importing the route tree takes six seconds; that is
 * paid here once, not once a scenario.
 *
 * A scenario that fails says so in its own entry (`error`) with whatever it had seen by then, and
 * the ones after it still run: one red test, not every one.
 *
 * Prints one line, `STEPS_RENDER <json>`. Not a test file (no `.test.` in the name), so the runner
 * never collects it on its own. Named scenarios only, to try one:
 *
 *     bun app/tests/support/steps-render.tsx record failed
 */
import type { Message } from "@ag-ui/core";
import { toolErrorText } from "@shared/tools/step-result";
import {
  type ApiRequest,
  installAppDom,
  json,
  mountApp,
  unmountApps,
} from "./app-router";
import {
  ASKED,
  answered,
  asked,
  called,
  done,
  MAIL_WITH_A_CODE,
  said,
  talk,
} from "./step-fixtures";
import { acted, installTurnStreams, turnServer } from "./turn-server";

/** What the screen showed at one moment. */
export type Frame = {
  /** The rows drawn, by the id of the message each is, in order. */
  rows: string[];
  /** How many step lines of the stand-in tool are drawn. */
  lines: number;
  /** Under each answer that has a row of controls: their names, in order. */
  controls: Record<string, string[]>;
  /** The answers whose "more" button is drawn in the warning colour. */
  warned: string[];
};

/** One row of an answer's menu. */
export type Entry = {
  name: string;
  /** `menuitem`, or `menuitemradio` for the two a rating is chosen from. */
  role: string;
  /** Drawn as the chosen one. */
  checked: boolean;
  /** Its icon is in the warning colour. */
  warns: boolean;
};

/** What one scenario saw, by the name it gave each moment. */
export type Seen = {
  frames: Record<string, Frame>;
  /** An answer's menu as it read when it was opened. Empty where the answer has no "more". */
  menus: Record<string, Entry[]>;
  notes: Record<string, string | number | boolean | null>;
  /** The scenario stopped here, and what is above is as far as it got. */
  error?: string;
};

export type StepsShown = Record<string, Seen>;

process.env.NODE_ENV = "test";
await installAppDom();
installTurnStreams();

const body = document.body;
const log = () => body.querySelector('[role="log"]');
const linesDrawn = () =>
  (log()?.textContent ?? "").split("Used a connected service").length - 1;
const rowsDrawn = () =>
  [...(log()?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])].map(
    (row) => row.dataset.messageId ?? "",
  );
const drawn = () => rowsDrawn().join(" ");
const rowOf = (messageId: string) =>
  log()?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`) ?? null;
/** The "more" button under an answer: the one control of its row that opens a menu. */
const moreUnder = (answerId: string) =>
  rowOf(answerId)?.querySelector<HTMLButtonElement>(
    '[data-slot="reply-actions"] [data-slot="dropdown-menu-trigger"]',
  ) ?? null;
/** The menu that is open. Drawn in the document's body, not in the row it was opened from. */
const menu = () => body.querySelector('[data-slot="dropdown-menu-content"]');
/**
 * Whether an answer's row of controls is being held up (`data-lingering`): it is drawn only while
 * the pointer is over the answer, and the stylesheet keeps it up for as long as something in it
 * says this.
 */
const heldUp = (answerId: string) =>
  rowOf(answerId)?.querySelector(
    '[data-slot="reply-actions"] [data-lingering="true"]',
  ) !== null;
const rowsOfMenu = () => [
  ...(menu()?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []),
];

function frame(): Frame {
  const controls: Record<string, string[]> = {};
  const warned: string[] = [];
  for (const row of log()?.querySelectorAll<HTMLElement>("[data-message-id]") ??
    []) {
    const actions = row.querySelector('[data-slot="reply-actions"]');
    const id = row.dataset.messageId ?? "";
    if (!actions) continue;
    controls[id] = [...actions.querySelectorAll("button")].map(
      (button) => button.getAttribute("aria-label") ?? "",
    );
    if (moreUnder(id)?.className.split(/\s+/).includes("text-warning")) {
      warned.push(id);
    }
  }
  return { rows: rowsDrawn(), lines: linesDrawn(), controls, warned };
}

type View = Awaited<ReturnType<typeof mountApp>>;

/** What the scenario that is running has seen so far: kept when it stops before its end. */
let current: Seen = { frames: {}, menus: {}, notes: {} };

/** What a scenario does with the screen, and where it writes down what it saw. */
function watching(view: View) {
  const seen: Seen = { frames: {}, menus: {}, notes: {} };
  current = seen;

  const open = async (answerId: string) => {
    const more = moreUnder(answerId);
    if (!more) throw new Error(`no "more" under ${answerId}`);
    await view.click(more);
    await view.waitFor(() => menu() !== null, `the menu under ${answerId}`);
  };
  const close = async () => {
    await acted(() => {
      menu()?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await view.waitFor(() => menu() === null, "the menu to close");
  };

  return {
    seen,
    /** Wait for an answer's "more": the conversation has arrived, and its controls with it. */
    more: (answerId: string) =>
      view.waitFor(
        () => moreUnder(answerId) !== null,
        `the "more" under ${answerId}`,
        8000,
      ),
    frame: (label: string) => {
      seen.frames[label] = frame();
    },
    note: (label: string, value: string | number | boolean | null) => {
      seen.notes[label] = value;
    },
    /** Open an answer's menu, write down its rows, and close it without choosing. */
    menu: async (label: string, answerId: string) => {
      if (!moreUnder(answerId)) {
        seen.menus[label] = [];
        return;
      }
      await open(answerId);
      seen.menus[label] = rowsOfMenu().map((row) => ({
        name: row.textContent?.trim() ?? "",
        role: row.getAttribute("role") ?? "",
        checked: row.getAttribute("aria-checked") === "true",
        warns: row.querySelector(".text-warning") !== null,
      }));
      await close();
    },
    /** Whether the row of controls is held up: before its menu is opened, while it is open, after. */
    heldUp: async (answerId: string) => {
      seen.notes["held up, before"] = heldUp(answerId);
      await open(answerId);
      seen.notes["held up, menu open"] = heldUp(answerId);
      await close();
      seen.notes["held up, menu closed"] = heldUp(answerId);
    },
    /** Open an answer's menu and press the row with this name. */
    choose: async (answerId: string, name: string) => {
      await open(answerId);
      const row = rowsOfMenu().find(
        (candidate) => candidate.textContent?.trim() === name,
      );
      if (!row) {
        const offered = rowsOfMenu().map((each) => each.textContent?.trim());
        throw new Error(
          `"${name}" is not in the menu under ${answerId}: ${JSON.stringify(offered)}`,
        );
      }
      await view.click(row);
      await view.waitFor(() => menu() === null, `the menu to close on ${name}`);
    },
  };
}

/** The conversation people use — the server owns its turns — opened on what the store holds. */
async function conversation(
  channelId: string,
  options: Omit<Parameters<typeof turnServer>[0], "channelId">,
  /** Answered before the conversation's own server: a rating route, a failure on the record. */
  first?: (request: ApiRequest) => Response | undefined,
) {
  const server = turnServer({ channelId, ...options });
  const view = await mountApp({
    path: `/channel/${channelId}`,
    api: (request) => first?.(request) ?? server.api(request),
  });
  return { server, view, ...watching(view) };
}

const jumpTo = async (channelId: string, messageId: string) => {
  const { requestJump } = await import("../../src/lib/channels/jump");
  await acted(() => requestJump({ channelId, messageId }));
};
const marked = (messageId: string) =>
  rowOf(messageId)?.getAttribute("data-jumped") === "true";

const scenarios: Record<string, () => Promise<Seen>> = {
  /* A finished turn: no step drawn, and the record is a row of the answer's menu. */
  record: async () => {
    const { view, seen, ...on } = await conversation("channel_steps-record", {
      history: [
        ASKED,
        ...done("1"),
        ...done("2"),
        ...done("3"),
        ...done("4"),
        said("a-answer", "비즈니스 메일 한 통 와 있어요."),
      ],
    });
    await on.more("a-answer");
    on.frame("closed");
    await on.menu("closed", "a-answer");
    await on.heldUp("a-answer");

    await on.choose("a-answer", "What it did for this answer: 4 steps");
    await view.waitFor(() => linesDrawn() === 4, "every step", 4000);
    on.frame("opened");
    await on.menu("opened", "a-answer");

    await on.choose("a-answer", "Hide what it did");
    await view.waitFor(() => linesDrawn() === 0, "none again", 4000);
    on.frame("put away");
    await on.menu("put away", "a-answer");
    on.note(
      "the answer is where it was",
      log()?.textContent?.includes("비즈니스 메일 한 통 와 있어요.") === true,
    );
    return seen;
  },

  /* A step alone, and a sentence between two stretches of work: each answer opens its own. */
  alone: async () => {
    const { view, seen, ...on } = await conversation("channel_steps-alone", {
      history: [
        ASKED,
        ...done("1"),
        said("a-between", "두 통 더 볼게요."),
        ...done("2"),
        ...done("3"),
        said("a-answer", "세 통 와 있어요."),
      ],
    });
    await on.more("a-answer");
    on.frame("closed");
    await on.menu("between, closed", "a-between");
    await on.menu("answer, closed", "a-answer");

    await on.choose("a-between", "What it did for this answer: 1 steps");
    await view.waitFor(() => linesDrawn() === 1, "its one step", 4000);
    on.frame("between opened");
    await on.menu("between, opened", "a-between");
    await on.menu("answer, still closed", "a-answer");
    return seen;
  },

  /* What is drawn by name stays where it was, and the runs either side of it open together. */
  card: async () => {
    const { view, seen, ...on } = await conversation("channel_steps-card", {
      history: [
        ASKED,
        ...done("1"),
        ...done("2"),
        ...done("card", "now"),
        ...done("3"),
        said("a-answer", "다 봤어요."),
      ],
    });
    await on.more("a-answer");
    on.frame("closed");
    await on.menu("closed", "a-answer");
    await on.choose("a-answer", "What it did for this answer: 3 steps");
    await view.waitFor(() => linesDrawn() === 3, "all three", 4000);
    on.frame("opened");
    await on.menu("opened", "a-answer");
    return seen;
  },

  /* The mail a one-time code was in stays drawn, with the steps round it put away. */
  code: async () => {
    const { view, seen, ...on } = await conversation("channel_steps-code", {
      history: [
        ASKED,
        ...done("1"),
        called("2"),
        answered("2", MAIL_WITH_A_CODE),
        ...done("3"),
        ...done("4"),
        said("a-answer", "인증번호가 온 메일이 있어요."),
      ],
    });
    await on.more("a-answer");
    on.frame("closed");
    await on.menu("closed", "a-answer");
    await on.choose("a-answer", "What it did for this answer: 4 steps");
    await view.waitFor(() => linesDrawn() === 4, "all four", 4000);
    on.frame("opened");
    await on.choose("a-answer", "Hide what it did");
    await view.waitFor(() => linesDrawn() === 1, "the mail", 4000);
    on.frame("put away");
    return seen;
  },

  /* And where that mail is all the answer was written from, there is nothing to open. */
  "code alone": async () => {
    const { view, seen, ...on } = await conversation(
      "channel_steps-code-alone",
      {
        history: [
          ASKED,
          called("1"),
          answered("1", MAIL_WITH_A_CODE),
          said("a-answer", "인증번호가 온 메일이에요."),
        ],
      },
    );
    await view.waitFor(
      () => drawn() === "q-asked call-1 a-answer",
      "the mail and the answer",
      8000,
    );
    await on.more("a-answer");
    on.frame("drawn");
    await on.menu("drawn", "a-answer");
    return seen;
  },

  /* A step that did not work is put away too, and the button and the row both say so. */
  failed: async () => {
    const { view, seen, ...on } = await conversation("channel_steps-failed", {
      history: [
        ASKED,
        ...done("1"),
        called("2"),
        answered("2", toolErrorText("quota exceeded")),
        ...done("3"),
        ...done("4"),
        said("a-answer", "두 번째는 안 됐어요."),
      ],
    });
    await on.more("a-answer");
    on.frame("closed");
    await on.menu("closed", "a-answer");
    await on.choose(
      "a-answer",
      "What it did for this answer: 4 steps, 1 did not work",
    );
    await view.waitFor(() => linesDrawn() === 4, "all four", 4000);
    on.frame("opened");
    await on.menu("opened", "a-answer");
    return seen;
  },

  /* A row another screen sends the person to is opened to, and the answer's row closes it. */
  jump: async () => {
    const channelId = "channel_steps-jump";
    const { view, seen, ...on } = await conversation(channelId, {
      history: [
        ASKED,
        ...done("1"),
        ...done("2"),
        ...done("3"),
        said("a-answer", "세 번 찾아봤어요."),
      ],
    });
    await on.more("a-answer");
    on.frame("closed");
    await jumpTo(channelId, "call-3");
    await view.waitFor(() => linesDrawn() === 3, "every step", 4000);
    await view.waitFor(() => marked("call-3"), "the row marked", 4000);
    on.frame("after the jump");
    await on.menu("after the jump", "a-answer");
    await on.choose("a-answer", "Hide what it did");
    await view.waitFor(() => linesDrawn() === 0, "none again", 4000);
    on.frame("put away");
    return seen;
  },

  /* A jump opens the run it is in, and the answer's row still opens the rest. */
  "jump to half": async () => {
    const channelId = "channel_steps-jump-half";
    const { view, seen, ...on } = await conversation(channelId, {
      history: [
        ASKED,
        ...done("1"),
        ...done("2"),
        ...done("card", "now"),
        ...done("3"),
        said("a-answer", "다 봤어요."),
      ],
    });
    await on.more("a-answer");
    await jumpTo(channelId, "call-3");
    await view.waitFor(
      () => drawn() === "q-asked call-card call-3 a-answer",
      "the run the row is in",
      4000,
    );
    on.frame("after the jump");
    await on.menu("after the jump", "a-answer");
    await on.choose("a-answer", "What it did for this answer: 3 steps");
    await view.waitFor(() => linesDrawn() === 3, "all three", 4000);
    on.frame("opened");
    await on.menu("opened", "a-answer");
    await on.choose("a-answer", "Hide what it did");
    await view.waitFor(() => linesDrawn() === 0, "none", 4000);
    on.frame("put away");
    return seen;
  },

  /* A jump to a row that is drawn already opens nothing. */
  "jump to a drawn row": async () => {
    const channelId = "channel_steps-jump-drawn";
    const { view, seen, ...on } = await conversation(channelId, {
      history: [
        ASKED,
        ...done("1"),
        called("2"),
        answered("2", MAIL_WITH_A_CODE),
        ...done("3"),
        said("a-answer", "인증번호가 온 메일이 있어요."),
      ],
    });
    await on.more("a-answer");
    on.frame("closed");
    await jumpTo(channelId, "call-2");
    await view.waitFor(() => marked("call-2"), "the row marked", 4000);
    on.frame("after the jump");
    await on.menu("after the jump", "a-answer");
    return seen;
  },

  /* A window that would begin inside a run begins at its first step. */
  window: async () => {
    const { view, seen, ...on } = await conversation("channel_steps-window", {
      history: [
        ASKED,
        ...done("1"),
        ...done("2"),
        ...done("3"),
        ...done("4"),
        ...done("5"),
        ...done("6"),
        said("a-answer", "여섯 번 찾아봤어요."),
        // Forty-four rows in all: the newest forty begin at the fourth step.
        ...talk(18),
      ],
    });
    // The question the steps answer is above the window; the newest row is what says it arrived.
    await view.waitFor(
      () => log()?.textContent?.includes("답 17") === true,
      "the conversation",
      8000,
    );
    await on.more("a-answer");
    on.note("first row, closed", rowsDrawn()[0] ?? null);
    await on.menu("closed", "a-answer");
    await on.choose("a-answer", "What it did for this answer: 6 steps");
    await view.waitFor(() => linesDrawn() === 6, "every step", 4000);
    on.note("first seven rows, opened", rowsDrawn().slice(0, 7).join(" "));
    return seen;
  },

  /* And one that would begin at the answer begins at the first step that answer opens. */
  "window at the answer": async () => {
    const { view, seen, ...on } = await conversation(
      "channel_steps-window-answer",
      {
        history: [
          ASKED,
          ...done("1"),
          ...done("2"),
          ...done("3"),
          said("a-answer", "세 번 찾아봤어요."),
          said("a-more", "더 볼까요?"),
          // Forty-four rows in all: the newest forty begin at the answer.
          ...talk(19),
        ],
      },
    );
    await view.waitFor(
      () => log()?.textContent?.includes("답 18") === true,
      "the conversation",
      8000,
    );
    await on.more("a-answer");
    on.note("first row, closed", rowsDrawn()[0] ?? null);
    await on.menu("closed", "a-answer");
    await on.choose("a-answer", "What it did for this answer: 3 steps");
    await view.waitFor(() => linesDrawn() === 3, "every step", 4000);
    on.note("first four rows, opened", rowsDrawn().slice(0, 4).join(" "));
    return seen;
  },

  /* An open record stays open when the page above arrives with the steps before it. */
  page: async () => {
    const { view, seen, ...on } = await conversation("channel_steps-page", {
      history: [
        ASKED,
        ...done("1"),
        ...done("2"),
        ...done("3"),
        ...done("4"),
        said("a-answer", "네 번 찾아봤어요."),
      ],
      // A page of five messages: the newest holds the last two steps and the answer.
      historyPage: 5,
    });
    await on.more("a-answer");
    await on.menu("the newest page", "a-answer");
    await on.choose("a-answer", "What it did for this answer: 2 steps");
    await view.waitFor(() => linesDrawn() === 2, "both steps", 4000);

    const earlier = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent === "Show earlier messages",
    );
    if (!earlier) throw new Error("no way to the page above");
    await view.click(earlier);
    // The window was pinned to the row it began at, the third step: now inside the run, so it
    // begins at the run's first step, and the run is open by the row it was opened by.
    await view.waitFor(() => linesDrawn() === 4, "all four", 8000);
    on.frame("the page above arrived");
    await on.menu("the page above arrived", "a-answer");
    // Closed by any row of it: none drawn, and the count is the whole record's.
    await on.choose("a-answer", "Hide what it did");
    await view.waitFor(() => linesDrawn() === 0, "none", 4000);
    on.frame("put away");
    await on.menu("put away", "a-answer");
    return seen;
  },

  /* A turn at work: the step in hand is the one line, and the answer opens them all. */
  going: async () => {
    const { server, view, seen, ...on } = await conversation(
      "channel_steps-going",
      {
        history: [ASKED],
        turn: { id: "turn-0", status: "running", asked: [ASKED.id] },
        turnMessages: [ASKED],
      },
    );
    await view.waitFor(
      () => log()?.textContent?.includes(String(ASKED.content)) === true,
      "the question the turn is for",
      8000,
    );
    const writes = (messages: Message[]) => acted(() => server.say(messages));

    await writes([called("1")]);
    await view.waitFor(() => linesDrawn() === 1, "the first step");
    on.frame("the first step out");

    // The one in hand is the only line, however many came before it.
    await writes([...done("1"), called("2")]);
    await view.waitFor(
      () => drawn() === "q-asked call-2",
      "the second step in place of the first",
      4000,
    );
    await writes([...done("1"), ...done("2"), called("3")]);
    await view.waitFor(
      () => drawn() === "q-asked call-3",
      "the third in place of the second",
      4000,
    );
    on.frame("the third step out");

    // The answer arrives: no step is left drawn, and the answer carries all three.
    await writes([
      ...done("1"),
      ...done("2"),
      ...done("3"),
      said("a-answer", "세 통 와 있어요."),
    ]);
    await on.more("a-answer");
    on.frame("the answer arrived");
    await on.menu("the answer arrived", "a-answer");
    await on.choose("a-answer", "What it did for this answer: 3 steps");
    await view.waitFor(() => linesDrawn() === 3, "all three", 4000);
    on.frame("opened");
    return seen;
  },

  /*
   * The press is one function for as long as the transcript is mounted. After the answer under it
   * has been written chunk by chunk, the row of a finished answer still does what it did: the
   * function it was given is the same one, not a dead one.
   */
  "pressed while the next answer is written": async () => {
    const again = asked("q-again", "그 중에 급한 게 있어?");
    const history = [
      ASKED,
      ...done("1"),
      ...done("2"),
      said("a-told", "메일이 두 통 있어요."),
      again,
    ];
    const { server, view, seen, ...on } = await conversation(
      "channel_steps-still",
      {
        history,
        turn: { id: "turn-1", status: "running", asked: [again.id] },
        turnMessages: history,
      },
    );
    await on.more("a-told");
    await on.choose("a-told", "What it did for this answer: 2 steps");
    await view.waitFor(() => linesDrawn() === 2, "both steps", 4000);

    for (const text of [
      "두 번째",
      "두 번째 메일이",
      "두 번째 메일이 오늘까지예요.",
    ]) {
      await acted(() => server.say([said("a-urgent", text)]));
      await view.waitFor(
        () => log()?.textContent?.includes(text) === true,
        `the answer as far as "${text}"`,
        4000,
      );
    }
    on.frame("the next answer written");
    await on.choose("a-told", "Hide what it did");
    await view.waitFor(() => linesDrawn() === 0, "none", 4000);
    on.frame("put away");
    await on.choose("a-told", "What it did for this answer: 2 steps");
    await view.waitFor(() => linesDrawn() === 2, "both steps again", 4000);
    on.frame("opened again");
    return seen;
  },

  /*
   * What the menu holds, row by row: an answer with steps, one without, and — while its turn is
   * still being written — one that can be neither quoted nor rated, with steps and without. On a
   * deployment that keeps ratings, which the other scenarios here are not.
   */
  menus: async () => {
    const channelId = "channel_steps-menus";
    const ratings = `/api/support/ratings/${channelId}`;
    const puts: unknown[] = [];
    const next = asked("q-next", "하나만 더 봐 줘");
    const history = [
      ASKED,
      ...done("1"),
      ...done("2"),
      said("a-steps", "두 통 와 있어요."),
      asked("q-plain", "고마워"),
      said("a-plain", "별말씀을요."),
      next,
    ];
    const { server, view, seen, ...on } = await conversation(
      channelId,
      {
        history,
        turn: { id: "turn-1", status: "running", asked: [next.id] },
        turnMessages: history,
      },
      ({ method, pathname, body: sent }) => {
        if (pathname === ratings && method === "GET") {
          return json({ ratings: [] });
        }
        if (pathname === `${ratings}/a-plain` && method === "PUT") {
          puts.push(sent);
          return json({
            id: "rating-1",
            messageId: "a-plain",
            rating: (sent as { rating: string }).rating,
            reason: null,
            note: null,
            updatedAt: "2026-10-04T03:00:00.000Z",
            told: [],
          });
        }
        return undefined;
      },
    );
    await on.more("a-plain");
    // The rows a rating is chosen from wait for this conversation's ratings to be read.
    await view.waitFor(
      () => view.requests.some((request) => request.pathname === ratings),
      "the conversation's ratings to be asked for",
      8000,
    );
    await view.settle(50);

    await acted(() =>
      server.say([...done("9"), said("a-writing", "한 통 더 있고,")]),
    );
    await on.more("a-writing");
    await acted(() => server.say([said("a-bare", "그게 다예요.")]));
    await view.waitFor(() => rowOf("a-bare") !== null, "the answer after it");
    on.frame("drawn");
    await on.menu("with steps", "a-steps");
    await on.menu("without", "a-plain");
    await on.menu("being written, with steps", "a-writing");
    await on.menu("being written, without", "a-bare");

    // 좋아요 from the menu is what the thumb was: sent as nothing but itself, chosen once kept.
    await on.choose("a-plain", "Good answer");
    await view.waitFor(() => puts.length === 1, "the 좋아요 to be sent");
    await view.waitFor(
      () => rowOf("a-plain")?.textContent?.includes("Got it") === true,
      "the 좋아요 to be acknowledged",
    );
    on.note("put", JSON.stringify(puts));
    on.note("held up while the rating is said", heldUp("a-plain"));
    on.frame("rated");
    await on.menu("rated", "a-plain");
    return seen;
  },
};

const only = process.argv.slice(2);
const shown: StepsShown = {};
for (const [name, run] of Object.entries(scenarios)) {
  if (only.length > 0 && !only.includes(name)) continue;
  current = { frames: {}, menus: {}, notes: {} };
  try {
    shown[name] = await run();
  } catch (error) {
    shown[name] = {
      ...current,
      frames: { ...current.frames, "where it stopped": frame() },
      error: error instanceof Error ? error.message : String(error),
    };
  }
  // Whatever the scenario left mounted — it stopped before its end, or simply finished — goes.
  await unmountApps();
}

console.log(`STEPS_RENDER ${JSON.stringify(shown)}`);
process.exit(0);
