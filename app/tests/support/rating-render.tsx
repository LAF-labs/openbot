/**
 * 좋아요·아쉬워요 IN AN ANSWER'S "MORE" MENU, RENDERED IN KOREAN, PRESSED THE WAY A PERSON PRESSES THEM.
 *
 * In a process of its own for the two reasons `feedback-render.tsx` gives: the locale is decided when
 * the dictionary is first loaded, and Base UI decides once, when it is first evaluated, whether there
 * is a DOM to put a popup into. Both are settled here before any app module is imported.
 *
 * They were two thumbs in the row under the answer until 2026-10-04, and this pressed the thumbs.
 * They are two rows of the menu the answer's second control opens (`answer-more.tsx`), so every
 * press here opens that menu first, and what is drawn as chosen is read off its rows.
 *
 * Reads a scenario from the JSON file named by its one argument — what the server already holds for
 * the conversation, whether the rating route answers at all, and what to press — opens a conversation
 * with one question and one answer, does it, and prints one line, `RATING_RENDER <json>`, with what
 * the screen said and what the browser sent. Not a test file (no `.test.` in the name), so the
 * runner never collects it on its own.
 *
 *     bun app/tests/support/rating-render.tsx /tmp/scenario.json
 */
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export type StoredRating = {
  messageId: string;
  rating: "up" | "down";
  reason: string | null;
  note: string | null;
  updatedAt: string;
};

export type RatingScenario = {
  /** What the server holds for this conversation when the screen opens. */
  stored: StoredRating[];
  /** False is a deployment without the rating route: every read of it is a 404. */
  ratingsRoute: boolean;
  /** What to do once the controls are up. */
  steps: "rate" | "reopen" | "none" | "offline";
  /** What to write under 아쉬워요, for the `rate` steps. */
  note: string;
};

/** What the screen drew, and what the browser sent, in the order it happened. */
export type RatingShown = {
  /** The accessible names of the buttons under each message, in transcript order. */
  controls: Array<{ said: string; buttons: string[] }>;
  /** The rows of the answer's menu as it reads when it is first opened, in order. */
  menu: string[];
  /** The class list of the row those buttons sit in, under the answer. */
  actionsRow: string[];
  /** Which of the two is drawn as chosen, when the menu is first opened. */
  pressedOnOpen: { up: boolean; down: boolean } | null;
  /** Every body the controls put, in order. */
  puts: unknown[];
  /** The line under the answer once 좋아요 came back. */
  upStatus: string | null;
  /** The answer's controls while that line is up: it is said beside them, not with a third. */
  buttonsWhileSaid: string[] | null;
  /** The popover, as a person reads it when it opens. */
  popover: string | null;
  /** The control the popover is closed back to: the one that stays under the answer. */
  popoverReturnsTo: string | null;
  /** The reasons drawn as chosen when the popover opened, and the words already in the box. */
  prefilled: { reasons: string[]; note: string } | null;
  /** The line beside the thumbs once 보내기 came back. */
  receipt: string | null;
  /** Whether the popover went away once what it asked for was sent. */
  popoverClosed: boolean | null;
  pressedAfterDown: { up: boolean; down: boolean } | null;
  pressedAfterUpAgain: { up: boolean; down: boolean } | null;
  /** The alert under the answer once a 좋아요 that never reached the server came back. */
  offlineAlert: string | null;
};

export const RATED_CHANNEL = "channel_rating-render";
export const QUESTION_ID = "m-question";
export const ANSWER_ID = "m-answer";

const scenario = JSON.parse(
  readFileSync(process.argv[2] as string, "utf8"),
) as RatingScenario;

process.env.NODE_ENV = "test";
GlobalRegistrator.register({ url: "http://localhost:3110/" });
window.localStorage.setItem("laf.locale", "ko");
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class NoSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = NoSocket;
(window as unknown as { WebSocket: unknown }).WebSocket = NoSocket;

const { json, mountApp } = await import("./app-router");
const { installTurnStreams, turnServer } = await import("./turn-server");
// The conversation's turns are the server's: its window opens a stream to watch them.
installTurnStreams();

const puts: unknown[] = [];
const server = turnServer({
  channelId: RATED_CHANNEL,
  history: [
    { id: QUESTION_ID, role: "user", content: "오늘 매출 얼마야?" },
    {
      id: ANSWER_ID,
      role: "assistant",
      content: "오늘 매출은 1,234,000원이에요.",
    },
  ],
});
const ratingsPath = `/api/support/ratings/${RATED_CHANNEL}`;

const view = await mountApp({
  path: `/channel/${RATED_CHANNEL}`,
  api: (request) => {
    const { method, pathname, body } = request;
    if (pathname === ratingsPath && method === "GET") {
      return scenario.ratingsRoute
        ? json({ ratings: scenario.stored })
        : json({ code: "laf:not_found" }, 404);
    }
    if (pathname === `${ratingsPath}/${ANSWER_ID}` && method === "PUT") {
      puts.push(body);
      // What a browser does with a request that got no answer at all.
      if (scenario.steps === "offline") throw new TypeError("Failed to fetch");
      const sent = body as {
        rating: "up" | "down";
        reason?: string;
        note?: string;
      };
      return json({
        id: "rating-1",
        messageId: ANSWER_ID,
        rating: sent.rating,
        reason: sent.reason ?? null,
        note: sent.note ?? null,
        updatedAt: new Date().toISOString(),
        told: sent.note ? ["support-webhook"] : [],
      });
    }
    return server.api(request);
  },
});

const body = document.body;
// The conversation's rows, not the greeting drawn above them (`components/agents/greeting.tsx`).
const rows = () =>
  [...body.querySelectorAll('[data-slot="message"]')].filter(
    (row) => !row.closest("[data-greeting]"),
  );
const answerRow = () =>
  rows().find((row) => row.textContent?.includes("1,234,000원"));
const button = (root: Element | null | undefined, label: string) =>
  [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
/** The menu that is open. Drawn in the document's body, not in the row it was opened from. */
const menu = () => body.querySelector('[data-slot="dropdown-menu-content"]');
const menuRows = () =>
  [...(menu()?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])].map(
    (row) => ({
      row,
      name: row.textContent?.trim() ?? "",
      checked: row.getAttribute("aria-checked") === "true",
    }),
  );
const openMenu = async () => {
  const more = button(answerRow(), "더 보기");
  if (!more) throw new Error("더 보기 is not under the answer");
  await view.click(more);
  await view.waitFor(() => menu() !== null, "the answer's menu");
};
const closeMenu = async () => {
  const { act } = await import("react");
  await act(async () => {
    menu()?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await view.waitFor(() => menu() === null, "the answer's menu to close");
};
/** The menu's rows as they read now: opened, written down, and closed without choosing. */
const readMenu = async () => {
  await openMenu();
  const rows = menuRows().map(({ name, checked }) => ({ name, checked }));
  await closeMenu();
  return rows;
};
/** Which of the two the menu draws as chosen, or null where it offers neither. */
const pressed = async () => {
  const rows = await readMenu();
  const up = rows.find((row) => row.name === "좋아요");
  const down = rows.find((row) => row.name === "아쉬워요");
  if (!up || !down) return null;
  return { up: up.checked, down: down.checked };
};
/** Open the menu and press the row with this name, as a person does. */
const choose = async (name: string) => {
  await openMenu();
  const found = menuRows().find((row) => row.name === name);
  if (!found) throw new Error(`${name} is not in the answer's menu`);
  await view.click(found.row);
  await view.waitFor(() => menu() === null, `the menu to close on ${name}`);
};
const popover = () => body.querySelector('[data-slot="popover-content"]');
const namedButtonIn = (root: Element | null, name: string) =>
  [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === name,
  );

await view.waitFor(
  () => answerRow() !== undefined,
  "the answer in the transcript",
  8000,
);
// The two rows wait for the conversation's ratings to be read, and are not offered where the read
// is refused: either way the menu is opened only once the server has answered it.
await view.waitFor(
  () => view.requests.some((request) => request.pathname === ratingsPath),
  "the conversation's ratings to be asked for",
  8000,
);
await view.settle(300);

const buttonsUnder = (row: Element | undefined) =>
  [...(row?.querySelectorAll("button") ?? [])].map(
    (candidate) => candidate.getAttribute("aria-label") ?? "",
  );

const shown: RatingShown = {
  controls: rows().map((row) => ({
    said: row.querySelector('[data-slot="bubble-content"]')?.textContent ?? "",
    buttons: buttonsUnder(row),
  })),
  menu: (await readMenu()).map((row) => row.name),
  actionsRow: [
    ...(body.querySelector('[data-slot="reply-actions"]')?.classList ?? []),
  ],
  pressedOnOpen: await pressed(),
  puts,
  upStatus: null,
  buttonsWhileSaid: null,
  popover: null,
  popoverReturnsTo: null,
  prefilled: null,
  receipt: null,
  popoverClosed: null,
  pressedAfterDown: null,
  pressedAfterUpAgain: null,
  offlineAlert: null,
};

const statusUnderAnswer = () =>
  [...(answerRow()?.querySelectorAll('[role="status"]') ?? [])]
    .map((status) => status.textContent ?? "")
    .join(" ")
    .trim();

const openPopover = async () => {
  await choose("아쉬워요");
  await view.waitFor(() => popover() !== null, "the 아쉬워요 popover");
  // Long enough for a panel that opened and lost the keyboard to the closing menu to have gone.
  await view.settle(120);
  shown.popover = popover()?.textContent ?? "";
  shown.prefilled = {
    reasons: [
      ...(popover()?.querySelectorAll('[aria-pressed="true"]') ?? []),
    ].map((chosen) => chosen.textContent?.trim() ?? ""),
    note: popover()?.querySelector("textarea")?.value ?? "",
  };
};

if (scenario.steps === "rate") {
  await choose("좋아요");
  await view.waitFor(() => puts.length === 1, "the 좋아요 to be sent");
  await view.waitFor(
    () => statusUnderAnswer() !== "",
    "the 좋아요 to be acknowledged",
  );
  shown.upStatus = statusUnderAnswer();
  shown.buttonsWhileSaid = buttonsUnder(answerRow());

  await openPopover();
  const reason = namedButtonIn(popover(), "사실과 달라요");
  if (!reason) throw new Error("사실과 달라요 is not in the popover");
  await view.click(reason);
  const box = popover()?.querySelector("textarea");
  if (!box) throw new Error("the note box is not in the popover");
  await view.type(box, scenario.note);
  const send = namedButtonIn(popover(), "보내기");
  if (!send) throw new Error("보내기 is not in the popover");
  await view.click(send);
  await view.waitFor(() => puts.length === 2, "the 아쉬워요 to be sent");
  await view.waitFor(
    () => statusUnderAnswer().startsWith("보냈어요"),
    "the 아쉬워요 to be acknowledged",
  );
  shown.receipt = statusUnderAnswer();
  await view.waitFor(
    () => popover() === null || popover()?.hasAttribute("data-closed") === true,
    "the sent popover to close",
  );
  shown.popoverClosed = true;
  shown.popoverReturnsTo =
    document.activeElement?.getAttribute("aria-label") ?? null;
  shown.pressedAfterDown = await pressed();

  await choose("좋아요");
  await view.waitFor(() => puts.length === 3, "the change back to 좋아요");
  // Drawn as chosen once the server's answer is in the cache: said under the answer when it is.
  await view.waitFor(
    () => statusUnderAnswer().startsWith("잘 받았어요"),
    "the change back to be acknowledged",
  );
  shown.pressedAfterUpAgain = await pressed();
} else if (scenario.steps === "reopen") {
  await openPopover();
} else if (scenario.steps === "offline") {
  const alertUnderAnswer = () =>
    [...(answerRow()?.querySelectorAll('[role="alert"]') ?? [])]
      .map((alert) => alert.textContent ?? "")
      .join(" ")
      .trim();
  await choose("좋아요");
  await view.waitFor(() => alertUnderAnswer() !== "", "the failed 좋아요");
  shown.offlineAlert = alertUnderAnswer();
}

await view.unmount();
console.log(`RATING_RENDER ${JSON.stringify(shown)}`);
process.exit(0);
