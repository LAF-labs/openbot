import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import { channelServer } from "./support/channel-server";

/**
 * `/channel/{id}?draft=<sentence>` STARTS THE COMPOSER WITH THE SENTENCE, ONCE.
 *
 * The agreement between packages A and C for 0.5.3 (UI/UX audit, item 8): a routine's 고치기 opens
 * the conversation with "'주간 매출 요약'을 이렇게 바꿔 줘: " in the box for the person to finish,
 * instead of a form. Measured before this on a local stack: the argument was ignored, the box was
 * empty, and it stayed in the address for a reload to carry.
 *
 * AT PHONE WIDTH, FOR THE FILE AFTER IT. Mounting the conversation reads the window's width once
 * into `lib/computer/screen-panel.ts`, which keeps it for the rest of the process. Run before
 * `detail-sheet.test.tsx` — bun's order is not the alphabet's — this file's wide window was what
 * that file's 375px one read, and the sheet it tests was never drawn: measured in the full gate
 * run. This file does not care how wide it is, and at 375 it leaves what that one expects.
 */

beforeAll(async () => {
  await installAppDom();
  (
    window as unknown as {
      happyDOM: { setWindowSize(size: { width: number }): void };
    }
  ).happyDOM.setWindowSize({ width: 375 });
}, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

const SENTENCE = "'주간 매출 요약'을 이렇게 바꿔 줘: ";

const composerText = (host: HTMLElement) =>
  host.querySelector('[aria-label="Message"]')?.textContent ?? "";

describe("a sentence handed to the conversation", () => {
  test("is in the composer, and no longer in the address", async () => {
    const channelId = "channel_draft-offer";
    const server = channelServer({
      channelId,
      history: [
        {
          id: "q-1",
          role: "user",
          content: "매주 월요일 매출 요약 루틴 만들어 줘",
        },
        { id: "a-1", role: "assistant", content: "루틴을 저장했어요." },
      ],
    });
    /*
     * The address exactly as the routines screen's 고치기 builds it — the other half of the
     * agreement, read from its own module rather than copied here, so a change on either side fails
     * this test instead of leaving an empty box.
     */
    const { editDraft, editInChatHref } = await import(
      "../src/components/routines/edit-in-chat"
    );
    const view = await mountApp({
      path: editInChatHref(channelId, "주간 매출 요약"),
      api: server.api,
    });
    const sentence = editDraft("주간 매출 요약");
    await view.waitFor(
      () => composerText(view.host).trim() === sentence.trim(),
      "the sentence in the composer",
      8000,
    );
    await view.waitFor(
      () => !("draft" in (view.router.state.location.search as object)),
      "the sentence gone from the address",
      8000,
    );
    // Nothing was sent: it is the person's to finish.
    expect(server.runs).toHaveLength(0);
    await view.unmount();
  });

  test("a conversation opened without one starts empty, and the offer is not left behind", async () => {
    const { offerDraft, takeOfferedDraft, withdrawDraft } = await import(
      "../src/components/channels/composer/prefill"
    );
    const channelId = "channel_draft-none";
    offerDraft(channelId, "  ");
    // Blank is not a sentence.
    expect(takeOfferedDraft(channelId)).toBeNull();
    offerDraft(channelId, SENTENCE);
    withdrawDraft(channelId);
    expect(takeOfferedDraft(channelId)).toBeNull();

    const server = channelServer({ channelId, history: [] });
    const view = await mountApp({
      path: `/channel/${channelId}`,
      api: server.api,
    });
    await view.settle(200);
    expect(composerText(view.host).trim()).toBe("");
    await view.unmount();
  });

  test("an offer is taken once, and only by its own conversation", async () => {
    const { offerDraft, takeOfferedDraft } = await import(
      "../src/components/channels/composer/prefill"
    );
    offerDraft("channel_mine", SENTENCE);
    // Another conversation's composer, or the compose screen's, which sits in none.
    expect(takeOfferedDraft("channel_other")).toBeNull();
    expect(takeOfferedDraft(undefined)).toBeNull();
    expect(takeOfferedDraft("channel_mine")).toBe(SENTENCE);
    expect(takeOfferedDraft("channel_mine")).toBeNull();
  });
});

describe("what is in the box when the page reloads for a new build (P1, G6)", () => {
  test("is back in its own conversation's box on the page that loads next, and nothing was sent", async () => {
    const reloader = await import("../src/lib/build-reload");
    const items = new Map<string, string>();
    // The tab's `sessionStorage`: the one thing that outlives the reload.
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, value);
      },
      removeItem: (key: string) => {
        items.delete(key);
      },
    } as unknown as Storage;
    let reloads = 0;
    const thisTab = () =>
      reloader.configureBuildReload({
        readBuild: async () => ({ version: "v0.5.6", revision: "abc1234" }),
        reload: () => {
          reloads += 1;
        },
        storage: () => storage,
      });
    thisTab();
    try {
      const channelId = "channel_draft-reload";
      const server = channelServer({ channelId, history: [] });
      const { editDraft, editInChatHref } = await import(
        "../src/components/routines/edit-in-chat"
      );
      const view = await mountApp({
        path: editInChatHref(channelId, "주간 매출 요약"),
        api: server.api,
      });
      const sentence = editDraft("주간 매출 요약").trim();
      await view.waitFor(
        () => composerText(view.host).trim() === sentence,
        "the sentence in the composer",
        8000,
      );

      // A chunk of the new build is missing: the page reloads, with the box as it is.
      expect(await reloader.recoverFromStaleBuild()).toBe("reloading");
      expect(reloads).toBe(1);
      await view.unmount();

      // The page that loads next, in the same tab.
      thisTab();
      const next = await mountApp({
        path: `/channel/${channelId}`,
        api: server.api,
      });
      await next.waitFor(
        () => composerText(next.host).trim() === sentence,
        "what was typed, back in its box",
        8000,
      );
      expect(server.runs).toHaveLength(0);
      await next.unmount();
    } finally {
      reloader.configureBuildReload(null);
    }
  });
});
