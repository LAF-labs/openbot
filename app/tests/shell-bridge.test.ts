import { afterEach, describe, expect, test } from "bun:test";
import {
  inShell,
  setShellBadge,
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
