/**
 * 좋아요·아쉬워요 UNDER AN ANSWER, RENDERED IN KOREAN, PRESSED THE WAY A PERSON PRESSES THEM.
 *
 * In a process of its own for the two reasons `feedback-render.tsx` gives: the locale is decided when
 * the dictionary is first loaded, and Base UI decides once, when it is first evaluated, whether there
 * is a DOM to put a popup into. Both are settled here before any app module is imported.
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
  /** The accessible names of the buttons under each bubble, in transcript order. */
  controls: Array<{ said: string; buttons: string[] }>;
  /** Which of the two is pressed, when the controls first appear. */
  pressedOnOpen: { up: boolean; down: boolean } | null;
  /** Every body the controls put, in order. */
  puts: unknown[];
  /** The line under the answer once 좋아요 came back. */
  upStatus: string | null;
  /** The popover, as a person reads it when it opens. */
  popover: string | null;
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
const { channelServer } = await import("./channel-server");

const puts: unknown[] = [];
const server = channelServer({
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
const rows = () => [...body.querySelectorAll('[data-slot="message"]')];
const answerRow = () =>
  rows().find((row) => row.textContent?.includes("1,234,000원"));
const button = (root: Element | null | undefined, label: string) =>
  [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
const pressed = () => {
  const row = answerRow();
  const up = button(row, "좋아요");
  const down = button(row, "아쉬워요");
  if (!up || !down) return null;
  return {
    up: up.getAttribute("aria-pressed") === "true",
    down: down.getAttribute("aria-pressed") === "true",
  };
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
// The controls wait for the conversation's ratings; without a route they never come, so a short
// settle is the whole wait there.
if (scenario.ratingsRoute) {
  await view.waitFor(() => pressed() !== null, "the rating controls", 8000);
} else {
  await view.settle(300);
}

const shown: RatingShown = {
  controls: rows().map((row) => ({
    said: row.querySelector('[data-slot="bubble-content"]')?.textContent ?? "",
    buttons: [...row.querySelectorAll("button")].map(
      (candidate) => candidate.getAttribute("aria-label") ?? "",
    ),
  })),
  pressedOnOpen: pressed(),
  puts,
  upStatus: null,
  popover: null,
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
  await view.click(button(answerRow(), "아쉬워요") as Element);
  await view.waitFor(() => popover() !== null, "the 아쉬워요 popover");
  await view.settle(30);
  shown.popover = popover()?.textContent ?? "";
  shown.prefilled = {
    reasons: [
      ...(popover()?.querySelectorAll('[aria-pressed="true"]') ?? []),
    ].map((chosen) => chosen.textContent?.trim() ?? ""),
    note: popover()?.querySelector("textarea")?.value ?? "",
  };
};

if (scenario.steps === "rate") {
  await view.click(button(answerRow(), "좋아요") as Element);
  await view.waitFor(() => puts.length === 1, "the 좋아요 to be sent");
  await view.waitFor(
    () => statusUnderAnswer() !== "",
    "the 좋아요 to be acknowledged",
  );
  shown.upStatus = statusUnderAnswer();

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
  shown.pressedAfterDown = pressed();

  await view.click(button(answerRow(), "좋아요") as Element);
  await view.waitFor(() => puts.length === 3, "the change back to 좋아요");
  await view.waitFor(
    () => pressed()?.up === true,
    "좋아요 to be drawn as chosen again",
  );
  shown.pressedAfterUpAgain = pressed();
} else if (scenario.steps === "reopen") {
  await openPopover();
} else if (scenario.steps === "offline") {
  const alertUnderAnswer = () =>
    [...(answerRow()?.querySelectorAll('[role="alert"]') ?? [])]
      .map((alert) => alert.textContent ?? "")
      .join(" ")
      .trim();
  await view.click(button(answerRow(), "좋아요") as Element);
  await view.waitFor(() => alertUnderAnswer() !== "", "the failed 좋아요");
  shown.offlineAlert = alertUnderAnswer();
}

await view.unmount();
console.log(`RATING_RENDER ${JSON.stringify(shown)}`);
process.exit(0);
