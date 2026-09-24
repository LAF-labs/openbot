import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { ReactElement } from "react";
import { authKeys, type CurrentUser } from "../src/lib/auth/queries";
import { NOTICE_DISMISSED_KEY, seoulDayKey } from "../src/lib/usage/today";
import { mount, unmountAll } from "./support/mount";

/**
 * Today's usage, drawn: the row in Settings and the one line above the composer.
 *
 * Rendered rather than read off the source, because both are decisions about WHEN to draw — nothing
 * on a deployment without a budget, nothing when the count could not be read, the line only from
 * 80%, and gone for the rest of the Seoul day once dismissed — and a decision about drawing is only
 * visible in what gets drawn.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(unmountAll);

function person(trial?: Record<string, unknown>): CurrentUser {
  return {
    id: "user-1",
    email: "owner@laf.test",
    name: "사장님",
    role: "user",
    onboarded: true,
    consentRequired: false,
    deployment: {
      effort: true,
      autoReview: true,
      ...(trial
        ? {
            trial: {
              endsAt: "2026-09-29T14:59:59.999Z",
              holdDays: 30,
              dailyTokenBudget: 1_000_000,
              budgetReachedToday: false,
              ...trial,
            },
          }
        : {}),
    },
  };
}

/** Draws `element` with `/api/me` already answered as `user`, and nothing else reachable. */
async function drawn(user: CurrentUser, element: () => ReactElement) {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(authKeys.currentUser(), user);
  const view = await mount(
    <QueryClientProvider client={queryClient}>{element()}</QueryClientProvider>,
  );
  await view.settle();
  return view;
}

describe("the 오늘 사용량 row in Settings", () => {
  test("draws the share used as a meter and a percent", async () => {
    const { TodayUsageSection } = await import(
      "../src/components/settings/today-usage"
    );
    const view = await drawn(person({ tokensUsedToday: 420_000 }), () => (
      <TodayUsageSection />
    ));
    const meter = view.host.querySelector("progress");
    expect(meter?.getAttribute("value")).toBe("42");
    expect(meter?.getAttribute("max")).toBe("100");
    expect(
      view.host.querySelector('[data-slot="today-usage"]')?.textContent,
    ).toContain("42%");
  });

  test("is not drawn on a deployment without a budget", async () => {
    const { TodayUsageSection } = await import(
      "../src/components/settings/today-usage"
    );
    const view = await drawn(person(), () => <TodayUsageSection />);
    expect(view.host.innerHTML).toBe("");
  });

  test("says so when the server could not read today's count — with no meter, and a way to ask again", async () => {
    /*
     * An empty meter would say "plenty left" on a day that may be one question from the limit, so
     * none is drawn. Nor is nothing, as it was until 2026-09-18: the row vanished with the count, and
     * on the day the number mattered the one place that gives it said nothing, and not that.
     */
    const { TodayUsageSection } = await import(
      "../src/components/settings/today-usage"
    );
    const view = await drawn(person({}), () => <TodayUsageSection />);
    expect(view.host.querySelector("progress")).toBeNull();
    expect(view.host.querySelector('[data-slot="today-usage"]')).toBeNull();
    expect(
      view.host.querySelector('[data-read-state="failed"]')?.textContent,
    ).toContain("Today's usage could not be read.");
    expect(view.host.querySelector("button")?.textContent).toBe("Try again");
  });
});

describe("the line above the composer", () => {
  test("is not there below 80%", async () => {
    const { UsageNotice } = await import(
      "../src/components/channels/usage-notice"
    );
    const view = await drawn(person({ tokensUsedToday: 799_999 }), () => (
      <UsageNotice />
    ));
    expect(view.host.querySelector('[data-slot="usage-notice"]')).toBeNull();
  });

  test("says how much is used from 80%, and goes for the rest of the Seoul day when dismissed", async () => {
    const { UsageNotice } = await import(
      "../src/components/channels/usage-notice"
    );
    const view = await drawn(person({ tokensUsedToday: 850_000 }), () => (
      <UsageNotice />
    ));
    const line = view.host.querySelector('[data-slot="usage-notice"]');
    expect(line?.textContent).toContain("85%");

    const dismiss = line?.querySelector("button");
    if (!dismiss) throw new Error("the line has no way to dismiss it");
    await view.press(dismiss);
    expect(view.host.querySelector('[data-slot="usage-notice"]')).toBeNull();
    expect(window.localStorage.getItem(NOTICE_DISMISSED_KEY)).toBe(
      seoulDayKey(new Date()),
    );

    // Another screen the same day finds it dismissed.
    const again = await drawn(person({ tokensUsedToday: 900_000 }), () => (
      <UsageNotice />
    ));
    expect(again.host.querySelector('[data-slot="usage-notice"]')).toBeNull();
  });

  test("a dismissal from another day does not hide today's", async () => {
    window.localStorage.setItem(NOTICE_DISMISSED_KEY, "2020-01-01");
    const { UsageNotice } = await import(
      "../src/components/channels/usage-notice"
    );
    const view = await drawn(person({ tokensUsedToday: 1_000_000 }), () => (
      <UsageNotice />
    ));
    expect(
      view.host.querySelector('[data-slot="usage-notice"]'),
    ).not.toBeNull();
  });

  test("is nothing at all on a deployment without a budget", async () => {
    const { UsageNotice } = await import(
      "../src/components/channels/usage-notice"
    );
    const view = await drawn(person(), () => <UsageNotice />);
    expect(view.host.innerHTML).toBe("");
  });
});
