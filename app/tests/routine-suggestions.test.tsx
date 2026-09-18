import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTINE_SUGGESTIONS } from "../../server/src/routines/suggestion-catalog";
import { ko } from "../src/lib/i18n-ko";
import {
  type RoutineSuggestion,
  SUGGESTION_REFUSALS,
  SUGGESTION_WHY,
  suggestionFactsLine,
} from "../src/lib/routines/suggestions";
import { stubFetch } from "./support/fetch";
import { json, mount, unmountAll } from "./support/mount";

/**
 * The suggestion cards' words, their one line of facts, and the section itself, pressed.
 *
 * Two tables here are read through `t(variable)` — the sentence saying why a card is worth having
 * and the refusal a press can get back — so `i18n-coverage.test.ts` cannot see them and they are
 * walked, the presets' way. The keys are the server's: its catalogue is read as text, the way
 * `routines-copy.test.ts` reads the routine service, so a card added there fails here until it has
 * its sentence, and a sentence left behind fails until it is removed.
 *
 * THE SECTION IS RENDERED, NOT GREPPED. It used to be asserted as substrings of its source —
 * `aria-busy="true"`, `t("Make")`, a count of `useMutation(` — which passes on a component that
 * draws the busy section forever, or that fires the mutation on mount. What matters is what a
 * press does: nothing until it happens, one POST when it does, and a declined card gone before
 * the server has answered. Those are read off the DOM and off the requests below.
 */

const SERVER = join(import.meta.dir, "../../server/src/routines");
/*
 * The refusal codes are string literals in the server's union types, which leave nothing at runtime
 * to import — so the server's files are read for them. This is the contract between two
 * workspaces, not the component under test.
 */
const SERVICE_SOURCE = `${readFileSync(join(SERVER, "suggestions.ts"), "utf8")}${readFileSync(join(SERVER, "suggestions-routes.ts"), "utf8")}`;

/** The catalogue's keys, from the catalogue itself. */
const catalogueKeys = ROUTINE_SUGGESTIONS.map((entry) => entry.key);

/** The same words `owner-vocabulary.test.ts` keeps off an owner's screen. */
const FORBIDDEN = [
  "에이전트",
  "코워커",
  "어시스턴트",
  "스레드",
  "플러그인",
  "토큰",
  "컴포넌트",
  "MCP",
];

describe("why each card is worth having", () => {
  test("every sentence has Korean", () => {
    const missing = Object.values(SUGGESTION_WHY).filter(
      (sentence) => !(sentence in ko),
    );
    expect(missing).toEqual([]);
  });

  test("the table names every card in the server's catalogue, and no other", () => {
    expect(catalogueKeys.length).toBeGreaterThan(5);
    expect(Object.keys(SUGGESTION_WHY).sort()).toEqual(
      [...catalogueKeys].sort(),
    );
  });

  test("speaks the owner's Korean", () => {
    const offences: string[] = [];
    for (const sentence of Object.values(SUGGESTION_WHY)) {
      const korean = ko[sentence] ?? "";
      for (const word of FORBIDDEN) {
        if (korean.includes(word)) offences.push(`${word}: ${korean}`);
      }
    }
    expect(offences).toEqual([]);
  });
});

describe("the refusals a press can get back", () => {
  test("every one has Korean", () => {
    const missing = Object.values(SUGGESTION_REFUSALS).filter(
      (sentence) => !(sentence in ko),
    );
    expect(missing).toEqual([]);
  });

  test("the table names every code the suggestion routes can send", () => {
    const codes = new Set(
      [...SERVICE_SOURCE.matchAll(/"(laf:routine_suggestion_[a-z_]+)"/g)].map(
        (match) => match[1] as string,
      ),
    );
    expect(codes.size).toBeGreaterThan(0);
    expect([...codes].sort()).toEqual(Object.keys(SUGGESTION_REFUSALS).sort());
  });
});

const card = (
  overrides: Partial<RoutineSuggestion> = {},
): RoutineSuggestion => ({
  key: "morning-brief",
  name: "아침 브리핑",
  instruction: "…",
  schedule: { kind: "daily", time: "07:30", timeZone: "Asia/Seoul" },
  needs: [],
  via: [],
  ...overrides,
});

describe("the card's line of facts", () => {
  test("names what it runs on and says when, with the list's own clock", () => {
    const line = suggestionFactsLine(
      card({
        via: [
          { kind: "site", id: "baemin-ceo", title: "Baemin for Owners" },
          { kind: "account", id: "gmail", title: "Gmail" },
        ],
      }),
    );
    // The runner's locale is English; the Korean side is the dictionary's, checked above.
    expect(line).toContain("Baemin for Owners, Gmail");
    expect(line).toContain("7:30");
    expect(line).not.toContain("07:30");
  });

  test("a card that needs nothing says so, and a weekly one says its day", () => {
    const line = suggestionFactsLine(
      card({
        key: "tax-calendar",
        schedule: {
          kind: "daily",
          time: "09:00",
          timeZone: "Asia/Seoul",
          days: [1],
        },
      }),
    );
    expect(line).toContain("Needs no connection");
    expect(line).toMatch(/Mon/);
  });
});

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmountAll();
  globalThis.fetch = realFetch;
});

type Request = { method: string; url: string; body: unknown };

/**
 * A server with a roster and a handful of cards. Accepting or dismissing takes the card off the
 * list it answers next time, the way the real one does, so the refetch after a press is honest.
 */
function server(options: {
  bots?: number;
  cards?: RoutineSuggestion[];
  suggestionsStatus?: number;
  /** Holds every answer to `/api/routines/suggestions` until released. */
  holdSuggestions?: Promise<void>;
  holdDismiss?: Promise<void>;
}) {
  const requests: Request[] = [];
  let offered = options.cards ?? [];
  const bots = Array.from({ length: options.bots ?? 1 }, (_unused, index) => ({
    id: `bot-${index + 1}`,
    name: index === 0 ? "초롱" : "두리",
  }));
  let suggestionsStatus = options.suggestionsStatus ?? 200;
  globalThis.fetch = stubFetch(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url === "/api/agents") return json({ agents: bots });
    if (url === "/api/routines/suggestions") {
      await options.holdSuggestions;
      const status = suggestionsStatus;
      // A failure is for one answer only; the retry is what this state exists to be pressed for.
      suggestionsStatus = 200;
      return status === 200
        ? json({ suggestions: offered })
        : json({ error: "no" }, status);
    }
    const press = url.match(
      /^\/api\/routines\/suggestions\/([a-z-]+)\/(accept|dismiss)$/,
    );
    if (press) {
      if (press[2] === "dismiss") await options.holdDismiss;
      offered = offered.filter((one) => one.key !== press[1]);
      return json({ ok: true });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  return {
    requests,
    presses: () => requests.filter((request) => request.method === "POST"),
  };
}

async function mountedSection() {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { RoutineSuggestions } = await import(
    "../src/components/routines/suggestions"
  );
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const view = await mount(
    <QueryClientProvider client={client}>
      <RoutineSuggestions />
    </QueryClientProvider>,
  );
  return {
    ...view,
    cards: () => [...view.host.querySelectorAll("li")],
    /** The verbs on a card: its buttons, less the Bot picker's trigger. */
    verbs: (li: Element) =>
      [...li.querySelectorAll("button")]
        .filter((button) => button.dataset.slot !== "select-trigger")
        .map((button) => button.textContent),
    buttonNamed: (li: Element, label: string) =>
      [...li.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      ),
  };
}

describe("the section", () => {
  test("is busy, not blank, while the cards are on their way", async () => {
    let release = () => {};
    server({
      cards: [card()],
      holdSuggestions: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    const view = await mountedSection();
    const section = view.host.querySelector("section");
    expect(section?.getAttribute("aria-busy")).toBe("true");
    expect(section?.querySelector("[data-slot=skeleton]")).not.toBeNull();
    expect(view.cards()).toHaveLength(0);

    release();
    await view.settle();
    expect(view.host.querySelector("section")?.getAttribute("aria-busy")).toBe(
      null,
    );
    expect(view.cards()).toHaveLength(1);
  });

  test("says so when they cannot be loaded, and Try again asks again", async () => {
    const { requests } = server({ cards: [card()], suggestionsStatus: 500 });
    const view = await mountedSection();
    // The region is mounted before it speaks (`LiveRegion`): what matters is whether it has words.
    const spoken = () =>
      [...view.host.querySelectorAll("[role=alert]")].find((alert) =>
        alert.textContent?.trim(),
      ) ?? null;
    expect(spoken()?.textContent).toBe("The suggestions could not be loaded.");
    expect(view.host.querySelector("[aria-busy]")).toBeNull();
    const retry = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    );
    expect(retry).toBeDefined();
    const asked = () =>
      requests.filter((one) => one.url === "/api/routines/suggestions").length;
    expect(asked()).toBe(1);

    if (retry) await view.press(retry);
    expect(asked()).toBe(2);
    expect(spoken() === null).toBe(true);
    expect(view.cards()).toHaveLength(1);
  });

  test("draws nothing when there is nothing to offer", async () => {
    server({ cards: [] });
    const view = await mountedSection();
    // Nothing drawn and nothing said: only the notice, mounted before it speaks, silent and hidden.
    expect(view.host.querySelector("section")).toBeNull();
    expect(view.host.textContent).toBe("");
    expect(view.host.querySelector("[data-read-state]")).toBeNull();
  });

  test("offers exactly two verbs per card, and creates nothing until Make is pressed", async () => {
    const { presses } = server({
      cards: [card(), card({ key: "stock-check", name: "재고 확인" })],
    });
    const view = await mountedSection();
    const cards = view.cards();
    expect(cards).toHaveLength(2);
    for (const one of cards) {
      expect(view.verbs(one)).toEqual(["Make", "Not now"]);
    }
    expect(view.host.textContent).toContain(
      "Nothing is created until you press Make.",
    );
    // With one Bot there is nothing to choose, so the picker is not drawn.
    expect(view.host.querySelector('[aria-label="Which Bot"]')).toBeNull();
    // Rendering is not a request: the only writes are behind a press.
    expect(presses()).toEqual([]);

    const make = view.buttonNamed(cards[0] as Element, "Make");
    if (make) await view.press(make);
    await view.settle();
    expect(presses()).toEqual([
      {
        method: "POST",
        url: "/api/routines/suggestions/morning-brief/accept",
        body: { agentId: "bot-1" },
      },
    ]);
    // The card is gone from here, the routine is in the list below, and a status line says so.
    expect(view.cards().map((one) => one.textContent)).toHaveLength(1);
    // The particle is chosen for the name (`lib/josa.ts`), not spliced in as 이(가).
    expect(view.host.querySelector("section [role=status]")?.textContent).toBe(
      "아침 브리핑이 in the list below now.",
    );
  });

  test("with more than one Bot the card asks which, and sends the choice", async () => {
    const { presses } = server({ bots: 2, cards: [card()] });
    const view = await mountedSection();
    const picker = view.host.querySelector('[aria-label="Which Bot"]');
    expect(picker).not.toBeNull();
    // The first Bot stands in until somebody chooses; the raw `agent_<uuid>` never shows.
    expect(picker?.textContent).toContain("초롱");
    expect(view.verbs(view.cards()[0] as Element)).toEqual(["Make", "Not now"]);

    const make = view.buttonNamed(view.cards()[0] as Element, "Make");
    if (make) await view.press(make);
    expect(presses().map((one) => one.body)).toEqual([{ agentId: "bot-1" }]);
  });

  test("Not now takes the card away on the press, before the server has answered", async () => {
    let release = () => {};
    const { presses } = server({
      cards: [card(), card({ key: "stock-check", name: "재고 확인" })],
      holdDismiss: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    const view = await mountedSection();
    const notNow = view.buttonNamed(view.cards()[0] as Element, "Not now");
    if (notNow) await view.press(notNow);

    // The POST is still in flight, and the card is already gone: optimistic, by construction.
    expect(presses()).toEqual([
      {
        method: "POST",
        url: "/api/routines/suggestions/morning-brief/dismiss",
        body: null,
      },
    ]);
    expect(view.cards().map((one) => one.textContent)).toHaveLength(1);
    expect(view.host.textContent).not.toContain("아침 브리핑");
    expect(view.host.textContent).toContain("재고 확인");

    release();
    await view.settle();
    expect(view.cards()).toHaveLength(1);
    expect(view.host.textContent).not.toContain("아침 브리핑");
  });
});
