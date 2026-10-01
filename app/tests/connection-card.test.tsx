import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { connectionAnswer } from "@shared/tools/gallery";
import { createElement } from "react";

/**
 * THE CONNECT CARD A BOT'S TURN WAITS ON (2026-10-02).
 *
 * `showConnection` put 연결's switches in the conversation and the turn ended there, so a person who
 * turned one on had to ask for the same thing again. The call is a question now: the card answers it
 * when a switch turns on while it is on screen, or when the person presses 다음에, and the Bot goes
 * on. What is held here is what the card answers and when; that the server reads 연결 for itself
 * rather than believing the card is `server/tests/chat-tools.test.ts`.
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

const account = (id: string, status: string) => ({
  kind: "oauth" as const,
  id,
  serverId: null,
  title: id,
  vendor: id,
  status,
  connectedAt: status === "connected" ? "2026-10-02T00:00:00.000Z" : null,
  account: null,
  needsInstanceName: false,
  health: {
    status: "ok",
    lastOkAt: null,
    lastFailureAt: null,
    failureCode: null,
  },
});

const overview = (statuses: Record<string, string>) => ({
  generatedAt: "2026-10-02T00:00:00.000Z",
  accounts: Object.entries(statuses).map(([id, status]) => account(id, status)),
  sites: [],
  bots: [{ id: "bot-1", name: "초롱" }],
});

type CardProps = {
  status: "inProgress" | "executing" | "complete";
  args: { services?: string[]; reason?: string };
  respond?: (value: unknown) => Promise<void>;
  result?: string;
};

async function mount(statuses: Record<string, string>, props: CardProps) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
    await import("@tanstack/react-router");
  const { ConnectionCard } = await import("../src/components/gallery/connect");
  const { connectionKeys } = await import("../src/lib/connections/queries");
  const { DraftScope } = await import(
    "../src/components/channels/composer/prefill"
  );

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(connectionKeys.overview(), overview(statuses));
  const Card = ConnectionCard as (
    props: CardProps,
  ) => ReturnType<typeof ConnectionCard>;
  const rootRoute = createRootRoute({
    component: () =>
      createElement(
        DraftScope.Provider,
        { value: "channel_connection-card-test" },
        createElement(Card, props),
      ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const settle = async (ms = 30) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };
  // The watched card re-asks the overview; in here that is a read of what the test last set.
  const realFetch = globalThis.fetch;
  let current = statuses;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(overview(current)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(RouterProvider, { router }),
      ),
    );
  });
  await settle();
  return {
    host,
    settle,
    button: (label: string) =>
      [...host.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      ),
    set: async (next: Record<string, string>) => {
      current = next;
      await act(async () => {
        client.setQueryData(connectionKeys.overview(), overview(next));
      });
      await settle();
    },
    press: async (element: Element | undefined) => {
      await act(async () => {
        element?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
      await settle();
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      globalThis.fetch = realFetch;
    },
  };
}

/** A `respond` that writes down what it was handed. */
const recorder = () => {
  const answers: unknown[] = [];
  return {
    answers,
    respond: async (value: unknown) => {
      answers.push(value);
    },
  };
};

const OFFERED = ["canva", "gmail"];

describe("a connect card the Bot is waiting on", () => {
  test("says it is waiting, and 다음에 answers with what is true — nothing on", async () => {
    const { ko } = await import("../src/lib/i18n-ko");
    const { answers, respond } = recorder();
    const view = await mount(
      { canva: "not_connected", gmail: "not_connected" },
      { status: "executing", args: { services: OFFERED }, respond },
    );
    expect(view.host.textContent).toContain("Waiting on you");
    expect(view.host.textContent).toContain(
      "I'll carry on as soon as one is connected.",
    );
    expect(ko["I'll carry on as soon as one is connected."]).toBe(
      "연결되면 바로 이어서 할게요.",
    );
    // Drawn and waiting: nothing has been answered on the card's own account.
    expect(answers).toEqual([]);

    await view.press(view.button("Not now"));
    expect(answers).toEqual([
      connectionAnswer({ offered: OFFERED, connected: [] }),
    ]);
    expect((answers[0] as { code: string }).code).toBe("laf:connection_off");
    // Once: the button is spent.
    await view.press(view.button("Not now"));
    expect(answers.length).toBe(1);
    await view.unmount();
  });

  test("a switch that turns on while it waits answers the Bot, once, with everything that is on", async () => {
    const { answers, respond } = recorder();
    const view = await mount(
      { canva: "not_connected", gmail: "connected" },
      { status: "executing", args: { services: OFFERED }, respond },
    );
    // Gmail was on already: not news, and not a reason to stop waiting for Canva.
    expect(answers).toEqual([]);
    await view.set({ canva: "connected", gmail: "connected" });
    expect(answers).toEqual([
      connectionAnswer({ offered: OFFERED, connected: ["canva", "gmail"] }),
    ]);
    // The Bot is about to go on: no "now you can ask" chips under a card it is waiting on.
    expect(view.host.querySelector('[data-slot="now-can"]')).toBeNull();
    await view.unmount();
  });

  test("with one already on, 다음에 says so rather than that nothing is", async () => {
    const { answers, respond } = recorder();
    const view = await mount(
      { canva: "not_connected", gmail: "connected" },
      { status: "executing", args: { services: OFFERED }, respond },
    );
    await view.press(view.button("Not now"));
    expect(answers).toEqual([
      connectionAnswer({ offered: OFFERED, connected: ["gmail"] }),
    ]);
    await view.unmount();
  });

  test("every switch already on is answered without anybody pressing anything", async () => {
    const { answers, respond } = recorder();
    const view = await mount(
      { canva: "connected", gmail: "connected" },
      { status: "executing", args: { services: OFFERED }, respond },
    );
    expect(answers).toEqual([
      connectionAnswer({ offered: OFFERED, connected: ["canva", "gmail"] }),
    ]);
    await view.unmount();
  });

  test("a service this deployment has no switch for is answered as not offered, not waited on", async () => {
    const { answers, respond } = recorder();
    const view = await mount(
      { gmail: "connected" },
      { status: "executing", args: { services: ["canva"] }, respond },
    );
    expect(answers).toEqual([
      connectionAnswer({ offered: ["canva"], connected: [], isOffered: false }),
    ]);
    await view.unmount();
  });
});

describe("a connect card that has its answer", () => {
  test("shows 연결됨 and its switches, and no 다음에", async () => {
    const view = await mount(
      { canva: "connected", gmail: "not_connected" },
      {
        status: "complete",
        args: { services: OFFERED },
        result: JSON.stringify(
          connectionAnswer({ offered: OFFERED, connected: ["canva"] }),
        ),
      },
    );
    expect(view.host.textContent).toContain("Connected");
    expect(view.button("Not now")).toBeUndefined();
    expect(
      view.host.querySelector('[data-slot="connection-choices"]'),
    ).not.toBeNull();
    await view.unmount();
  });

  test("shows 다음에 when that was the answer, with the switches still there to turn on later", async () => {
    const view = await mount(
      { canva: "not_connected", gmail: "not_connected" },
      {
        status: "complete",
        args: { services: OFFERED },
        result: JSON.stringify(
          connectionAnswer({ offered: OFFERED, connected: [] }),
        ),
      },
    );
    expect(view.host.textContent).toContain("Not now");
    expect(view.button("Not now")).toBeUndefined();
    expect(
      view.host.querySelector('[data-slot="connection-choices"]'),
    ).not.toBeNull();
    await view.unmount();
  });

  test("an answer from before the card waited — a sentence, not a fact — draws the switches and no badge", async () => {
    const view = await mount(
      { canva: "not_connected", gmail: "not_connected" },
      {
        status: "complete",
        args: { services: OFFERED },
        result:
          "The switches this deployment offers are on screen; one it does not offer is left out.",
      },
    );
    expect(view.host.textContent).not.toContain("Waiting on you");
    expect(view.host.textContent).not.toContain("Not now");
    expect(
      view.host.querySelector('[data-slot="connection-choices"]'),
    ).not.toBeNull();
    await view.unmount();
  });
});
