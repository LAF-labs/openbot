import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createElement } from "react";

/**
 * THE DIALOG THAT ASKS BEFORE SOMETHING IS GONE, AND WHETHER A KEYBOARD CAN ANSWER IT.
 *
 * MEASURED IN CHROME on 2026-09-06, before this component existed. Opening the Bot delete dialog
 * from the ⋯ menu left `document.activeElement` on the menu item — an element inside an
 * `aria-hidden` subtree by then — and opening the routine one from a plain button left it on
 * `<body>`. Three Tab presses moved nothing. So on the one dialog in the product that destroys
 * something, 취소 and 삭제 could not be reached without a mouse.
 *
 * After `initialFocus={cancelRef}`, measured the same way: focus lands on 취소, and Tab cycles
 * 취소 → 삭제 → 닫기 → 취소 without ever leaving the popup.
 *
 * WHY THAT TRAIL IS NOT ASSERTED HERE, AND WHAT IS.
 *
 * Two walls, both measured rather than assumed:
 *
 * 1. happy-dom does not implement sequential focus navigation. A `Tab` KeyboardEvent moves nothing,
 *    so a test that "presses Tab four times" and finds focus still inside the dialog would pass on
 *    a dialog with no trap at all — a green test for the exact bug this file is about.
 *
 * 2. `@base-ui/react/dialog` decides ONCE, when its module is first evaluated, whether it is in a
 *    browser, and renders no portal for the rest of the process if the answer was no. `bun test`
 *    shares one module registry across every file, and several app tests import a ROUTE module for
 *    its refusal table (`account-copy.test.ts` → `settings/account`), which pulls Base UI in before
 *    any DOM exists. Isolated with a probe: a file that STATICALLY imports `Dialog` and registers
 *    happy-dom in `beforeAll` gets `null` for its own popup. A rendering test of this dialog
 *    therefore passes alone and fails in the suite, for a reason that has nothing to do with it.
 *
 * Worth fixing at the harness — an app-scoped preload installing the DOM before any component
 * module is evaluated would make every popup in the app testable — but not from inside one file.
 *
 * So the render below asserts the one property that is portal-independent AND was a real bug in
 * this codebase (a closed dialog leaving controls in the tab order — `DetailPanel` had exactly
 * that), and the rest of the contract is read off the source, with the browser measurement standing
 * behind it.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const SOURCE = readFileSync(
  join(import.meta.dir, "../src/components/layout/confirm-dialog.tsx"),
  "utf8",
);

async function mounted() {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    render: async (element: React.ReactElement) => {
      await act(async () => {
        root.render(element);
      });
    },
    settle: async (ms: number) => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    },
  };
}

describe("a closed confirm dialog", () => {
  test("leaves nothing of itself in the tab order", async () => {
    /*
     * The failure this stands against is real and this app has had it: `DetailPanel` kept its close
     * button mounted while the pane was collapsed to zero width, so tabbing across a screen with no
     * visible panel landed on an invisible control that closed something already closed.
     */
    document.body.innerHTML = "";
    const { ConfirmDialog } = await import(
      "../src/components/layout/confirm-dialog"
    );
    const view = await mounted();
    await view.render(
      createElement(ConfirmDialog, {
        confirmLabel: "삭제",
        description: "되돌릴 수 없습니다.",
        onConfirm: () => {},
        onOpenChange: () => {},
        open: false,
        title: "'김비서'를 삭제할까요?",
      }),
    );
    await view.settle(30);

    const reachable = [
      ...document.querySelectorAll<HTMLElement>(
        'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => !element.closest('[aria-hidden="true"], [inert]'));

    expect(reachable.map((element) => element.textContent)).toEqual([]);
    expect(document.body.textContent).not.toContain("삭제할까요");
  });
});

describe("what the dialog promises", () => {
  test("focus is aimed at the answer that changes nothing", () => {
    /*
     * `initialFocus` on a REF, not `true`. `true` focuses the popup's first tabbable element, which
     * is the × in the corner — reachable, and it tells nobody anything about the choice being made.
     * Cancel is what somebody who pressed by accident wants under the Return key; a focused
     * destructive button is a delete one keystroke away from a person who was only reading.
     */
    expect(SOURCE).toContain("initialFocus={cancelRef}");
    const ref = SOURCE.indexOf("ref={cancelRef}");
    const cancel = SOURCE.indexOf('{t("Cancel")}');
    expect(ref).toBeGreaterThan(0);
    // The ref is on the button that says Cancel, not on the one beside it.
    expect(cancel).toBeGreaterThan(ref);
    expect(cancel - ref).toBeLessThan(200);
  });

  test("the destructive answer is filled, not the wash that reads as disabled", () => {
    /*
     * `variant="destructive"` is `bg-destructive/10` — a pale pink pill, lighter on the popover
     * ground than the ghost 취소 beside it, which is how this codebase draws a button that cannot
     * be pressed. Measured on screen before the override; filled after it.
     */
    expect(SOURCE).toContain("bg-destructive text-white");
    // Dark's red is a bright coral and white on it is about 3:1, so that theme flips to the ground.
    expect(SOURCE).toContain("dark:text-background");
  });

  test("it never builds the Korean sentence itself", () => {
    // The title arrives with its particle already on it — see `lib/josa.ts`. A dialog splicing
    // 을/를 together in here would be a second place for that rule to live, and to drift.
    expect(SOURCE).not.toContain("을(를)");
    expect(SOURCE).not.toContain("josa(");
  });

  test("the three screens that delete something all use it", () => {
    const app = join(import.meta.dir, "../src");
    for (const page of [
      "components/agents/agent-profile.tsx",
      "routes/_authed/_app/routines.tsx",
      "routes/_authed/_app/skills.tsx",
    ]) {
      const source = readFileSync(join(app, page), "utf8");
      expect(`${page}: ${source.includes("<ConfirmDialog")}`).toBe(
        `${page}: true`,
      );
      // And none of them still hand-rolls a dialog footer of its own.
      expect(`${page}: ${source.includes("<DialogFooter")}`).toBe(
        `${page}: false`,
      );
    }
  });
});
