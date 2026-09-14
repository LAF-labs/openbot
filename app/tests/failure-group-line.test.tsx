import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { FailureGroup } from "../src/lib/channels/turn-failure";
import { activeLocale } from "../src/lib/i18n";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  type ApiRequest,
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import { channelServer } from "./support/channel-server";

/**
 * A ROUTINE FAILING THE SAME WAY EVERY HOUR IS ONE LINE, AND 확인 MAKES IT STOP BEING RED.
 *
 * MEASURED 2026-09-14 on a running server and agent-bot, a provider refusing every request: ten runs
 * of an hourly routine left ten `**리뷰 확인**` headings in the Bot's conversation and ten red lines
 * under them. The server now counts a repeat into the first failure's group and writes nothing else
 * (`server/src/notifications/failure-groups.ts`); this is the surface's half — the one line saying
 * how many and when last, and the press that quiets it.
 *
 * The real channel route, with the server stubbed at the network edge (`support/channel-server`).
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

const line = '[data-testid="transcript-stopped"]';
const REFUSED = "laf:turn_rate_limited";

/** The routine's heading, as `routines/deliver.ts` writes a failure's mark into the conversation. */
const heading = (id: string) => ({
  id,
  role: "assistant",
  content: "**리뷰 확인**",
});

function group(overrides: Partial<FailureGroup> = {}): FailureGroup {
  return {
    id: "group-1",
    count: 7,
    lastAt: new Date().toISOString(),
    acknowledged: false,
    closed: false,
    ...overrides,
  };
}

/** The channel, plus the one route 확인 reaches, recording what it was sent. */
function conversation(options: {
  channelId: string;
  history: { id: string; role: string; content: string }[];
  failures: {
    messageId: string;
    code: string;
    at: string;
    group?: FailureGroup;
  }[];
}) {
  const server = channelServer(options);
  const acknowledged: string[] = [];
  const api = (request: ApiRequest) => {
    const match = /^\/api\/me\/notifications\/([^/]+)\/acknowledge$/.exec(
      request.pathname,
    );
    if (match?.[1] && request.method === "POST") {
      const id = decodeURIComponent(match[1]);
      acknowledged.push(id);
      // What the server holds from now on, so the refetch the press causes reads it back.
      for (const failure of options.failures) {
        if (failure.group?.id === id) failure.group.acknowledged = true;
      }
      return new Response(null, { status: 204 });
    }
    return server.api(request);
  };
  return { api, acknowledged };
}

describe("a routine's failure that keeps happening", () => {
  test("is one red line that says how many times and when last, and 확인 quiets it", async () => {
    const lastAt = new Date();
    lastAt.setHours(9, 0, 0, 0);
    const failures = [
      {
        messageId: "m-routine",
        code: REFUSED,
        at: new Date(lastAt.getTime() - 6 * 60 * 60 * 1000).toISOString(),
        group: group({ lastAt: lastAt.toISOString() }),
      },
    ];
    const { api, acknowledged } = conversation({
      channelId: "channel_group-loud",
      history: [heading("m-routine")],
      failures,
    });
    const view = await mountApp({ path: "/channel/channel_group-loud", api });
    await view.waitFor(
      () => view.host.querySelector(line) !== null,
      "the failure line under the routine's heading",
      8000,
    );

    const drawn = view.host.querySelector(line);
    const clock = lastAt.toLocaleTimeString(activeLocale, {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(drawn?.textContent).toContain(
      `Failed 7 times for the same reason · last ${clock}`,
    );
    expect(drawn?.getAttribute("role")).toBe("alert");
    expect(drawn?.hasAttribute("data-quiet")).toBe(false);
    // Nothing to ask again: a routine runs at its next slot, and its heading is not a question.
    expect(view.buttonNamed("Try again")).toBeUndefined();

    const press = view.buttonNamed("Acknowledge");
    expect(press).toBeDefined();
    await view.click(press as Element);
    await view.waitFor(
      () => acknowledged.length === 1,
      "the acknowledgement to reach the server",
      8000,
    );
    expect(acknowledged).toEqual(["group-1"]);

    // Quiet, not gone: the record of what happened stays, and it no longer asks to be read.
    await view.waitFor(
      () => view.host.querySelector(line)?.getAttribute("role") === "status",
      "the line to go quiet",
      8000,
    );
    const quiet = view.host.querySelector(line);
    expect(quiet?.getAttribute("data-quiet")).toBe("true");
    expect(quiet?.textContent).toContain("Failed 7 times for the same reason");
    expect(view.buttonNamed("Acknowledge")).toBeUndefined();
    await view.unmount();
  });

  test("a group a success closed, or one already acknowledged, is quiet with nothing to press", async () => {
    const { api } = conversation({
      channelId: "channel_group-quiet",
      history: [
        heading("m-closed"),
        heading("m-acknowledged"),
        heading("m-once"),
      ],
      failures: [
        {
          messageId: "m-closed",
          code: REFUSED,
          at: "2026-09-13T01:00:00.000Z",
          group: group({ id: "group-closed", count: 3, closed: true }),
        },
        {
          messageId: "m-acknowledged",
          code: REFUSED,
          at: "2026-09-13T05:00:00.000Z",
          group: group({ id: "group-acknowledged", acknowledged: true }),
        },
        {
          // The first failure of a group that has not repeated yet: no count, but 확인 is offered —
          // saying "I know" before the second buzz is the point of it.
          messageId: "m-once",
          code: REFUSED,
          at: "2026-09-13T09:00:00.000Z",
          group: group({ id: "group-once", count: 1 }),
        },
      ],
    });
    const view = await mountApp({ path: "/channel/channel_group-quiet", api });
    await view.waitFor(
      () => view.host.querySelectorAll(line).length === 3,
      "the three failure lines",
      8000,
    );

    const [closed, acknowledged, once] = [...view.host.querySelectorAll(line)];
    expect(closed?.getAttribute("data-quiet")).toBe("true");
    expect(closed?.textContent).toContain("Failed 3 times for the same reason");
    expect(acknowledged?.getAttribute("data-quiet")).toBe("true");
    expect(once?.hasAttribute("data-quiet")).toBe(false);
    expect(once?.textContent).not.toContain("for the same reason");
    const presses = [...view.host.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === "Acknowledge",
    );
    expect(presses).toHaveLength(1);
    expect(once?.contains(presses[0] ?? null)).toBe(true);
    await view.unmount();
  });

  test("says it in Korean", () => {
    expect(ko["Failed {count} times for the same reason · last {time}"]).toBe(
      "같은 이유로 {count}번 실패 · 마지막 {time}",
    );
    expect(ko.Acknowledge).toBe("확인");
  });
});
