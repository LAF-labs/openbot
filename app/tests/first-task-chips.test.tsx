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
  title: "",
  roleDescription: "",
} as AgentProfile;

const tasks: FirstTask[] = [
  {
    kind: "ask",
    pattern: "schedule",
    sentence: "Tell me today's date and this week's public holidays.",
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

async function mounted(props: {
  disabled?: boolean;
  onAsk: (sentence: string) => void;
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
        hint: null,
        onAsk: props.onAsk,
        tasks,
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
    expect(labels).toContain(t("Get a report every morning at 7:30"));
    // Four sentences and the routine chip: five buttons, plus the connect link makes six.
    expect(view.buttons()).toHaveLength(5);
    const connect = view
      .links()
      .find((link) =>
        link.getAttribute("href")?.startsWith("/settings/connected-accounts"),
      );
    expect(connect?.textContent).toBe(t("Connect a site"));
  });

  test("a press sends the sentence, in the person's language, and reports itself once", async () => {
    const { t } = await import("../src/lib/i18n");
    const { FIRST_TASK_PRESSED } = await import(
      "../src/lib/agents/first-tasks"
    );
    const asked: string[] = [];
    const reported: FirstTaskPressed[] = [];
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
      .filter((button) => button.textContent !== "매일 아침 7:30에 보고받기");
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
        .find(
          (button) =>
            button.textContent === t("Get a report every morning at 7:30"),
        );
      if (!routine) throw new Error("the routine chip is not on screen");
      await view.press(routine);
      await view.settle(50);

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("/api/routines");
      expect(requests[0]?.body).toEqual({
        agentId: "bot-1",
        name: t("Morning report"),
        instruction: t("Tell me today's date and this week's public holidays."),
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
