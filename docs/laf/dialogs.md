# Dialogs — the checklist every one of them keeps

Written 2026-09-18, before the audit that applied it. A dialog in this app is anything that
takes the screen and asks for an answer: the Base UI dialog in `app/src/components/ui/dialog.tsx`,
`ConfirmDialog` on top of it, and the two full-screen overlays drawn by hand — the Bot's screen
and the sign-in handoff. They are held to one list, because a person learns what a dialog does
once and expects the next one to do the same.

## The checklist

**While its action runs**

- It cannot be closed: not by Escape, not by a click on the overlay, not by × or 취소.
- Its inputs are locked.
- The primary button says what it is doing (저장 중…, 삭제 중…) and cannot be pressed twice.

**A failure**

- Shows inside the dialog, in a `role="alert"` line, in Korean through `t()`. Never the
  server's prose, and never the browser's own "Failed to fetch".
- Keeps everything the person typed.

**It closes only on success.** `mutate(); close()` — fire the request, shut the dialog — is the
shape this list was written against: the failure then lands on the page behind, or nowhere.

**다시 시도 appears only in the failed state.** Before the first press the button says what it
does.

**Focus**

- The first focus lands on the safe choice in a destructive dialog (취소), and on the first
  field in a form.
- Focus returns to the opener on close. When the opener no longer exists — a menu item, gone with
  its menu — it returns to the menu's trigger.

**Keyboard**

- Enter submits a single-field form.
- Escape cancels when nothing is running.

**Re-check at the press, not at render.** A destructive action — delete, reset, clear — asks
whether it still applies at the moment it is pressed. If it no longer does (the Bot is gone, the
routine was deleted in another window, the notepad is already empty), the dialog says why in one
sentence and offers 닫기, instead of sending a request the server will refuse.

## Status lines are mounted before they speak

A screen reader announces a change to a live region it already knows about. A line that is
mounted only when it has something to say — 저장됨, a reconnecting pill, a result — arrives
together with its region and is, in most screen readers, never read out. So the region is
always mounted and visually hidden while it is empty: `LiveRegion` in
`app/src/components/layout/live-region.tsx`. `aria-live="polite"` for status; `role="alert"` only
for a failure.

## Exceptions, decided rather than forgotten

- **연결 점검.** Its running work is a read, and closing the dialog is how that read is stopped
  (the panel aborts it on unmount). It stays closable while it runs.
- **모두 멈추기.** Its press is never refused by the server and is never held back by a check: the
  dialog exists for the moment something looks wrong, and a slow server is not a reason to refuse a
  stop. "Everything had already finished by the time you pressed" is its one sentence, said after
  the press rather than instead of it.
- **The face picker.** Every tile applies at once, so there is no primary button to lock. While a
  choice is being saved the dialog cannot be closed and the tiles are locked, and a failure shows
  inside it.

## How it is spelled

- `<Dialog isBusy>` refuses every close Base UI would make — Escape, overlay, × — disables the ×,
  and keeps a press on the overlay from taking the focus the pressed button holds. Anything else
  that closes the dialog (a 취소 button) is disabled by its caller.
- The primary button is `disabled` and `focusableWhenDisabled` while it runs, so the focus it was
  pressed with stays on it rather than falling to the page.
- `ConfirmDialog` owns its press: `onConfirm` returns a promise that resolves when the action is
  done and throws the person's sentence when it is not; `recheck` answers, at the press, whether
  the action still applies; `onStale` refreshes what is behind the dialog once it has closed on a
  thing that was already gone. The dialog does the rest of this list.
- `pressOnce` (`app/src/lib/press.ts`) is the press without the dialog: the re-check, the action,
  and a failure turned into a Korean sentence. `usePress` beside it is the same press held for a
  form dialog — `isRunning`, and the `failure` for its alert line. The re-checks themselves are in
  `app/src/lib/rechecks.ts`.
- The two overlays drawn by hand use `useOverlayModal`: the app's root is inert while one is up,
  and focus goes back to the opener — or to a fallback the overlay names, when the opener left.
  Their Escape listens in the capture phase: a window listener added earlier (the side pane's)
  would otherwise read `defaultPrevented` before the overlay set it, and close too.
- `app/tests/support/confirm-dialog-render.tsx` presses the real popup in a process of its own and
  tries every way out while it runs; `confirm-dialog.test.tsx` holds what it finds.

## What is not solved yet

- **A delete that worked takes its opener with it.** Deleting a routine removes the row whose ⋯
  opened the dialog, and focus falls to `<body>` when it closes. The page knows where focus should
  go next (the next row, or the list); the dialog does not. Measured 2026-09-18.
