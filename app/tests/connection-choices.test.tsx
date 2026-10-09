import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createElement } from "react";

/**
 * 연결's switches in the conversation, and what they say once one turns on (2026-09-28).
 *
 * A switch that turns on while the card is on screen is followed by the first thing to ask with
 * that account, as a sentence to press; pressing it puts the sentence in the composer and sends
 * nothing. One that was already on when the card was drawn says nothing new.
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

const account = (id: string, title: string, status: string) => ({
  kind: "oauth" as const,
  id,
  serverId: null,
  title,
  vendor: title,
  status,
  connectedAt: status === "connected" ? "2026-09-28T00:00:00.000Z" : null,
  account: null,
  needsInstanceName: false,
  health: {
    status: "ok",
    lastOkAt: null,
    lastFailureAt: null,
    failureCode: null,
  },
});

const overview = (canva: string, gmail: string) => ({
  generatedAt: "2026-09-28T00:00:00.000Z",
  accounts: [
    account("canva", "Canva", canva),
    account("gmail", "Gmail", gmail),
  ],
  sites: [],
  bots: [{ id: "bot-1", name: "초롱" }],
});

const SCOPE = "channel_connection-choices-test";

async function mount(
  options: {
    ids?: string[];
    sites?: unknown[];
    onSwitches?: (state: { offered: string[]; connected: string[] }) => void;
  } = {},
) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
    await import("@tanstack/react-router");
  const { ConnectionChoices } = await import(
    "../src/components/connections/connection-choices"
  );
  const { connectionKeys } = await import("../src/lib/connections/queries");
  const { DraftScope } = await import(
    "../src/components/channels/composer/prefill"
  );

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // Gmail was on before the card was drawn; Canva was not.
  client.setQueryData(connectionKeys.overview(), {
    ...overview("not_connected", "connected"),
    sites: options.sites ?? [],
  });
  const rootRoute = createRootRoute({
    /*
     * Inside a conversation of its own, as the Bot's card is: an offer to the compose screen would be
     * taken by any composer another test left mounted in this process.
     */
    component: () =>
      createElement(
        DraftScope.Provider,
        { value: SCOPE },
        createElement(ConnectionChoices, {
          ids: options.ids ?? ["canva", "gmail"],
          ...(options.onSwitches ? { onSwitches: options.onSwitches } : {}),
        }),
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
    turnOn: async () => {
      await act(async () => {
        client.setQueryData(
          connectionKeys.overview(),
          overview("connected", "connected"),
        );
      });
      await settle();
    },
    press: async (element: Element) => {
      await act(async () => {
        element.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
      await settle();
    },
  };
}

describe("a switch turned on in the conversation", () => {
  test("says what it can do now, only for the one that turned on here, and pressing it sends nothing", async () => {
    const { ACCOUNT_FIRST_TASKS } = await import(
      "../src/lib/agents/first-tasks"
    );
    const { t } = await import("../src/lib/i18n");
    const { takeOfferedDraft } = await import(
      "../src/components/channels/composer/prefill"
    );
    const canvaSentence = t(ACCOUNT_FIRST_TASKS.canva?.sentence ?? "");
    const gmailSentence = t(ACCOUNT_FIRST_TASKS.gmail?.sentence ?? "");

    const view = await mount();
    expect(view.host.querySelector('[data-slot="now-can"]')).toBeNull();

    await view.turnOn();
    const chips = [
      ...view.host.querySelectorAll<HTMLButtonElement>(
        '[data-slot="now-can"] button',
      ),
    ];
    expect(chips.map((chip) => chip.textContent)).toEqual([canvaSentence]);
    expect(view.host.textContent).not.toContain(gmailSentence);

    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await view.press(chips[0] as HTMLButtonElement);
    globalThis.fetch = realFetch;
    expect(takeOfferedDraft(SCOPE)).toBe(canvaSentence);
    expect(
      calls.filter(
        (url) => url.includes("/turns") || url.includes("/messages"),
      ),
    ).toEqual([]);
  });
});

/*
 * Since 2026-10-09 nothing on a card can sign a site in: the switch that did went with the handoff.
 * Offered anyway, a site that is off held the Bot's turn ten minutes on a switch that is not there
 * (review, 2026-10-09); the server leaves it out the same way (`readConnectionSwitches`).
 */
describe("a site on a card", () => {
  test("is offered only once it is on: one that is off or lapsed is neither drawn nor told", async () => {
    const site = (id: string, status: string) => ({
      id,
      status,
      botId: status === "not_connected" ? null : "bot-1",
      lastSeenAt: null,
      connectedAt: null,
    });
    const told: { offered: string[]; connected: string[] }[] = [];
    const view = await mount({
      ids: ["naver-smartstore", "baemin-ceo", "coupang-wing"],
      sites: [
        site("naver-smartstore", "not_connected"),
        site("baemin-ceo", "needs_login"),
        site("coupang-wing", "connected"),
      ],
      onSwitches: (state) => told.push(state),
    });
    expect(told.at(-1)).toEqual({
      offered: ["coupang-wing"],
      connected: ["coupang-wing"],
    });
    expect(view.host.querySelectorAll('[role="switch"]')).toHaveLength(1);
  });
});
