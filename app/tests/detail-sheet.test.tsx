import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mount, unmountAll } from "./support/mount";

/**
 * THE BOT'S SCREEN AT PHONE WIDTH IS A SHEET OVER THE WHOLE WINDOW, AND A SHEET IS A MODAL.
 *
 * It kept none of that until 2026-09-24: drawn inside the app's root, Tab and a screen reader
 * walked out of it into the rail and conversation it covered, focus stayed on the covered button
 * that opened it, and closing it left focus on `<body>` (docs/laf/dialogs.md). Wide, it is a
 * column beside the conversation and none of this applies.
 */

beforeAll(async () => {
  // Narrower than `lg` (64rem), the width the sheet is drawn at.
  GlobalRegistrator.register({ url: "http://localhost:3110/", width: 375 });
  /*
   * The width is read once per process and kept (`screen-panel.ts`), so a file drawn at PC width
   * before this one left the sheet reading as a column: measured 2026-09-25, any file mounting the
   * route tree sorted ahead of this one failed it under `test:ci`.
   */
  const { forgetScreenPanelViewport } = await import(
    "../src/lib/computer/screen-panel"
  );
  forgetScreenPanelViewport();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(unmountAll);

describe("the side pane as a sheet", () => {
  test("is drawn outside the root it makes inert, starts on its ×, and hands focus back on close", async () => {
    const { DetailPanel } = await import(
      "../src/components/layout/detail-panel"
    );
    const view = await mount();
    view.host.id = "root";
    const draw = (open: boolean) =>
      view.render(
        <DetailPanel
          detail={<p>the Bot's page</p>}
          isSheetWhenNarrow={true}
          onClose={() => {}}
          open={open}
          title={<span>Sprout's screen</span>}
        >
          <button type="button">opener</button>
        </DetailPanel>,
      );
    await draw(false);
    const opener = view.host.querySelector("button");
    if (!(opener instanceof HTMLButtonElement)) throw new Error("no opener");
    opener.focus();

    await draw(true);
    await view.settle(30);
    const sheet = document.querySelector('[role="dialog"][aria-modal="true"]');
    expect(sheet?.parentElement).toBe(document.body);
    expect(view.host.hasAttribute("inert")).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
    const label = document.getElementById(
      sheet?.getAttribute("aria-labelledby") ?? "",
    );
    expect(label?.textContent).toBe("Sprout's screen");

    await draw(false);
    await view.settle(30);
    expect(view.host.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });
});
