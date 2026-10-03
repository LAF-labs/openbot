import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import { stubFetch } from "./support/fetch";
import { foldingCard, foldOf } from "./support/folding-card";
import { type Mounted, mount, unmountAll } from "./support/mount";

/**
 * WHAT A BROWSING CARD SAYS, AND WHAT IT OFFERS, PER STATE.
 *
 * The owner's screenshot, 2026-10-03: two cards for one question at 토스증권. The first read
 * "tossinvest.com · 테슬라" over "못 끝냄 · 사이트가 봇을 막았어요" in the card's smallest text, with
 * 다시 해 보기 and 한 일 looking alike under it; the second said the site twice; both kept a grey box
 * a third of the card wide whether or not there was a picture.
 *
 * So: the site and a chip for how it stands on one small line, what was looked up as the title, why
 * it did not finish as a sentence of its own, one filled button where pressing it is what there is
 * to do, and a picture only where there is one.
 *
 * A TASK THAT IS OVER IS A ROW UNTIL IT IS OPENED (2026-10-04, `browsing-card-row.test.tsx`), so
 * each ended task here is opened first: this file is about the card the row opens to.
 */

const realFetch = globalThis.fetch;
const asked: string[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3114/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = stubFetch(async (input) => {
    const url = new URL(String(input), "http://localhost:3114/");
    if (url.pathname === "/api/channels/ch-1/frames") {
      return new Response(JSON.stringify({ toolCallIds: ["call-framed"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 401 });
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

afterEach(async () => {
  await unmountAll();
  asked.length = 0;
});

/** One navigate, answered as the Bot's computer answers one. */
const task = (id: string, answer: Record<string, unknown>, url: string) => ({
  kind: "browse" as const,
  id,
  steps: [
    {
      id,
      name: "computer_navigate",
      args: JSON.stringify({ url }),
      ...(Object.keys(answer).length > 0
        ? { result: JSON.stringify(answer) }
        : {}),
    },
  ],
  notes: [],
  asked: "토스증권에서 테슬라 주가 알려줘",
});

const TESLA = "https://www.tossinvest.com/stocks/US20100629001/order";
const landed = (id: string, more: Record<string, unknown> = {}) =>
  task(id, { ok: true, url: TESLA, title: "테슬라", ...more }, TESLA);
const refusedBy = (id: string, code: string) =>
  task(id, { ok: false, refused: true, code }, TESLA);

/** A conversation and its Bot around the cards: what 다시 해 보기 and 화면 보기 need to be offered. */
async function drawn(
  cards: (parts: {
    BrowsingCard: Awaited<ReturnType<typeof foldingCard>>;
  }) => ReactNode,
) {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const BrowsingCard = await foldingCard();
  const { ActiveBotProvider, useActiveBot } = await import(
    "../src/lib/copilot/active-bot"
  );
  const { ConversationProvider } = await import(
    "../src/lib/copilot/conversation"
  );
  const ask = (text: string) => {
    asked.push(text);
  };
  function WithBot({ children }: { children: ReactNode }) {
    useActiveBot("bot-1");
    return children;
  }
  const view = await mount(
    <QueryClientProvider client={new QueryClient()}>
      <ActiveBotProvider>
        <ConversationProvider ask={ask}>
          <WithBot>{cards({ BrowsingCard })}</WithBot>
        </ConversationProvider>
      </ActiveBotProvider>
    </QueryClientProvider>,
  );
  await view.settle(50);
  return view;
}

/** Every task that is over, opened from its row: the cards, in the order they are drawn. */
async function opened(view: Mounted) {
  for (const card of cardsIn(view.host)) {
    const fold = foldOf(card);
    if (fold?.getAttribute("aria-expanded") === "false") await view.press(fold);
  }
  return cardsIn(view.host);
}

/** What one card reads, part by part. Tests read the English keys. */
function read(card: Element) {
  // The head an ended card folds by is not one of the things the card offers to do.
  const buttons = [...card.querySelectorAll("button")].filter(
    (button) =>
      (button.textContent ?? "").trim() !== "" && button !== foldOf(card),
  );
  return {
    chip: card.querySelector("span.rounded-full")?.textContent ?? null,
    hasDot: card.querySelector("span.rounded-full > span") !== null,
    title: card.querySelector("p.font-medium")?.textContent ?? null,
    detail: card.querySelector("p.text-sm:not(.font-medium)")?.textContent,
    buttons: buttons.map((button) => (button.textContent ?? "").trim()),
    filled: buttons
      .filter((button) => button.className.includes("bg-primary"))
      .map((button) => (button.textContent ?? "").trim()),
    hasPictureBox: card.querySelector('[class*="aspect-[16/10]"]') !== null,
    text: card.textContent ?? "",
  };
}

function cardsIn(host: HTMLElement) {
  return [...host.querySelectorAll('[class*="shadow-card"]')];
}

describe("a browsing card", () => {
  test("that finished: the site above, what was looked up as the title, and no box where there is no picture", async () => {
    const view = await drawn(({ BrowsingCard }) => (
      <BrowsingCard
        channelId="ch-1"
        isNewest={false}
        isOpen={false}
        item={landed("call-plain")}
      />
    ));
    const [card] = await opened(view);
    const said = read(card as Element);
    expect(said.chip).toBe("Finished");
    expect(said.hasDot).toBe(false);
    expect(said.title).toBe("테슬라");
    expect(said.text).toContain("Toss Securities");
    // The host is nowhere on it: the site is named as people name it.
    expect(said.text).not.toContain("tossinvest.com");
    expect(said.hasPictureBox).toBe(false);
    // An older card of a task that ended: the record, and nothing to press about it.
    expect(said.buttons).toEqual(["What it did"]);
  });

  test("that a site turned away: why, as a sentence of its own, and the two things to press side by side", async () => {
    const view = await drawn(({ BrowsingCard }) => (
      <BrowsingCard
        channelId="ch-1"
        isNewest
        isOpen={false}
        item={landed("call-framed", { httpStatus: 403 })}
      />
    ));
    const said = read((await opened(view))[0] as Element);
    expect(said.chip).toBe("Couldn't finish");
    expect(said.detail).toBe("The site turned the Bot away");
    // The word is on the chip once, not again in front of the reason.
    expect(said.text.split("Couldn't finish").length - 1).toBe(1);
    expect(said.hasPictureBox).toBe(true);
    expect(said.buttons).toEqual([
      "Try it again",
      "View screen",
      "What it did",
    ]);
    // Asking again is most often turned away again: neither is the one thing to do.
    expect(said.filled).toEqual([]);
  });

  test("that failed some other way: 다시 해 보기 is the one filled button, and asks in the person's own words", async () => {
    const view = await drawn(({ BrowsingCard }) => (
      <BrowsingCard
        channelId="ch-1"
        isNewest
        isOpen={false}
        item={refusedBy("call-down", "laf:computer_unreachable")}
      />
    ));
    const card = (await opened(view))[0] as Element;
    const said = read(card);
    expect(said.chip).toBe("Couldn't finish");
    expect(said.detail).toBe("The Bot's computer could not be reached");
    // No picture was kept, so there is no box and nothing to view.
    expect(said.hasPictureBox).toBe(false);
    expect(said.buttons).toEqual(["Try it again", "What it did"]);
    expect(said.filled).toEqual(["Try it again"]);

    const again = [...card.querySelectorAll("button")].find(
      (button) => button.textContent === "Try it again",
    );
    await view.press(again as Element);
    expect(asked).toEqual(["토스증권에서 테슬라 주가 알려줘"]);
  });

  test("that was refused for being the app's own address: said, and no 다시 해 보기 — asking again is the same question", async () => {
    const view = await drawn(({ BrowsingCard }) => (
      <>
        <BrowsingCard
          channelId="ch-1"
          isNewest={false}
          isOpen={false}
          item={refusedBy("call-own", "laf:own_address_refused")}
        />
        <BrowsingCard
          channelId="ch-1"
          isNewest
          isOpen={false}
          item={refusedBy("call-inside", "laf:navigation_refused")}
        />
      </>
    ));
    const [own, inside] = (await opened(view)).map(read);
    expect(own?.detail).toBe("This app's own address was not opened");
    expect(own?.buttons).toEqual(["What it did"]);
    // The floor's other refusal is also said for a name that would not resolve just then, and for
    // an address the Bot wrote wrongly: a second asking can get past those, so it is offered.
    expect(inside?.detail).toBe(
      "An address inside this deployment was blocked",
    );
    expect(inside?.buttons).toEqual(["Try it again", "What it did"]);
  });

  test("still being done: a chip with a dot, the page on its way in the picture's place", async () => {
    const view = await drawn(({ BrowsingCard }) => (
      <BrowsingCard
        channelId="ch-1"
        isNewest
        isOpen
        item={task("call-going", {}, TESLA)}
      />
    ));
    const said = read(cardsIn(view.host)[0] as Element);
    expect(said.chip).toBe("Working on it");
    expect(said.hasDot).toBe(true);
    expect(said.hasPictureBox).toBe(true);
    expect(said.buttons).toContain("View screen");
    expect(said.filled).toEqual([]);
  });
});
