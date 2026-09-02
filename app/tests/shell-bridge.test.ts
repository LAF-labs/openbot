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

  /**
   * A notice goes through the shell's OWN command, not the notification plugin's binding.
   *
   * Two things ride on that and both are invisible if it regresses to the plugin: the tray's mute,
   * which a page able to post directly could route around, and the destination, which is the only
   * record of where the notice pointed once the plugin has shown it and forgotten it.
   */
  test("a notification asks for permission once and posts through the shell", async () => {
    const calls: Array<[string, unknown]> = [];
    let asked = 0;
    (globalThis as WindowWithTauri).__TAURI__ = {
      core: {
        invoke: async (command: string, args: unknown) => {
          calls.push([command, args]);
        },
      },
      notification: {
        isPermissionGranted: async () => false,
        requestPermission: async () => {
          asked += 1;
          return "granted";
        },
      },
    };
    expect(
      await showShellNotice({
        title: "리스크 분석가",
        body: "확인",
        silent: true,
        destination: { kind: "approve", id: "a1" },
      }),
    ).toBe(true);
    expect(asked).toBe(1);
    expect(calls).toEqual([
      [
        "post_notice",
        {
          title: "리스크 분석가",
          body: "확인",
          silent: true,
          destination: { kind: "approve", id: "a1" },
        },
      ],
    ]);
  });

  /** A notice with nowhere to go is still a notice; the shell is told so rather than left guessing. */
  test("a notice with no destination says so", async () => {
    const calls: Array<[string, unknown]> = [];
    (globalThis as WindowWithTauri).__TAURI__ = {
      core: {
        invoke: async (command: string, args: unknown) => {
          calls.push([command, args]);
        },
      },
      notification: { isPermissionGranted: async () => true },
    };
    expect(
      await showShellNotice({ title: "x", body: "y", silent: false }),
    ).toBe(true);
    expect(calls).toEqual([
      [
        "post_notice",
        { title: "x", body: "y", silent: false, destination: null },
      ],
    ]);
  });

  test("a refused permission falls back rather than throwing", async () => {
    (globalThis as WindowWithTauri).__TAURI__ = {
      core: {
        invoke: async () => {
          throw new Error("must not be called");
        },
      },
      notification: {
        isPermissionGranted: async () => false,
        requestPermission: async () => "denied",
      },
    };
    expect(
      await showShellNotice({ title: "x", body: "y", silent: false }),
    ).toBe(false);
  });

  /**
   * A shell that refused because the person muted it in the tray answers the same as one that
   * posted: handled. Falling back to the webview's own notification would undo the switch they had
   * just pressed — and `post_notice` resolving with nothing to say is exactly what a mute looks
   * like from here.
   */
  test("a shell that stayed quiet is not a shell that failed", async () => {
    (globalThis as WindowWithTauri).__TAURI__ = {
      core: { invoke: async () => undefined },
      notification: { isPermissionGranted: async () => true },
    };
    expect(
      await showShellNotice({ title: "x", body: "y", silent: false }),
    ).toBe(true);
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
