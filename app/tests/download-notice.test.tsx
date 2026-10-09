import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, expect, jest, test } from "bun:test";
import { createElement } from "react";
import { ko } from "../src/lib/i18n-ko";
import { mount, unmountAll } from "./support/mount";

/**
 * WHAT THE INSTALLED APP SAYS WHEN A DOWNLOAD ENDS.
 *
 * Measured in the shell on macOS 26.6, 2026-10-02: three presses of 내려받기 saved `news.csv`,
 * `news (1).csv` and `news (2).csv`, each within the second, and nothing on screen changed after
 * any of them. A browser draws a download; a webview does not. The shell says when one has ended
 * (`note_download`), and this is the line drawn for it.
 */

type Emit = (event: { payload: unknown }) => void;
type WindowWithTauri = typeof globalThis & { __TAURI__?: unknown };

let emit: Emit | null = null;
let stopped = 0;

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  jest.useRealTimers();
  await unmountAll();
  (globalThis as WindowWithTauri).__TAURI__ = undefined;
  emit = null;
  stopped = 0;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** The shell, as far as this component reaches into it: something to listen to. */
function shell(): void {
  (globalThis as WindowWithTauri).__TAURI__ = {
    event: {
      listen: async (_name: string, callback: Emit) => {
        emit = callback;
        return () => {
          stopped += 1;
        };
      },
    },
  };
}

async function notice(holdMs: number) {
  const { DownloadNotice } = await import(
    "../src/components/layout/download-notice"
  );
  shell();
  const mounted = await mount();
  await mounted.render(createElement(DownloadNotice, { holdMs }));
  await mounted.settle(5);
  const { act } = await import("react");
  return {
    ...mounted,
    ended: async (payload: unknown) => {
      await act(async () => {
        emit?.({ payload });
      });
    },
  };
}

// The words as this runtime draws them: no Korean locale is set here, so `t()` answers its key.
const SAVED = "Saved to your Downloads folder";
const NOT_SAVED = "Could not save the file";
const WHAT_TO_CHECK =
  "Check that this app may use your Downloads folder, then press it again.";

test("each line has its Korean, and the folder is called what Finder calls it", () => {
  // Finder's own name for the folder on a Korean Mac is 다운로드, which is where a person will
  // look — not 내려받기, the app's word for the button.
  expect(ko[SAVED]).toBe("다운로드 폴더에 저장했어요");
  expect(ko[NOT_SAVED]).toBe("파일을 저장하지 못했어요");
  expect(ko[WHAT_TO_CHECK]).toContain("다운로드 폴더");
});

test("nothing is drawn until a download ends", async () => {
  const { host } = await notice(40);
  expect(host.textContent).toBe("");
});

test("a saved file is said with the name it was saved under, and then goes away", async () => {
  const { host, ended, settle } = await notice(40);
  await ended({ name: "naver_economy_news (1).csv", saved: true });
  const card = host.querySelector("[data-download-notice]");
  expect(card?.getAttribute("data-download-notice")).toBe("saved");
  // Announced to a screen reader as it appears, and no button to press: a confirmation.
  expect(card?.getAttribute("role")).toBe("status");
  expect(card?.querySelector("button")).toBeNull();
  expect(host.textContent).toContain(SAVED);
  // The number the webview put after the name is the name of the file on disk, so it is shown.
  expect(host.textContent).toContain("naver_economy_news (1).csv");

  await settle(80);
  expect(host.querySelector("[data-download-notice]")).toBeNull();
});

test("the same file saved again is a new notice with a hold of its own", async () => {
  const { host, ended } = await notice(60);
  /*
   * ON THE TEST'S CLOCK, NOT THE MACHINE'S. Real 40 ms waits against a 60 ms hold failed one run of
   * the gate in three once four workers shared the cores (measured 2026-10-09): a wait that ran
   * long let the second notice's own hold run out before it was looked at.
   */
  const { act } = await import("react");
  const after = (ms: number) =>
    act(async () => {
      jest.advanceTimersByTime(ms);
    });
  jest.useFakeTimers();
  await ended({ name: "a.csv", saved: true });
  await after(40);
  // The first notice's timer has 20ms left when the second arrives, and must not take it down.
  await ended({ name: "a (1).csv", saved: true });
  await after(40);
  expect(host.textContent).toContain("a (1).csv");
  await after(30);
  expect(host.querySelector("[data-download-notice]")).toBeNull();
});

test("a file that was not saved stays until it is closed, and says what to look at", async () => {
  const { host, ended, settle, press } = await notice(20);
  await ended({ name: "laf-export-2026-10-02.json", saved: false });
  await settle(80);
  const card = host.querySelector("[data-download-notice]");
  expect(card?.getAttribute("data-download-notice")).toBe("failed");
  expect(host.textContent).toContain(NOT_SAVED);
  expect(host.textContent).toContain("laf-export-2026-10-02.json");
  expect(host.textContent).toContain(WHAT_TO_CHECK);
  expect(host.textContent).not.toContain(SAVED);

  const close = card?.querySelector("button");
  expect(close?.textContent).toBe("Close");
  if (close) await press(close);
  expect(host.querySelector("[data-download-notice]")).toBeNull();
});

test("a download with no name is still said", async () => {
  const { host, ended } = await notice(40);
  await ended({ saved: true });
  expect(host.textContent).toBe(SAVED);
});

test("what is not a download is not drawn as one", async () => {
  const { host, ended } = await notice(40);
  await ended({ name: "a.csv" });
  await ended("saved");
  expect(host.textContent).toBe("");
});

test("it stops listening when it leaves the screen", async () => {
  const { unmount } = await notice(40);
  expect(stopped).toBe(0);
  await unmount();
  expect(stopped).toBe(1);
});
