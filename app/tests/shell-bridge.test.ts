import { afterEach, describe, expect, test } from "bun:test";
import {
  inShell,
  requestShellNoticePermission,
  setShellBadge,
  shellNoticePermission,
  showShellNotice,
} from "../src/lib/notifications/shell";

/**
 * The bridge is a feature detection with two exits. In a browser tab every call answers "no" and
 * the web app is unchanged; in the shell the call goes through the global. Both exits are pinned,
 * because the failure of either is silent: a badge that never appears, or a notification that is
 * attempted through an API that is not there.
 */

type WindowWithTauri = typeof globalThis & { __TAURI__?: unknown };

afterEach(() => {
  (globalThis as WindowWithTauri).__TAURI__ = undefined;
});

describe("in a browser tab", () => {
  test("there is no shell, and nothing is attempted", async () => {
    expect(inShell()).toBe(false);
    expect(await setShellBadge(3)).toBe(false);
    expect(await showShellNotice({ title: "x", body: "y", silent: true })).toBe(
      false,
    );
    // Null rather than a permission word: the browser's own `Notification` is what answers there.
    expect(await shellNoticePermission()).toBeNull();
    expect(await requestShellNoticePermission()).toBeNull();
  });
});

describe("in the shell", () => {
  test("the badge goes through the command, zero included", async () => {
    const calls: Array<[string, unknown]> = [];
    (globalThis as WindowWithTauri).__TAURI__ = {
      core: {
        invoke: async (command: string, args: unknown) => {
          calls.push([command, args]);
        },
      },
    };
    expect(inShell()).toBe(true);
    expect(await setShellBadge(4)).toBe(true);
    expect(await setShellBadge(0)).toBe(true);
    expect(calls).toEqual([
      ["set_badge", { count: 4 }],
      ["set_badge", { count: 0 }],
    ]);
  });

  test("a notification asks for permission once and sends when granted", async () => {
    const sent: unknown[] = [];
    let asked = 0;
    (globalThis as WindowWithTauri).__TAURI__ = {
      notification: {
        isPermissionGranted: async () => false,
        requestPermission: async () => {
          asked += 1;
          return "granted";
        },
        sendNotification: (options: unknown) => {
          sent.push(options);
        },
      },
    };
    expect(
      await showShellNotice({
        title: "리스크 분석가",
        body: "확인",
        silent: true,
      }),
    ).toBe(true);
    expect(asked).toBe(1);
    expect(sent).toEqual([
      { title: "리스크 분석가", body: "확인", silent: true },
    ]);
  });

  test("a refused permission falls back rather than throwing", async () => {
    (globalThis as WindowWithTauri).__TAURI__ = {
      notification: {
        isPermissionGranted: async () => false,
        requestPermission: async () => "denied",
        sendNotification: () => {
          throw new Error("must not be called");
        },
      },
    };
    expect(
      await showShellNotice({ title: "x", body: "y", silent: false }),
    ).toBe(false);
  });

  /**
   * The half of this the shell could not answer for itself.
   *
   * WKWebView has no `Notification`, so the app's synchronous check calls the whole feature
   * unsupported and never drew the control that turns it on — in the one surface this product
   * leads with. These two are what the control asks instead.
   */
  test("permission is readable and askable through the bridge", async () => {
    let granted = false;
    let asked = 0;
    (globalThis as WindowWithTauri).__TAURI__ = {
      notification: {
        isPermissionGranted: async () => granted,
        requestPermission: async () => {
          asked += 1;
          granted = true;
          return "granted";
        },
        sendNotification: () => {},
      },
    };

    // Not-granted is "worth asking", never "denied": the plugin has no third answer, and reporting
    // a refusal that never happened would draw the one state with no way out of it.
    expect(await shellNoticePermission()).toBe("ask");
    expect(await requestShellNoticePermission()).toBe("granted");
    expect(await shellNoticePermission()).toBe("granted");
    // Already granted, so nothing is asked a second time.
    expect(await requestShellNoticePermission()).toBe("granted");
    expect(asked).toBe(1);
  });

  test("a permission the person refuses is reported as refused", async () => {
    (globalThis as WindowWithTauri).__TAURI__ = {
      notification: {
        isPermissionGranted: async () => false,
        requestPermission: async () => "denied",
        sendNotification: () => {},
      },
    };
    expect(await requestShellNoticePermission()).toBe("denied");
  });

  test("a shell whose command throws is reported as no badge, not as an error", async () => {
    (globalThis as WindowWithTauri).__TAURI__ = {
      core: {
        invoke: async () => {
          throw new Error("not allowed");
        },
      },
    };
    expect(await setShellBadge(1)).toBe(false);
  });
});
