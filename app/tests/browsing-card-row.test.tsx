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
import { mount, unmountAll } from "./support/mount";

/**
 * A BROWSING TASK THAT IS OVER IS ONE ROW: THE SITE, HOW IT ENDED, AND A WAY IN.
 *
 * The owner, 2026-10-04: "불필요한 정보도 보여주고 아이콘으로도 되는 걸 항상 글자로 표시하는 게
 * 문제". A task that had ended stayed a whole card in the conversation — a chip, a title, a sentence,
 * a picture where there was one, and up to three buttons — for every thing the Bot had ever looked
 * up. It is one row now, and the card is what the row opens to.
 *
 * What must not be lost in the folding is held here: a task that is happening is still the whole
 * card, a failure still says so where it is seen without a press, 다시 해 보기 is still one press
 * away, and a list somebody is reading is not folded away under them.
 */

const realFetch = globalThis.fetch;
const asked: string[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3116/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = stubFetch(async (input) => {
    const url = new URL(String(input), "http://localhost:3116/");
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
  // What a case left in the stores the card reads: the screen, the page, a question.
  const { forgetScreenPanel, setScreenOpen } = await import(
    "../src/lib/computer/screen-panel"
  );
  setScreenOpen(false);
  forgetScreenPanel();
  const { forgetBrowsingNow } = await import(
    "../src/lib/computer/browsing-now"
  );
  forgetBrowsingNow();
  const { closeQuestion } = await import("../src/lib/approvals");
  closeQuestion("call-asking");
});

const TESLA = "https://www.tossinvest.com/stocks/US20100629001/order";

/** One navigate, answered as the Bot's computer answers one — or not answered yet. */
const task = (id: string, answer: Record<string, unknown> | null) => ({
  kind: "browse" as const,
  id,
  steps: [
    {
      id,
      name: "computer_navigate",
      args: JSON.stringify({ url: TESLA }),
      ...(answer ? { result: JSON.stringify(answer) } : {}),
    },
  ],
  notes: [],
  asked: "토스증권에서 테슬라 주가 알려줘",
});
const landed = (id: string, more: Record<string, unknown> = {}) =>
  task(id, { ok: true, url: TESLA, title: "테슬라", ...more });
const refusedBy = (id: string, code: string) =>
  task(id, { ok: false, refused: true, code });

/** A conversation and its Bot around whatever is drawn, and a way to draw it again as it changes. */
async function stage() {
  const { act } = await import("react");
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
  const client = new QueryClient();
  const ask = (text: string) => {
    asked.push(text);
  };
  function WithBot({ children }: { children: ReactNode }) {
    useActiveBot("bot-1");
    return children;
  }
  const view = await mount();
  return {
    view,
    BrowsingCard,
    draw: async (cards: ReactNode) => {
      await view.render(
        <QueryClientProvider client={client}>
          <ActiveBotProvider>
            <ConversationProvider ask={ask}>
              <WithBot>{cards}</WithBot>
            </ConversationProvider>
          </ActiveBotProvider>
        </QueryClientProvider>,
      );
      await view.settle(50);
    },
    /** Something outside the card changed a store it reads. */
    when: async (change: () => void) => {
      await act(async () => {
        change();
      });
      await view.settle();
    },
  };
}

/** The task's own surface: the last one drawn, under whatever question is asked above it. */
function surfaceIn(host: HTMLElement): Element {
  const surface = [...host.querySelectorAll('[class*="shadow-card"]')].at(-1);
  if (!surface) throw new Error("no task drawn");
  return surface;
}

/** What is drawn for one task, counted and read — never matched as an element. */
function read(host: HTMLElement) {
  const surface = surfaceIn(host);
  const fold = foldOf(surface);
  const chip = surface.querySelector("span.rounded-full");
  return {
    /** "false" a row, "true" the card a row opened to, null a card with nothing to fold it by. */
    expanded: fold?.getAttribute("aria-expanded") ?? null,
    foldText: fold?.textContent ?? null,
    foldClass: fold?.className ?? "",
    chip: chip?.textContent ?? null,
    chipClass: chip?.className ?? "",
    title: surface.querySelector("p.font-medium")?.textContent ?? null,
    paragraphs: surface.querySelectorAll("p").length,
    pictures: surface.querySelectorAll('[class*="aspect-[16/10]"]').length,
    images: surface.querySelectorAll("img").length,
    /** Every button there is, by the name a screen reader says. */
    buttons: [...surface.querySelectorAll("button")].map(
      (button) =>
        button.getAttribute("aria-label") ?? (button.textContent ?? "").trim(),
    ),
    text: surface.textContent ?? "",
  };
}

const buttonNamed = (host: HTMLElement, name: string) => {
  const found = [...surfaceIn(host).querySelectorAll("button")].find(
    (button) =>
      (button.getAttribute("aria-label") ?? button.textContent?.trim()) ===
      name,
  );
  if (!found) throw new Error(`no button named ${name}`);
  return found;
};

describe("a browsing task that is over", () => {
  test("is one row — the site, what was looked up, how it ended — with no sentence, no picture and nothing else to press", async () => {
    const { view, BrowsingCard, draw } = await stage();
    // The newest task, with a picture kept for it: everything the card would have drawn.
    await draw(
      <BrowsingCard
        channelId="ch-1"
        isNewest
        isOpen={false}
        item={landed("call-framed")}
      />,
    );
    const row = read(view.host);
    expect(row.expanded).toBe("false");
    // A row a finger can hit, and one line of it.
    expect(row.foldClass).toContain("h-11");
    expect(row.foldText).toContain("Toss Securities");
    expect(row.foldText).toContain("테슬라");
    expect(row.chip).toBe("Finished");
    expect(row.foldText).toContain("Finished");
    // The host is nowhere on it: the site is named as people name it.
    expect(row.text).not.toContain("tossinvest.com");
    expect(row.paragraphs).toBe(0);
    expect(row.pictures).toBe(0);
    expect(row.images).toBe(0);
    // The row itself is the one thing there is to press: no 화면 보기, no 한 일.
    expect(row.buttons).toHaveLength(1);
    expect(row.text).not.toContain("View screen");
    expect(row.text).not.toContain("What it did");
  });

  test("with nothing looked up there is still a name on the row: the site, or the Bot's browser", async () => {
    const { view, BrowsingCard, draw } = await stage();
    await draw(
      <BrowsingCard
        channelId="ch-1"
        isNewest={false}
        isOpen={false}
        item={task("call-site-only", { ok: true, url: TESLA })}
      />,
    );
    expect(read(view.host).foldText).toBe("Toss SecuritiesFinished");

    await draw(
      <BrowsingCard
        channelId="ch-1"
        isNewest={false}
        isOpen={false}
        item={{
          kind: "browse",
          id: "call-read",
          steps: [
            {
              id: "call-read",
              name: "computer_read",
              args: "{}",
              result: JSON.stringify({ ok: true }),
            },
          ],
          notes: [],
        }}
      />,
    );
    expect(read(view.host).foldText).toBe("The Bot's browserFinished");
  });

  test("pressed, is the card it always was, in place; pressed again, the row", async () => {
    const { view, BrowsingCard, draw } = await stage();
    await draw(
      <BrowsingCard
        channelId="ch-1"
        isNewest
        isOpen={false}
        item={landed("call-framed")}
      />,
    );
    const row = foldOf(surfaceIn(view.host));
    await view.press(row as Element);

    const card = read(view.host);
    expect(card.expanded).toBe("true");
    expect(card.title).toBe("테슬라");
    expect(card.chip).toBe("Finished");
    expect(card.pictures).toBe(1);
    expect(card.images).toBe(1);
    expect(card.buttons).toEqual([
      // The head it folds by: the site, how it ended.
      "Toss SecuritiesFinished",
      "View the Bot's screen",
      "View screen",
      "What it did",
    ]);
    // The same button, where the keyboard left it — not a new one drawn in its place.
    expect(foldOf(surfaceIn(view.host)) === row).toBe(true);

    await view.press(foldOf(surfaceIn(view.host)) as Element);
    const again = read(view.host);
    expect(again.expanded).toBe("false");
    expect(again.paragraphs).toBe(0);
    expect(again.images).toBe(0);
    expect(again.buttons).toHaveLength(1);
  });

  test("that did not finish says so on the row, in amber, and 다시 해 보기 is one press away", async () => {
    const { view, BrowsingCard, draw } = await stage();
    await draw(
      <BrowsingCard
        channelId="ch-1"
        isNewest
        isOpen={false}
        item={refusedBy("call-down", "laf:computer_unreachable")}
      />,
    );
    const row = read(view.host);
    expect(row.expanded).toBe("false");
    // A failure is never drawn as a task that went well: the word, and the signal's colour.
    expect(row.chip).toBe("Couldn't finish");
    expect(row.chipClass).toContain("text-warning");
    expect(row.foldText).toContain("Couldn't finish");
    // Why is the card's to say; the row has no sentence.
    expect(row.paragraphs).toBe(0);
    // Beside the row's own button, not inside it: a button in a button is not one.
    expect(row.buttons).toEqual([
      "Toss SecuritiesCouldn't finish",
      "Try it again",
    ]);
    expect(
      (foldOf(surfaceIn(view.host)) as Element).querySelectorAll("button"),
    ).toHaveLength(0);

    await view.press(buttonNamed(view.host, "Try it again"));
    expect(asked).toEqual(["토스증권에서 테슬라 주가 알려줘"]);
    // Asking again does not open it.
    expect(read(view.host).expanded).toBe("false");
  });

  test("offers 다시 해 보기 on its row only where its card does", async () => {
    const { view, BrowsingCard, draw } = await stage();
    // The app's own address: asking again is the same question, so the card has no such button.
    await draw(
      <BrowsingCard
        channelId="ch-1"
        isNewest
        isOpen={false}
        item={refusedBy("call-own", "laf:own_address_refused")}
      />,
    );
    const refused = read(view.host);
    expect(refused.chip).toBe("Couldn't finish");
    expect(refused.chipClass).toContain("text-warning");
    expect(refused.buttons).toHaveLength(1);

    // One that went well has nothing to ask again.
    await draw(
      <BrowsingCard
        channelId="ch-1"
        isNewest
        isOpen={false}
        item={landed("call-plain")}
      />,
    );
    expect(read(view.host).buttons).toHaveLength(1);
  });

  test("says how it ended in the card's own chip, word and colour, whichever way it ended", async () => {
    const { view, BrowsingCard, draw } = await stage();
    const endings = [
      { item: landed("call-done"), cutOff: null, word: "Finished" },
      // Stopped between two steps: the owner's own word, and not a success.
      {
        item: landed("call-stopped"),
        cutOff: "stopped" as const,
        word: "Halted",
      },
      {
        item: landed("call-site", { httpStatus: 403 }),
        cutOff: null,
        word: "Couldn't finish",
      },
      // The turn died after the task's last step: the task did not finish either.
      {
        item: landed("call-died"),
        cutOff: "failed" as const,
        word: "Couldn't finish",
      },
    ];
    for (const { item, cutOff, word } of endings) {
      await draw(
        <BrowsingCard
          channelId="ch-1"
          cutOff={cutOff}
          isNewest={false}
          isOpen={false}
          item={item}
          key={item.id}
        />,
      );
      const row = read(view.host);
      expect([item.id, row.expanded, row.chip]).toEqual([
        item.id,
        "false",
        word,
      ]);
      await view.press(foldOf(surfaceIn(view.host)) as Element);
      const card = read(view.host);
      expect([item.id, card.expanded, card.chip, card.chipClass]).toEqual([
        item.id,
        "true",
        word,
        row.chipClass,
      ]);
    }
  });
});

describe("a browsing task that is happening", () => {
  test("being done is the whole card, with nothing to fold it by", async () => {
    const { view, BrowsingCard, draw } = await stage();
    await draw(
      <BrowsingCard
        channelId="ch-1"
        isNewest
        isOpen
        item={task("call-going", null)}
      />,
    );
    const card = read(view.host);
    expect(card.expanded).toBe(null);
    expect(card.chip).toBe("Working on it");
    expect(card.title).toBe("Toss Securities");
    expect(card.pictures).toBe(1);
    expect(card.buttons).toEqual([
      "View the Bot's screen",
      "View screen",
      "What it did",
    ]);
  });

  test("the moment it ends it is the row", async () => {
    const { view, BrowsingCard, draw } = await stage();
    await draw(
      <BrowsingCard
        channelId="ch-1"
        isNewest
        isOpen
        item={task("call-ending", null)}
      />,
    );
    expect(read(view.host).expanded).toBe(null);

    await draw(
      <BrowsingCard
        channelId="ch-1"
        isNewest
        isOpen={false}
        item={landed("call-ending")}
      />,
    );
    const row = read(view.host);
    expect(row.expanded).toBe("false");
    expect(row.chip).toBe("Finished");
    expect(row.buttons).toHaveLength(1);
  });

  test("waiting on the person's answer is the whole card, and says whose turn it is", async () => {
    const { openQuestion } = await import("../src/lib/approvals");
    openQuestion("call-asking", {
      approvalId: "approval-1",
      botId: "bot-1",
      subject: undefined,
      rule: null,
      expiresAt: "",
    });
    const { view, BrowsingCard, draw } = await stage();
    // Not being done by this window's count, and with no result: only the question holds it.
    await draw(
      <BrowsingCard
        channelId="ch-1"
        isNewest
        isOpen={false}
        item={task("call-asking", null)}
      />,
    );
    const card = read(view.host);
    expect(card.expanded).toBe(null);
    expect(card.chip).toBe("Your turn");
    expect(card.text).toContain(
      "It is waiting for your answer. The question is just above.",
    );
    expect(card.buttons).toContain("What it did");
    // And the question itself is above the card, outside it, where it always was.
    expect(view.host.querySelectorAll("[data-waiting-card]")).toHaveLength(1);
    expect(
      surfaceIn(view.host).querySelectorAll("[data-waiting-card]"),
    ).toHaveLength(0);
  });

  test("that the Bot stopped after to ask for a hand keeps its card while the request waits", async () => {
    const { view, BrowsingCard, draw } = await stage();
    await draw(
      <BrowsingCard
        channelId="ch-1"
        isHandedOver
        isNewest
        isOpen={false}
        item={landed("call-framed")}
      />,
    );
    const card = read(view.host);
    expect(card.expanded).toBe(null);
    expect(card.title).toBe("테슬라");
    expect(card.images).toBe(1);
    expect(card.buttons).toContain("View screen");

    // Answered, the Bot goes on in a task of its own, and this one is over like any other.
    await draw(
      <BrowsingCard
        channelId="ch-1"
        isNewest={false}
        isOpen={false}
        item={landed("call-framed")}
      />,
    );
    expect(read(view.host).expanded).toBe("false");
  });

  test("the one the live screen is showing keeps its card, and an older one does not", async () => {
    const { setScreenOpen } = await import("../src/lib/computer/screen-panel");
    const { forgetBrowsingNow, markPageGone } = await import(
      "../src/lib/computer/browsing-now"
    );
    const { view, BrowsingCard, draw, when } = await stage();
    await draw(
      <>
        <BrowsingCard
          channelId="ch-1"
          isNewest={false}
          isOpen={false}
          item={landed("call-older")}
        />
        <BrowsingCard
          channelId="ch-1"
          isNewest
          isOpen={false}
          item={landed("call-framed")}
        />
      </>,
    );
    const surfaces = () => [
      ...view.host.querySelectorAll('[class*="shadow-card"]'),
    ];
    const expandedOf = (surface: Element | undefined) =>
      (surface ? foldOf(surface) : null)?.getAttribute("aria-expanded") ?? null;
    expect(surfaces().map(expandedOf)).toEqual(["false", "false"]);

    await when(() => setScreenOpen(true));
    // The newest is where the browser is, which is what the screen shows; the older one is not.
    expect(surfaces().map(expandedOf)).toEqual(["false", null]);
    expect(read(view.host).title).toBe("테슬라");

    // The screen looked, found no page and closed itself: said on this card, which stays.
    await when(() => {
      markPageGone("bot-1");
      setScreenOpen(false);
    });
    const gone = read(view.host);
    expect(gone.expanded).toBe(null);
    expect(gone.text).toContain(
      "No page is open now. The picture is the last one.",
    );
    expect(gone.text).not.toContain("View screen");

    // The Bot's next task opens a page, and this one is over like any other.
    await when(() => forgetBrowsingNow());
    expect(surfaces().map(expandedOf)).toEqual(["false", "false"]);
  });

  test("whose list of what it did is open stays a card when it ends, until its head is pressed", async () => {
    const { view, BrowsingCard, draw } = await stage();
    await draw(
      <BrowsingCard
        channelId="ch-1"
        isNewest
        isOpen
        item={task("call-watched", null)}
      />,
    );
    await view.press(buttonNamed(view.host, "What it did"));
    expect(view.host.textContent).toContain("Opened");

    // It ends with the list open: somebody is reading it.
    await draw(
      <BrowsingCard
        channelId="ch-1"
        isNewest
        isOpen={false}
        item={landed("call-watched")}
      />,
    );
    const card = read(view.host);
    expect(card.expanded).toBe("true");
    expect(card.title).toBe("테슬라");
    expect(view.host.textContent).toContain("Opened");

    // Its head folds it, and the list with it.
    await view.press(foldOf(surfaceIn(view.host)) as Element);
    expect(read(view.host).expanded).toBe("false");
    expect(view.host.textContent).not.toContain("Opened");

    // Opened again, it is the card with its list folded, as a card first is.
    await view.press(foldOf(surfaceIn(view.host)) as Element);
    expect(read(view.host).expanded).toBe("true");
    expect(
      buttonNamed(view.host, "What it did").getAttribute("aria-expanded"),
    ).toBe("false");
  });
});
