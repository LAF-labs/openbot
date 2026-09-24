/**
 * A ROOM'S TRANSCRIPT, DRAWN, AS A KOREAN READER MEETS IT.
 *
 * In a process of its own for the reason `preview-render.tsx` gives: `activeLocale` is decided once,
 * when the dictionary is first loaded, and in the shared `bun test` process that has already
 * happened in English.
 *
 * It renders `ChatTranscript` itself rather than the whole room screen, because what is being
 * checked is what a reader SEES on each turn — whose face, whose name, and whether anything says a
 * colleague is working — and the screen around it (sockets, catch-up, the composer) has its own
 * tests. Prints one `ROOM_RENDER <json>` line for `room-transcript-render.test.ts`.
 *
 * Not a test file (no `.test.` in the name), so the runner never collects it on its own.
 *
 *     bun app/tests/support/room-transcript-render.tsx
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Development builds, as under `bun test`; see `korean-render.tsx`.
process.env.NODE_ENV = "test";

GlobalRegistrator.register({ url: "http://localhost:3110/" });
// Chosen before a single app module is imported: this is what `storedLocale()` reads.
window.localStorage.setItem("laf.locale", "ko");
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** One turn as a reader meets it: who it says spoke, whether a face was drawn, and the words. */
export type DrawnTurn = {
  /** The name over the bubble, or null where the run continues the one above it. */
  said: string | null;
  /** Whether a face was drawn beside that name. */
  face: boolean;
  text: string;
};

export type RoomDrawn = {
  /** Every message in the transcript, in order. */
  turns: DrawnTurn[];
  /** What the transcript says is happening while a colleague holds the floor, if anything. */
  workingLine: string | null;
  /** Whether a face is drawn beside it. */
  workingFace: boolean;
  /** What an always-mounted live region says at that moment. */
  announced: string;
  /** The same, with nobody holding the floor and the person's question last: the plain line. */
  firstWaitLine: string | null;
  /** A settled turn with one quiet member and one that could not answer. */
  receipt: {
    /** The text of the bubble it sits beside. */
    under: string | null;
    /** Where it sits against that bubble; and where, when nobody answered at all. */
    placement: string | null;
    silentPlacement: {
      placement: string | null;
      question: string | null;
    } | null;
    /** What the receipt is called, for a reader and on hover. */
    label: string | null;
    /** Faces drawn, by the outcome each carries. */
    faces: string[];
    /** Whether any sentence was drawn in the flow beside the faces. */
    visibleText: string;
    /** The 다시 묻기 button's name, and what a press handed back. */
    askAgain: string | null;
    asked: string[] | null;
    /** The same turn while the room is still busy: nothing can be asked again then. */
    askAgainWhileBusy: boolean;
  };
};

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ChatTranscript } = await import(
  "../../src/components/channels/chat-transcript"
);

const SALES = { name: "매출봇", avatarSeed: "sales-seed" };
const REVIEW = { name: "리뷰봇", avatarSeed: "review-seed" };

const messages = [
  { id: "u1", role: "user" as const, content: "지난주 어땠어?" },
  { id: "a1", role: "assistant" as const, content: "매출은 12% 올랐어요." },
  { id: "a2", role: "assistant" as const, content: "객단가도 조금 올랐고요." },
  { id: "a3", role: "assistant" as const, content: "리뷰는 4.5점이었습니다." },
];
const speakers = { a1: SALES, a2: SALES, a3: REVIEW };

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

async function draw(props: Record<string, unknown>) {
  await act(async () => {
    root.render(createElement(ChatTranscript, props as never));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/**
 * The speaker line is the element directly above the bubble, and carries the face when there is
 * one. A bubble that continues a run has no such line — which is the thing worth holding: joining
 * two colleagues' replies would put the second Bot's words under the first Bot's name.
 */
function turnsIn(root: ParentNode): DrawnTurn[] {
  return [...root.querySelectorAll("[data-slot='message-content']")].flatMap(
    (content) => {
      const bubble = content.querySelector("[data-slot='bubble']");
      if (!bubble) return [];
      const line = content.querySelector("span.mb-1");
      return [
        {
          said: line ? (line.textContent ?? "") : null,
          face: Boolean(line?.querySelector("svg")),
          text: bubble.textContent ?? "",
        },
      ];
    },
  );
}

// --- a colleague has the floor and has not said anything yet -------------------------------------

await draw({
  busy: true,
  messages,
  speakers,
  working: { name: "재고봇", avatarSeed: "stock-seed" },
});
const turns = turnsIn(host);
const working = host.querySelector("p.tool-line-running");
const workingRow = working?.parentElement ?? null;
const drawn: RoomDrawn = {
  turns,
  workingLine: workingRow ? (workingRow.textContent ?? "") : null,
  workingFace: Boolean(workingRow?.querySelector("svg")),
  announced:
    [...host.querySelectorAll("[aria-live]")]
      .map((region) => region.textContent ?? "")
      .find((words) => words.length > 0) ?? "",
  firstWaitLine: null,
  receipt: {
    under: null,
    placement: null,
    silentPlacement: null,
    label: null,
    faces: [],
    visibleText: "",
    askAgain: null,
    asked: null,
    askAgainWhileBusy: false,
  },
};

// --- nobody named yet, the person's question last: the plain thinking line --------------------

await draw({ busy: true, messages: [messages[0]] });
drawn.firstWaitLine =
  host.querySelector("p.tool-line-running")?.textContent ?? null;

// --- a turn that settled: 재고봇 read it and stayed quiet, 리뷰봇 could not answer ---------------

const settled = [messages[0], messages[1]];
const receipts = {
  a1: [
    {
      memberId: "stock",
      name: "재고봇",
      avatarSeed: "stock-seed",
      outcome: "passed",
      questionId: "u1",
    },
    {
      memberId: "review",
      name: "리뷰봇",
      avatarSeed: "review-seed",
      outcome: "failed",
      questionId: "u1",
    },
  ],
};
let askedAgain: { questionId: string; memberIds: string[] } | null = null;
await draw({
  busy: false,
  messages: settled,
  speakers,
  receipts,
  retryKeepsReplies: true,
  onAskAgain: (questionId: string, memberIds: string[]) => {
    askedAgain = { questionId, memberIds };
  },
});
const receiptRow = host.querySelector("[data-slot='room-receipt']");
// Beside the bubble it belongs to, in the same row — not at the column's edge on its own.
const besideOf = receiptRow?.closest("[data-slot='bubble-receipt-row']");
const askButton = [...(receiptRow?.querySelectorAll("button") ?? [])].find(
  (button) => (button.textContent ?? "").includes("다시 묻기"),
);
askButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
drawn.receipt = {
  under: besideOf?.querySelector("[data-slot='bubble']")?.textContent ?? null,
  placement: receiptRow?.getAttribute("data-placement") ?? null,
  silentPlacement: null,
  label:
    receiptRow?.querySelector("button")?.getAttribute("aria-label") ?? null,
  faces: [...(receiptRow?.querySelectorAll("[data-outcome]") ?? [])].map(
    (face) => face.getAttribute("data-outcome") ?? "",
  ),
  visibleText: receiptRow?.textContent ?? "",
  askAgain: askButton?.getAttribute("aria-label") ?? null,
  asked: (askedAgain as { memberIds: string[] } | null)?.memberIds ?? null,
  askAgainWhileBusy: false,
};

await draw({
  busy: true,
  messages: settled,
  speakers,
  receipts,
  retryKeepsReplies: true,
  onAskAgain: () => {},
});
drawn.receipt.askAgainWhileBusy = [
  ...(host
    .querySelector("[data-slot='room-receipt']")
    ?.querySelectorAll("button") ?? []),
].some((button) => (button.textContent ?? "").includes("다시 묻기"));

// --- nobody answered at all: the receipt sits under the person's own message --------------------

await draw({
  busy: false,
  messages: [messages[0]],
  receipts: {
    u1: [
      {
        memberId: "stock",
        name: "재고봇",
        avatarSeed: "stock-seed",
        outcome: "passed",
        questionId: "u1",
      },
    ],
  },
});
const silentRow = host.querySelector("[data-slot='room-receipt']");
drawn.receipt.silentPlacement = {
  placement: silentRow?.getAttribute("data-placement") ?? null,
  // The receipt is in the person's own message, right after its bubble.
  question:
    silentRow?.previousElementSibling?.getAttribute("data-slot") === "bubble"
      ? (silentRow.previousElementSibling.textContent ?? null)
      : null,
};

await act(async () => {
  root.unmount();
});
host.remove();

console.log(`ROOM_RENDER ${JSON.stringify(drawn)}`);
process.exit(0);
