/**
 * THE CONFIRM DIALOG, RENDERED FOR REAL, PRESSED, AND TRIED AT EVERY WAY OUT WHILE IT WORKS.
 *
 * In a process of its own for the two reasons `feedback-render.tsx` gives: Base UI's dialog decides
 * once, when it is first evaluated, whether there is a DOM to portal into (`confirm-dialog.test.tsx`),
 * and the locale is decided when the dictionary is first loaded. Both are settled here before any
 * app module is imported, so the popup is the real one and its buttons are really pressed.
 *
 * Six openings, one after another: a press that fails, one that succeeds, one whose re-check says
 * the thing is already gone, and three with nothing running — left by Escape, by the overlay and by
 * the ×, which is what makes the refusals of the first one mean anything. Prints one line,
 * `CONFIRM_RENDER <json>`. Not a test file (no `.test.` in the name), so the runner never collects
 * it on its own — and nothing may import a value from it, which would run it: types only.
 *
 *     bun app/tests/support/confirm-dialog-render.tsx
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export type ConfirmShown = {
  failing: {
    /** What had focus once the dialog opened. */
    focusedOnOpen: string;
    /** Whether the alert line was in the document before anything had failed. */
    alertMountedBeforeFailure: boolean;
    /** The confirm button while the action runs. */
    runningLabel: string;
    runningDisabled: boolean;
    cancelDisabledWhileRunning: boolean;
    closeDisabledWhileRunning: boolean;
    /** Every close the dialog asked for while the action ran: Escape, the overlay, the ×. */
    closesAskedWhileRunning: boolean[];
    openAfterEscapeOverlayAndX: boolean;
    /** Presses of the confirm while it ran, counted by the action. */
    actionsStarted: number;
    /** After the failure. */
    alert: string;
    alertIsSameElement: boolean;
    labelAfterFailure: string;
    openAfterFailure: boolean;
  };
  succeeding: {
    labelBeforePress: string;
    closesAsked: boolean[];
    openAfterSuccess: boolean;
  };
  moot: {
    actionsStarted: number;
    status: string;
    buttons: string[];
    focused: string;
  };
  /** The same three ways out, with nothing running: each must close it, or the above proves nothing. */
  idle: {
    closesAskedOnEscape: boolean[];
    closesAskedOnOverlay: boolean[];
    closesAskedOnX: boolean[];
  };
};

process.env.NODE_ENV = "test";
GlobalRegistrator.register({ url: "http://localhost:3110/" });
window.localStorage.setItem("laf.locale", "ko");
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act, createElement, useState } = React;
const { createRoot } = await import("react-dom/client");
const { ConfirmDialog } = await import(
  "../../src/components/layout/confirm-dialog"
);

const settle = async (ms = 40) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

const dialog = () => document.body.querySelector('[role="dialog"]');
const buttons = () => [
  ...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? []),
];
const named = (name: string) =>
  buttons().find((button) => button.textContent?.trim() === name);
const focused = () => document.activeElement?.textContent?.trim() ?? "";

async function press(element: Element | null | undefined) {
  if (!element) throw new Error("nothing to press");
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

async function pressEscape() {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await settle();
}

/** A press outside the popup, the way Base UI listens for one: pointer, mouse, click. */
async function pressOverlay() {
  const overlay = document.body.querySelector('[data-slot="dialog-overlay"]');
  if (!overlay) throw new Error("no overlay");
  await act(async () => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      overlay.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }),
      );
    }
    overlay.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
  });
  await settle();
}

/** The dialog with its `open` held the way every caller holds it: in state, closed on request. */
async function opened(props: {
  onConfirm: () => Promise<unknown>;
  recheck?: () => Promise<string | null>;
}) {
  const asked: boolean[] = [];
  const Host = () => {
    const [open, setOpen] = useState(true);
    return createElement(ConfirmDialog, {
      confirmLabel: "삭제",
      description: "되돌릴 수 없어요.",
      onConfirm: props.onConfirm,
      onOpenChange: (next: boolean) => {
        asked.push(next);
        setOpen(next);
      },
      open,
      ...(props.recheck ? { recheck: props.recheck } : {}),
      title: "'새벽'을 삭제할까요?",
    });
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Host));
  });
  await settle(80);
  return {
    asked,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      await settle();
    },
  };
}

// --- a press that fails -------------------------------------------------------------------------

let failNow = (_error: Error) => {};
let failingStarted = 0;
const failing = await opened({
  onConfirm: () =>
    new Promise((_resolve, reject) => {
      failingStarted += 1;
      failNow = reject;
    }),
});
const focusedOnOpen = focused();
const alertBefore = dialog()?.querySelector('[role="alert"]') ?? null;
await press(named("삭제"));
const running = buttons().find((button) =>
  button.textContent?.includes("삭제 중"),
);
const runningLabel = running?.textContent?.trim() ?? "";
const runningDisabled = running?.getAttribute("aria-disabled") === "true";
const cancelDisabledWhileRunning = named("취소")?.disabled === true;
const closeDisabledWhileRunning =
  dialog()?.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')
    ?.disabled === true;
// A second press while it runs: must not start a second action.
await press(running);
await pressEscape();
await pressOverlay();
await press(dialog()?.querySelector('[data-slot="dialog-close"]'));
const closesAskedWhileRunning = [...failing.asked];
const openAfterEscapeOverlayAndX = dialog() !== null;
const actionsStarted = failingStarted;

await act(async () => {
  failNow(new Error("그 봇은 더 이상 없어요."));
});
await settle(80);
const alertAfter = dialog()?.querySelector('[role="alert"]') ?? null;
const failingShown: ConfirmShown["failing"] = {
  focusedOnOpen,
  alertMountedBeforeFailure: alertBefore !== null,
  runningLabel,
  runningDisabled,
  cancelDisabledWhileRunning,
  closeDisabledWhileRunning,
  closesAskedWhileRunning,
  openAfterEscapeOverlayAndX,
  actionsStarted,
  alert: alertAfter?.textContent?.trim() ?? "",
  alertIsSameElement: alertBefore !== null && alertAfter === alertBefore,
  labelAfterFailure:
    buttons()
      .map((button) => button.textContent?.trim() ?? "")
      .find((label) => label !== "취소" && label !== "닫기") ?? "",
  openAfterFailure: dialog() !== null,
};
await failing.unmount();

// --- a press that succeeds ----------------------------------------------------------------------

const succeeding = await opened({ onConfirm: async () => {} });
const labelBeforePress = named("삭제")?.textContent?.trim() ?? "";
await press(named("삭제"));
await settle(200);
const succeedingShown: ConfirmShown["succeeding"] = {
  labelBeforePress,
  closesAsked: [...succeeding.asked],
  openAfterSuccess: dialog() !== null,
};
await succeeding.unmount();

// --- a press whose re-check finds the thing already gone ----------------------------------------

let mootStarted = 0;
const moot = await opened({
  onConfirm: async () => {
    mootStarted += 1;
  },
  recheck: async () => "이 봇은 이미 삭제되었어요.",
});
await press(named("삭제"));
await settle(80);
const mootShown: ConfirmShown["moot"] = {
  actionsStarted: mootStarted,
  status: dialog()?.querySelector('[role="status"]')?.textContent?.trim() ?? "",
  buttons: buttons()
    .filter((button) => button.dataset.slot !== "dialog-close")
    .map((button) => button.textContent?.trim() ?? ""),
  focused: focused(),
};
await moot.unmount();

// --- the same ways out, with nothing running ----------------------------------------------------

const idleByEscape = await opened({ onConfirm: async () => {} });
await pressEscape();
const closesAskedOnEscape = [...idleByEscape.asked];
await idleByEscape.unmount();

const idleByOverlay = await opened({ onConfirm: async () => {} });
await pressOverlay();
const closesAskedOnOverlay = [...idleByOverlay.asked];
await idleByOverlay.unmount();

const idleByX = await opened({ onConfirm: async () => {} });
await press(dialog()?.querySelector('[data-slot="dialog-close"]'));
const closesAskedOnX = [...idleByX.asked];
await idleByX.unmount();

const idleShown: ConfirmShown["idle"] = {
  closesAskedOnEscape,
  closesAskedOnOverlay,
  closesAskedOnX,
};

const shown: ConfirmShown = {
  failing: failingShown,
  succeeding: succeedingShown,
  moot: mootShown,
  idle: idleShown,
};
console.log(`CONFIRM_RENDER ${JSON.stringify(shown)}`);
process.exit(0);
