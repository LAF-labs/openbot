import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createElement } from "react";
import type {
  FirstTask,
  FirstTaskPressed,
} from "../src/lib/agents/first-tasks";
import type { AgentProfile } from "../src/lib/agents/queries";
import { stubFetch } from "./support/fetch";

/**
 * THE CHIPS, PRESSED.
 *
 * `first-tasks.test.ts` proves which sentences are chosen; this proves that pressing one does what a
 * typed message does and nothing else: the sentence reaches `onAsk` in the person's language, one
 * browser event says so, and the routine chip goes to `POST /api/routines` with the same sentence.
 * A chip that renders and does nothing when pressed is the failure this stands against — this app
 * has had it (`BotIntroCard` under a `pointer-events-none` overlay), and a green selection test
 * cannot see it.
 *
 * Mounted inside a memory-history router because `Link` refuses to render outside one, and inside
 * a query client because the routine chip is a mutation.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const agent = {
  id: "bot-1",
  name: "초롱",
  roleDescription: "",
} as AgentProfile;

const tasks: FirstTask[] = [
  {
    kind: "ask",
    pattern: "schedule",
    sentence: "Look up today's weather on Naver and tell me.",
    via: null,
  },
  {
    kind: "ask",
    pattern: "reputation",
    sentence: "Write three short introductions for our shop.",
    via: null,
  },
  {
    kind: "ask",
    pattern: "night-watch",
    sentence: "Make a checklist for opening up tomorrow morning.",
    via: null,
  },
  {
    kind: "ask",
    pattern: "enquiries",
    sentence: "Draft a polite reply to a customer asking about a refund.",
    via: null,
  },
  { kind: "connect" },
];

/** The routine chip names the sentence it repeats: the first ask in the row. */
const routineLabel = (t: typeof import("../src/lib/i18n").t) =>
  t("Get “{task}” every morning at 7:30", {
    task: t("Look up today's weather on Naver and tell me."),
  });

async function mounted(props: {
  disabled?: boolean;
  onAsk: (sentence: string) => void;
  /** The row to draw; the four sentences and the general connect chip unless a test says otherwise. */
  tasks?: FirstTask[];
}) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
    await import("@tanstack/react-router");
  const { FirstTaskChips } = await import(
    "../src/components/agents/first-task-chips"
  );

  const rootRoute = createRootRoute({
    component: () =>
      createElement(FirstTaskChips, {
        agent,
        disabled: props.disabled ?? false,
        onAsk: props.onAsk,
        tasks: props.tasks ?? tasks,
      }),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });

  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(RouterProvider, { router }),
      ),
    );
  });
  const settle = async (ms = 30) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };
  await settle();
  return {
    host,
    settle,
    press: async (element: Element) => {
      await act(async () => {
        element.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
      await settle();
    },
    buttons: () => [...host.querySelectorAll<HTMLButtonElement>("button")],
    links: () => [...host.querySelectorAll<HTMLAnchorElement>("a")],
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the first-task chips", () => {
  test("draw every sentence as a button, the connect chip as a link, and the routine chip", async () => {
    const { t } = await import("../src/lib/i18n");
    const view = await mounted({ onAsk: () => {} });

    const labels = view.buttons().map((button) => button.textContent);
    for (const task of tasks) {
      if (task.kind === "ask") expect(labels).toContain(t(task.sentence));
    }
    expect(labels).toContain(routineLabel(t));
    // Four sentences and the routine chip: five buttons, plus the connect link makes six.
    expect(view.buttons()).toHaveLength(5);
    const connect = view
      .links()
      .find((link) =>
        link.getAttribute("href")?.startsWith("/settings/connected-accounts"),
      );
    expect(connect?.textContent).toBe(t("Connect a site"));
  });

  /*
   * 0.5.3 audit, item 12: "사이트 연결하기" was a pill in the row of things to ask, and it left the
   * conversation; "위의 첫 문장을 매일 아침 7:30에" had to be read twice to find which sentence.
   */
  test("the general way to 연결 comes after everything that asks, and is not a pill", async () => {
    const { t } = await import("../src/lib/i18n");
    const view = await mounted({ onAsk: () => {} });
    const pressable = [...view.host.querySelectorAll("a, button")];
    const connect = pressable.find(
      (element) => element.textContent === t("Connect a site"),
    );
    expect(connect?.tagName).toBe("A");
    expect(pressable.at(-1)).toBe(connect);
    expect(connect?.className).not.toContain("rounded-full");
  });

  test("the routine chip says which sentence arrives at 7:30, and it is the first one", async () => {
    const { t } = await import("../src/lib/i18n");
    const view = await mounted({ onAsk: () => {} });
    const routine = view
      .buttons()
      .find((button) => button.textContent?.includes("7:30"));
    expect(routine?.textContent).toContain(
      t("Look up today's weather on Naver and tell me."),
    );
    expect(view.host.textContent).not.toContain("위의 첫 문장");
  });

  test("a picked place that is not connected is named on its own chip, first, and goes to 연결", async () => {
    const { t } = await import("../src/lib/i18n");
    const asks = tasks.filter((task) => task.kind === "ask");
    const view = await mounted({
      onAsk: () => {},
      tasks: [{ kind: "connect", place: "baemin-ceo" }, ...asks],
    });

    const first = view.host.querySelector("a, button");
    expect(first?.tagName).toBe("A");
    expect(first?.textContent).toBe(
      t("Connect {place}", { place: t("Baemin") }),
    );
    expect(first?.getAttribute("href")).toBe("/settings/connected-accounts");
    // The general chip is not drawn beside it: one way to the 연결 screen is enough.
    expect(view.links().map((link) => link.textContent)).not.toContain(
      t("Connect a site"),
    );
  });

  test("a press sends the sentence, in the person's language, and reports itself once", async () => {
    const { t } = await import("../src/lib/i18n");
    const { FIRST_TASK_PRESSED } = await import(
      "../src/lib/agents/first-tasks"
    );
    const asked: string[] = [];
    const reported: FirstTaskPressed[] = [];
    const posted: { url: string; method?: string; body: unknown }[] = [];
    globalThis.fetch = stubFetch(async (url, init) => {
      posted.push({
        url: String(url),
        method: init?.method,
        body: JSON.parse(String(init?.body ?? "null")),
      });
      return new Response(null, { status: 204 });
    });
    const listener = (event: Event) => {
      reported.push((event as CustomEvent<FirstTaskPressed>).detail);
    };
    window.addEventListener(FIRST_TASK_PRESSED, listener);
    try {
      const view = await mounted({ onAsk: (sentence) => asked.push(sentence) });
      const second = view
        .buttons()
        .find(
          (button) =>
            button.textContent ===
            t("Write three short introductions for our shop."),
        );
      if (!second) throw new Error("the second chip is not on screen");
      await view.press(second);

      expect(asked).toEqual([
        t("Write three short introductions for our shop."),
      ]);
      expect(reported).toEqual([
        {
          agentId: "bot-1",
          kind: "ask",
          pattern: "reputation",
          sentence: "Write three short introductions for our shop.",
          via: null,
          hint: null,
        },
      ]);
      /*
       * And once to the server, which is what the fleet counts — the keys of the chip, and not the
       * sentence in either language: `kind` and `pattern` already name it.
       */
      expect(posted).toEqual([
        {
          url: "/api/me/first-task",
          method: "POST",
          body: {
            agentId: "bot-1",
            kind: "ask",
            pattern: "reputation",
            via: null,
            hint: null,
          },
        },
      ]);
      const wire = JSON.stringify(posted);
      expect(wire).not.toContain("Write three short introductions");
      expect(wire).not.toContain(
        t("Write three short introductions for our shop."),
      );
    } finally {
      window.removeEventListener(FIRST_TASK_PRESSED, listener);
    }
  });

  test("while a first message is on its way, a second chip cannot start a second channel", async () => {
    const asked: string[] = [];
    const view = await mounted({
      disabled: true,
      onAsk: (sentence) => asked.push(sentence),
    });
    const sentences = view
      .buttons()
      .filter((button) => !button.textContent?.includes("7:30"));
    for (const button of sentences.slice(0, 4)) {
      expect(button.disabled).toBe(true);
      await view.press(button);
    }
    expect(asked).toEqual([]);
  });

  test("the routine chip makes the first sentence a 7:30 routine and says where it went", async () => {
    const { t } = await import("../src/lib/i18n");
    const { FIRST_TASK_PRESSED } = await import(
      "../src/lib/agents/first-tasks"
    );
    const requests: { url: string; body: unknown }[] = [];
    globalThis.fetch = stubFetch(async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "null")),
      });
      return new Response(JSON.stringify({ routine: { id: "routine-1" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    const reported: FirstTaskPressed[] = [];
    const listener = (event: Event) => {
      reported.push((event as CustomEvent<FirstTaskPressed>).detail);
    };
    window.addEventListener(FIRST_TASK_PRESSED, listener);
    try {
      const view = await mounted({ onAsk: () => {} });
      const routine = view
        .buttons()
        .find((button) => button.textContent === routineLabel(t));
      if (!routine) throw new Error("the routine chip is not on screen");
      await view.press(routine);
      await view.settle(50);

      // The press is reported first, as the keys of the chip; then the routine is made.
      expect(requests).toHaveLength(2);
      expect(requests[0]).toEqual({
        url: "/api/me/first-task",
        body: {
          agentId: "bot-1",
          kind: "routine",
          pattern: "schedule",
          via: null,
          hint: null,
        },
      });
      expect(requests[1]?.url).toBe("/api/routines");
      expect(requests[1]?.body).toEqual({
        agentId: "bot-1",
        name: t("Morning report"),
        instruction: t("Look up today's weather on Naver and tell me."),
        schedule: {
          kind: "daily",
          time: "07:30",
          timeZone: expect.any(String),
        },
      });
      expect(reported.map((event) => event.kind)).toEqual(["routine"]);
      expect(view.host.textContent).toContain(t("The routine is made."));
      expect(
        view.links().some((link) => link.getAttribute("href") === "/routines"),
      ).toBe(true);
    } finally {
      window.removeEventListener(FIRST_TASK_PRESSED, listener);
    }
  });
});
