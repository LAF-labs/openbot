import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE SHELL'S OWN PAGE, FOR A DEPLOYMENT THAT IS NOT DOWN BUT KEPT.
 *
 * A free trial that ends is stopped, not destroyed: its machine is off for thirty days and then gone
 * (self-serve contract §9). The installed app remembers that machine's address, cannot reach it, and
 * lands on `desktop/public/index.html` — which said "check your network, it will connect by itself"
 * to somebody whose network is fine and whose machine will not come back on its own. While a trial is
 * kept the product itself cannot say anything, so this page asks the front door
 * (`/entry/dest-status`, §4.1) and says what is true: the trial ended, and until when it is kept.
 *
 * The page is run here as it runs in the shell — its one inline script, against a document with its
 * elements, a `fetch` and a `location` — with the front door's answer chosen per case.
 */

const PAGE = readFileSync(
  join(import.meta.dir, "../desktop/public/index.html"),
  "utf8",
);
const SCRIPT = PAGE.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

type FakeElement = {
  id: string;
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  listeners: Record<string, Array<() => void>>;
  addEventListener: (type: string, listener: () => void) => void;
};

/** Every element the page names by id, hidden where its markup says so. */
function elementsOf(markup: string): Map<string, FakeElement> {
  const elements = new Map<string, FakeElement>();
  for (const [tag, id] of markup.matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element: FakeElement = {
      id: id as string,
      hidden: /\shidden(\s|>|=)/.test(tag),
      disabled: false,
      textContent: "",
      listeners: {},
      addEventListener(type, listener) {
        this.listeners[type] = [...(this.listeners[type] ?? []), listener];
      },
    };
    elements.set(id as string, element);
  }
  return elements;
}

type FrontDoor = (url: string) => Promise<Response>;

/** Open the page at `search`, with the deployment unreachable and the front door answering `door`. */
async function open(search: string, door?: FrontDoor) {
  const elements = elementsOf(PAGE);
  const asked: string[] = [];
  const replaced: string[] = [];
  const fetch = async (input: string) => {
    const url = String(input);
    if (url.startsWith("https://agent.laf-co.com/entry/dest-status")) {
      asked.push(url);
      if (!door) throw new TypeError("Failed to fetch");
      return door(url);
    }
    // The deployment itself: nothing answers.
    throw new TypeError("Failed to fetch");
  };
  const document = {
    getElementById: (id: string) => {
      const element = elements.get(id);
      if (!element) throw new Error(`the page has no #${id}`);
      return element;
    },
  };
  const location = {
    search,
    replace: (url: string) => void replaced.push(url),
  };
  new Function("document", "location", "fetch", "setInterval", SCRIPT)(
    document,
    location,
    fetch,
    () => 0,
  );
  // Let the probe and the question to the front door both settle.
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const at = (id: string) => elements.get(id) as FakeElement;
  return { at, asked, replaced };
}

const answer =
  (body: unknown, status = 200): FrontDoor =>
  async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

/**
 * A slug laf-control could mint: base32 of a hash, `[a-z2-7]{10}` (`broker/registry.ts` `slugOf`).
 * The contract's own example, `k3m9x2qa7b`, has a 9 in it and is not one — the page is right to
 * ignore it, and this file used it first and learned so.
 */
const TRIAL = "https://k3m7x2qa7b.agent.laf-co.com";
const HOME = "https://agent.laf-co.com";
const opened = `?origin=${encodeURIComponent(TRIAL)}&home=${encodeURIComponent(HOME)}`;

describe("a remembered trial the front door says is kept", () => {
  test("says the trial ended and until when it is kept, and keeps the way to the front door", async () => {
    const page = await open(
      opened,
      answer({ state: "held", holdUntil: "2026-10-29" }),
    );
    expect(page.asked).toEqual([
      `https://agent.laf-co.com/entry/dest-status?origin=${encodeURIComponent(TRIAL)}`,
    ]);
    expect(page.at("held").hidden).toBe(false);
    expect(page.at("unreachable").hidden).toBe(true);
    expect(page.at("held-until").textContent).toBe(
      "만든 봇과 대화는 10월 29일까지 보관합니다. 이어서 쓰려면 문의해 주세요.",
    );
    expect(page.at("home").hidden).toBe(false);
    expect(page.replaced).toEqual([]);
  });
});

describe("every other answer leaves the ordinary card", () => {
  test.each([
    ["an address the front door still routes", answer({ state: "active" })],
    ["an address it does not know", answer({ state: "unknown" })],
    ["held with no date", answer({ state: "held" })],
    [
      "held with a date that is not one",
      answer({ state: "held", holdUntil: "soon" }),
    ],
    ["a front door that failed", answer({ code: "laf:internal" }, 500)],
    ["a front door that answered nonsense", async () => new Response("<html>")],
    ["a front door that could not be reached", undefined],
  ] as const)("%s", async (_, door) => {
    const page = await open(opened, door);
    expect(page.at("held").hidden).toBe(true);
    expect(page.at("unreachable").hidden).toBe(false);
  });
});

describe("what the front door is asked about", () => {
  test.each([
    ["a development origin", "http://localhost:3010"],
    ["the front door itself", "https://agent.laf-co.com"],
    ["a name that is not a customer's slug", "https://shop1.agent.laf-co.com"],
    [
      "a host that only mentions the domain",
      "https://agent.laf-co.com.evil.example",
    ],
    ["plain http under the domain", "http://k3m9x2qa7b.agent.laf-co.com"],
  ])("never %s", async (_, origin) => {
    const page = await open(
      `?origin=${encodeURIComponent(origin)}`,
      answer({ state: "held", holdUntil: "2026-10-29" }),
    );
    expect(page.asked).toEqual([]);
    expect(page.at("held").hidden).toBe(true);
  });
});

describe("the page still does its first job", () => {
  test("a deployment that answers is opened, kept or not", async () => {
    const elements = elementsOf(PAGE);
    const replaced: string[] = [];
    new Function("document", "location", "fetch", "setInterval", SCRIPT)(
      { getElementById: (id: string) => elements.get(id) },
      { search: opened, replace: (url: string) => void replaced.push(url) },
      async (input: string) =>
        String(input).includes("/entry/dest-status")
          ? new Response(
              JSON.stringify({ state: "held", holdUntil: "2026-10-29" }),
            )
          : new Response(null, { status: 200 }),
      () => 0,
    );
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(replaced).toEqual([TRIAL]);
  });
});
