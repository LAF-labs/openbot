import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createElement } from "react";
import type { ControlState } from "../src/components/computer/take-the-wheel";
import { stubFetch } from "./support/fetch";

/**
 * THE ONE POLL THAT RAN IN A HIDDEN TAB, AND RAN FOREVER.
 *
 * MEASURED 2026-09-10 (audit A4, finding 4): `useNeedsYou` was a bare three-second `setInterval` —
 * twenty reads of `/api/computers/:bot/control` a minute on an idle conversation, eighteen in
 * fifty-four seconds with the tab hidden, and no way of ever stopping. The fact it wanted already
 * arrives twice over: through the shared control loop the computer cards run on, which settles,
 * and through the outbox's notification frames on the socket. This mounts the hook and counts.
 */

const BOT: ControlState = {
  holder: "bot",
  since: "2026-09-10T00:00:00Z",
  requested: false,
};

let originalFetch: typeof fetch;
let reads: string[] = [];
let answer: () => Response;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  originalFetch = globalThis.fetch;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Wait until the loop has stopped asking, and answer with how many times it asked. */
async function quiet(): Promise<number> {
  let previous = -1;
  while (previous !== reads.length) {
    previous = reads.length;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return reads.length;
}

async function mounted(botId: string, firstAnswer?: () => Response) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  // After the DOM exists: the hook's module makes event targets when it is evaluated.
  const { useNeedsYou } = await import("../src/components/computer/needs-you");
  const controlPoll = await import("../src/components/computer/control-poll");

  reads = [];
  answer = firstAnswer ?? (() => Response.json(BOT));
  globalThis.fetch = stubFetch(async (url) => {
    reads.push(String(url));
    return answer();
  });
  /*
   * The shared loop is opened here first, at no interval, and allowed to settle: the hook joins
   * whichever loop exists for its Bot, and a loop at the real one-second pace would make every
   * wait below a second long. What is counted is what the HOOK causes from its mount on.
   */
  const stopSeed = controlPoll.watchControl(
    botId,
    { isLive: () => false, onState: () => {} },
    0,
  );
  await quiet();
  reads = [];

  const Probe = () => {
    const needed = useNeedsYou(botId, true);
    return createElement("p", null, needed ? "needs you" : "fine");
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Probe));
  });
  return {
    host,
    controlPoll,
    settle: async (ms: number) => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    },
    /*
     * Inside `act`, so the state the loop sets while the body runs is flushed before the body's
     * caller looks: a read that lands outside any act scope is applied on React's own scheduler,
     * whose timing under a test runner is nobody's promise.
     */
    during: async (body: () => Promise<void>) => {
      await act(async () => {
        await body();
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      stopSeed();
    },
  };
}

describe("a closed screen's sign that the Bot is waiting", () => {
  test("reads until the answer settles, and then not at all", async () => {
    const view = await mounted("bot-quiet");
    const settled = await quiet();
    // Joining wakes the loop for one run of identical reads, and then it is silent.
    expect(settled).toBe(view.controlPoll.SETTLED_READS);
    await view.settle(120);
    expect(reads.length).toBe(settled);
    expect(
      reads.every((url) => url.includes("/computers/bot-quiet/control")),
    ).toBe(true);
    await view.unmount();
  });

  test("is woken by a notification frame for this Bot, and not by another Bot's", async () => {
    const view = await mounted("bot-mine");
    const before = await quiet();
    const { NOTIFICATION_FRAME, notificationFrames } = await import(
      "../src/lib/notifications/outbox"
    );
    const frame = (botId: string) =>
      new CustomEvent(NOTIFICATION_FRAME, {
        detail: {
          kind: "notification",
          id: "n1",
          event: "run.needs_you",
          botId,
          at: "2026-09-10T00:00:01Z",
        },
      });

    notificationFrames.dispatchEvent(frame("bot-somebody-else"));
    await view.settle(60);
    expect(reads.length).toBe(before);

    answer = () => Response.json({ ...BOT, requested: true, reason: "login" });
    await view.during(async () => {
      notificationFrames.dispatchEvent(frame("bot-mine"));
      await quiet();
    });
    expect(reads.length).toBeGreaterThan(before);
    expect(view.host.textContent).toBe("needs you");
    await view.unmount();
  });

  test("is woken when the tab is looked at again", async () => {
    const view = await mounted("bot-tab");
    const before = await quiet();
    await view.during(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await quiet();
    });
    expect(reads.length).toBeGreaterThan(before);
    await view.unmount();
  });

  test("a deployment with no computer is never asked again", async () => {
    const view = await mounted(
      "bot-none",
      () => new Response("null", { status: 404 }),
    );
    await quiet();
    await view.settle(60);
    // The seed's one read learned there is no control surface; the hook's mount adds nothing.
    expect(reads.length).toBe(0);
    expect(view.host.textContent).toBe("fine");
    await view.unmount();
  });
});
