import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRESENCE_LABELS, type PresenceKind } from "../src/lib/agents/presence";
import {
  onShellDownload,
  onShellUpdateReady,
  restartToUpdate,
  setShellStatus,
  setShellSummonShortcut,
  type ShellDownload,
  shellDownloadOf,
  shellStatusOf,
  shellSummonShortcut,
  shellUpdateReady,
  summonKeysOf,
  summonSettingOf,
} from "../src/lib/notifications/shell";

/**
 * What keeps the installed app awake and reachable with its window put away (2026-09-26): the
 * tray's status, the summon shortcut's setting and the update waiting for a restart. Each is a
 * command of the shell's own, and each has two exits — a browser tab or an older shell, where the
 * answer is "no shell" and nothing is drawn, and the shell, where the call goes through. Both are
 * pinned, because the failure of either is silent.
 */

type WindowWithTauri = typeof globalThis & { __TAURI__?: unknown };

afterEach(() => {
  (globalThis as WindowWithTauri).__TAURI__ = undefined;
});

function recordingShell(answers: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  (globalThis as WindowWithTauri).__TAURI__ = {
    core: {
      invoke: async (command: string, args?: unknown) => {
        calls.push([command, args]);
        if (command in answers) {
          const answer = answers[command];
          if (answer instanceof Error) throw answer;
          return answer;
        }
        return null;
      },
    },
  };
  return calls;
}

describe("the tray's status", () => {
  /*
   * Walked from the pill's own table rather than listed here, so a kind added to the pill tomorrow
   * is folded into one of the three today — or this fails.
   */
  test("every kind the pill can say folds into one of the tray's three codes", () => {
    const kinds = Object.keys(PRESENCE_LABELS) as PresenceKind[];
    expect(kinds.length).toBeGreaterThanOrEqual(7);
    for (const kind of kinds) {
      expect(["working", "waiting", "idle"]).toContain(shellStatusOf(kind));
    }
    // The person's turn is its own code; that is the one the tray exists to show.
    expect(shellStatusOf("approval")).toBe("waiting");
    expect(shellStatusOf("help")).toBe("waiting");
    expect(shellStatusOf("routine")).toBe("working");
    expect(shellStatusOf("thinking")).toBe("working");
    expect(shellStatusOf("idle")).toBe("idle");
  });

  test("the code goes through the shell's command, and a tab sends nothing", async () => {
    expect(await setShellStatus("waiting")).toBe(false);
    const calls = recordingShell();
    expect(await setShellStatus("waiting")).toBe(true);
    expect(calls).toEqual([["set_status", { status: "waiting" }]]);
  });
});

describe("the update waiting for a restart", () => {
  test("the version is read back from the shell, trimmed, and absent means none", async () => {
    expect(await shellUpdateReady()).toBeNull();
    recordingShell({ update_ready: " 0.5.6 " });
    expect(await shellUpdateReady()).toBe("0.5.6");
    recordingShell({ update_ready: null });
    expect(await shellUpdateReady()).toBeNull();
    // An older shell refuses the command it does not have: no notice, rather than a broken one.
    recordingShell({
      update_ready: new Error("command update_ready not allowed"),
    });
    expect(await shellUpdateReady()).toBeNull();
  });

  test("a refused restart is false, so the card stays and says so", async () => {
    expect(await restartToUpdate()).toBe(false);
    recordingShell({ restart_to_update: new Error("no update is waiting") });
    expect(await restartToUpdate()).toBe(false);
    const calls = recordingShell();
    expect(await restartToUpdate()).toBe(true);
    expect(calls.map(([command]) => command)).toEqual(["restart_to_update"]);
  });

  test("the shell's event is only a nudge, and listening stops when asked", async () => {
    let handler: (() => void) | null = null;
    let isUnlistened = false;
    (globalThis as WindowWithTauri).__TAURI__ = {
      event: {
        listen: async (name: string, callback: () => void) => {
          expect(name).toBe("update-ready");
          handler = callback;
          return () => {
            isUnlistened = true;
          };
        },
      },
    };
    let heard = 0;
    const stop = onShellUpdateReady(() => {
      heard += 1;
    });
    await new Promise((settled) => setTimeout(settled, 0));
    (handler as (() => void) | null)?.();
    expect(heard).toBe(1);
    stop();
    expect(isUnlistened).toBe(true);
    // Stopped before the shell answered is still stopped once it does.
    isUnlistened = false;
    const early = onShellUpdateReady(() => {});
    early();
    await new Promise((settled) => setTimeout(settled, 0));
    expect(isUnlistened).toBe(true);
  });
});

/**
 * A webview saves a file and draws nothing (measured in the shell, 2026-10-02: three presses of
 * 내려받기, three files, no change on screen). The shell is told when a download ends and passes
 * it on; this is the page's end of that.
 */
describe("a download that ended", () => {
  test("is read as a name and whether it was saved, and anything else is not a download", () => {
    expect(shellDownloadOf({ name: "보고서 (1).csv", saved: true })).toEqual({
      name: "보고서 (1).csv",
      isSaved: true,
    });
    // Not saved is still said, with the name of what was not.
    expect(shellDownloadOf({ name: "a.csv", saved: false })).toEqual({
      name: "a.csv",
      isSaved: false,
    });
    // The shell could not say where it went: still worth telling, without a name.
    expect(shellDownloadOf({ saved: true })).toEqual({
      name: "",
      isSaved: true,
    });
    expect(shellDownloadOf({ name: 7, saved: true })).toEqual({
      name: "",
      isSaved: true,
    });
    for (const unshaped of [
      null,
      undefined,
      "saved",
      7,
      {},
      { name: "a.csv" },
      { name: "a.csv", saved: "yes" },
    ]) {
      expect(shellDownloadOf(unshaped)).toBeNull();
    }
  });

  test("is heard from the shell's own event, and listening stops when asked", async () => {
    let emit: ((event?: { payload: unknown }) => void) | null = null;
    let isUnlistened = false;
    (globalThis as WindowWithTauri).__TAURI__ = {
      event: {
        listen: async (
          name: string,
          callback: (event?: { payload: unknown }) => void,
        ) => {
          // The name `note_download` emits (desktop/src-tauri/src/lib.rs, DOWNLOAD_ENDED_EVENT).
          expect(name).toBe("download-ended");
          emit = callback;
          return () => {
            isUnlistened = true;
          };
        },
      },
    };
    const heard: ShellDownload[] = [];
    const stop = onShellDownload((download) => heard.push(download));
    await new Promise((settled) => setTimeout(settled, 0));
    const say = emit as ((event?: { payload: unknown }) => void) | null;
    say?.({ payload: { name: "a.csv", saved: true } });
    // Something that is not a download is not passed on as one — and does not throw.
    say?.({ payload: { name: "a.csv" } });
    say?.();
    say?.({ payload: { name: "a (1).csv", saved: false } });
    expect(heard).toEqual([
      { name: "a.csv", isSaved: true },
      { name: "a (1).csv", isSaved: false },
    ]);
    stop();
    expect(isUnlistened).toBe(true);
  });

  test("is never heard in a browser tab, which draws its own downloads", () => {
    const stop = onShellDownload(() => {
      throw new Error("a tab has no shell to hear from");
    });
    expect(() => stop()).not.toThrow();
  });

  test("the event's name is the one the shell emits", async () => {
    const shell = await Bun.file(
      new URL("../../desktop/src-tauri/src/lib.rs", import.meta.url),
    ).text();
    expect(shell).toMatch(
      /const DOWNLOAD_ENDED_EVENT: &str = "download-ended";/,
    );
    expect(shell).toContain("app.emit(DOWNLOAD_ENDED_EVENT, ended)");
  });
});

describe("the summon shortcut", () => {
  /*
   * The ids are the shell's (`SUMMON_CHOICES` in lib.rs) and the labels are the page's. Read
   * together, so a choice the shell offers is never drawn as a blank option.
   */
  test("every choice the shell offers has keys to draw, on a Mac and elsewhere", () => {
    const shell = readFileSync(
      join(import.meta.dir, "../../desktop/src-tauri/src/lib.rs"),
      "utf8",
    );
    const listed = shell.match(
      /const SUMMON_CHOICES: \[&str; \d+\] = \[([^\]]*)\]/,
    )?.[1];
    const choices = [...(listed ?? "").matchAll(/"([^"]+)"/g)].map(
      (match) => match[1] as string,
    );
    expect(choices).toContain("off");
    expect(choices.length).toBeGreaterThanOrEqual(3);
    for (const id of choices.filter((choice) => choice !== "off")) {
      expect(summonKeysOf(id, true)).toBeTruthy();
      expect(summonKeysOf(id, false)).toBeTruthy();
    }
    expect(summonKeysOf("off", true)).toBeNull();
    expect(summonKeysOf("control-alt-l", true)).toBe("⌃⌥L");
    expect(summonKeysOf("control-alt-l", false)).toBe("Ctrl+Alt+L");
    expect(summonKeysOf("alt-space", false)).toBe("Alt+Space");
  });

  test("the setting is read only in the shape the shell answers", () => {
    expect(
      summonSettingOf({
        choice: "alt-space",
        choices: ["alt-space", "off", 3],
        active: true,
      }),
    ).toEqual({
      choice: "alt-space",
      choices: ["alt-space", "off"],
      active: true,
    });
    for (const refused of [
      null,
      "off",
      { choice: 1, choices: [] },
      { choice: "off" },
    ]) {
      expect(summonSettingOf(refused)).toBeNull();
    }
  });

  test("a tab and an older shell draw no row; the shell's answer is what is drawn", async () => {
    expect(await shellSummonShortcut()).toBeNull();
    recordingShell({ summon_shortcut: new Error("not allowed") });
    expect(await shellSummonShortcut()).toBeNull();
    const answer = {
      choice: "off",
      choices: ["alt-space", "off"],
      active: false,
    };
    const calls = recordingShell({
      summon_shortcut: answer,
      set_summon_shortcut: answer,
    });
    expect(await shellSummonShortcut()).toEqual(answer);
    expect(await setShellSummonShortcut("off")).toEqual(answer);
    expect(calls.at(-1)).toEqual(["set_summon_shortcut", { choice: "off" }]);
  });
});
