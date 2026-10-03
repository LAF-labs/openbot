import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import {
  installTurnStreams,
  removeTurnStreams,
  turnServer,
} from "./support/turn-server";

/**
 * "출처: 기상청" GOES WHEREVER THE ANSWER GOES — in the conversation people use, mounted, with the
 * server's own history.
 *
 * `credit-line.test.tsx` holds the line itself and `answer-sources.test.ts` who is owed one. These
 * hold the two places the line was owed and missing after both (Codex on pull request 50): an
 * answer copied out of the conversation left the line the screen had drawn behind, and a sentence
 * the Bot said between two steps of a browsing task — drawn inside the task's card — had none.
 */

beforeAll(async () => {
  await installAppDom();
  installTurnStreams();
}, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
  delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
});
setDefaultTimeout(30_000);
afterAll(async () => {
  removeTurnStreams();
  await removeAppDom();
});

/** Tests read the English keys; on a Korean screen this is "출처: 기상청". */
const LINE = "Source: Korea Meteorological Administration";

const asked = (text: string): Message => ({
  id: "q-asked",
  role: "user",
  content: text,
});
const said = (id: string, text: string): Message => ({
  id,
  role: "assistant",
  content: text,
});
/** A call and its result, as the record holds a finished one. */
const done = (id: string, name: string, result: object): Message[] => [
  {
    id: `a-${id}`,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: `call-${id}`,
        type: "function",
        function: { name, arguments: "{}" },
      },
    ],
  } as Message,
  {
    id: `t-${id}`,
    role: "tool",
    toolCallId: `call-${id}`,
    content: JSON.stringify(result),
  } as Message,
];
const weather = (id: string) =>
  done(id, "mcp__kma-weather__get_weather", {
    source: "기상청",
    place: "서울특별시 종로구",
    now: { temp: 17.7 },
  });

const log = (host: HTMLElement) => host.querySelector('[role="log"]');
const lines = (host: HTMLElement) => [
  ...(log(host)?.querySelectorAll('[data-slot="answer-credit"]') ?? []),
];

async function conversation(channelId: string, history: Message[]) {
  const server = turnServer({ channelId, history });
  const view = await mountApp({
    path: `/channel/${channelId}`,
    api: server.api,
  });
  await view.waitFor(
    () => lines(view.host).length > 0,
    "the source line",
    8000,
  );
  return { server, view };
}

/** What the page writes, caught on its way to the clipboard. The clipboard itself is never read. */
function clipboard() {
  const written: Record<string, string>[] = [];
  class Item {
    readonly parts: Record<string, Blob>;
    constructor(parts: Record<string, Blob>) {
      this.parts = parts;
    }
  }
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        written.push({ "text/plain": text });
      },
      write: async (items: Item[]) => {
        for (const item of items) {
          const types: Record<string, string> = {};
          for (const [type, blob] of Object.entries(item.parts)) {
            types[type] = await blob.text();
          }
          written.push(types);
        }
      },
    },
  });
  (globalThis as { ClipboardItem?: unknown }).ClipboardItem = Item;
  return written;
}

describe("the source line, in the conversation", () => {
  test("is copied with the answer it was drawn under, in both of what the clipboard is given", async () => {
    const { server, view } = await conversation("channel_credit-copied", [
      asked("서울 날씨 어때?"),
      ...weather("w1"),
      said("a-told", "서울은 지금 17.7도예요."),
    ]);
    expect(lines(view.host).map((line) => line.textContent)).toEqual([LINE]);

    const written = clipboard();
    const copy = [
      ...(log(view.host)?.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Copy this reply"]',
      ) ?? []),
    ].at(-1);
    if (!copy) throw new Error("no copy button under the answer");
    await view.click(copy);
    await view.waitFor(() => written.length === 1, "the copy", 4000);

    expect(written[0]?.["text/plain"]).toBe(
      `서울은 지금 17.7도예요.\n\n${LINE}`,
    );
    expect(written[0]?.["text/html"]).toEndWith(`<p>${LINE}</p>`);
    expect(written[0]?.["text/html"]).toContain("서울은 지금 17.7도예요.");

    server.close();
    await view.unmount();
  });

  test("is under a browsing card that holds what the Bot said after the weather", async () => {
    const page = { ok: true, url: "https://shop.example/", title: "우산" };
    const { server, view } = await conversation("channel_credit-card", [
      asked("비 오면 우산 살 곳 찾아 줘"),
      ...weather("w1"),
      ...done("b1", "computer_navigate", page),
      // Said between two steps of the task: drawn inside the card, not as a row of its own.
      said("a-between", "서울은 저녁에 비가 온다니 우산 파는 곳을 찾아볼게요."),
      ...done("b2", "computer_read", page),
      // The answer carries the line in its own words — in Korean, on this English screen.
      said("a-told", "근처에 두 곳이 있어요. 출처: 기상청"),
    ]);

    // One line, and it is the card's: the answer's own words carry the answer's.
    expect(lines(view.host).map((line) => line.textContent)).toEqual([LINE]);
    const row = lines(view.host)[0]?.parentElement;
    expect(row?.textContent).toContain("shop.example");
    expect(row?.textContent).not.toContain("근처에 두 곳이 있어요.");

    server.close();
    await view.unmount();
  });
});
