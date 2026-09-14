/**
 * Which fields on a page hold a secret, for the snapshot to mark and blank — by markup, and by the
 * identity of the node a person typed one into.
 *
 * THE ACCESSIBLE TREE DOES NOT SAY. Playwright reports `<input type="password">` as a `textbox`,
 * the same as a name field, and the boundary's whole rule about secrets is that a Bot must never
 * type into one nor read what is in it. The parsing half of the join lives in `aria-snapshot.ts`
 * (`SecretSignals`), which has no Playwright in it; this is the half that asks the page.
 */
import type { ElementHandle, Page } from "playwright";
import { isTextEntryRole, parseAriaSnapshot } from "./aria-snapshot";
import type { BotSession, SecretField } from "./sessions";

/**
 * The inputs a page marks as taking a secret — in the markup, whatever the wording beside them.
 *
 * `type="password"` is the obvious one. The `autocomplete` tokens are the page telling a browser's
 * own password manager what goes in the box, which is as good a declaration as the type: a one-time
 * code and a card number are `type="text"` and `type="tel"` on every Korean checkout, and their
 * token is the only thing in the markup that says so. Matched as a token (`~=`), because the
 * attribute is a list — `section-login current-password` is a current password.
 */
const SECRET_INPUT_SELECTOR = [
  'input[type="password"]',
  'input[autocomplete~="current-password"]',
  'input[autocomplete~="new-password"]',
  'input[autocomplete~="one-time-code"]',
  'input[autocomplete~="cc-number"]',
  'input[autocomplete~="cc-csc"]',
].join(", ");

/** How many marked inputs one snapshot joins, across every frame. A login form has one or two. */
const SECRET_INPUT_LIMIT = 20;

/** How many fields a session follows. Each is a live handle into the page. */
const SECRET_FIELD_LIMIT = 8;

/**
 * How long a join may wait on one element. They answer in milliseconds or not at all — a hidden
 * input snapshots to nothing and a vanished one is an error at once (measured) — and a snapshot is
 * what the Bot is waiting on, so this is a bound on a mistake rather than a wait.
 */
export const SECRET_JOIN_TIMEOUT_MS = 1_000;

/**
 * What the markup says about the page's secret fields, for the snapshot to mark and blank them.
 *
 * Every frame is asked, and the answer is joined to the tree three ways — see `SecretSignals` in
 * aria-snapshot.ts:
 *
 * 1. BY REF. Playwright keeps the ref it mints ON THE ELEMENT, so a snapshot of one input names the
 *    ref the page's snapshot does — in a child frame too, prefix and all (measured: `f1e1` both
 *    ways). Taken BEFORE the page's snapshot; see `snapshotPage` for why the order is not free.
 * 2. BY VALUE. The tree read the value off the same node, so equality is identity, and it is what
 *    holds when a ref could not be read.
 * 3. BY LABEL. The join that used to be the whole rule, by `HTMLInputElement.labels` — blind to
 *    `aria-labelledby`, so the auditor's box reached the tree named 패스워드 and arrived here named
 *    nothing (measured 2026-09-10). Resolved now in the order Playwright resolves a name:
 *    `aria-labelledby`, `aria-label`, the `<label>`, the placeholder, the title.
 *
 * The values of the fields a person typed a secret into are read here too, by their handles, and a
 * handle whose node or document is gone is let go.
 *
 * Never throws. A page that is navigating under us costs the marking, not the snapshot.
 */
export async function secretSignals(
  session: BotSession,
  target: Page,
): Promise<{ labels: string[]; values: string[]; refs: string[] }> {
  const labels: string[] = [];
  const values: string[] = [];
  const refs: string[] = [];

  let budget = SECRET_INPUT_LIMIT;
  for (const frame of target.frames()) {
    if (budget <= 0) break;
    try {
      const inputs = frame.locator(SECRET_INPUT_SELECTOR);
      const found = await inputs.evaluateAll(
        (nodes: Element[], limit: number) =>
          nodes.slice(0, limit).map((node: Element) => {
            const input = node as HTMLInputElement;
            const text = (element: Element | null): string =>
              (element?.textContent ?? "").replace(/\s+/g, " ").trim();
            const byIds = (ids: string | null): string =>
              (ids ?? "")
                .split(/\s+/)
                .filter(Boolean)
                .map((id) => text(input.ownerDocument.getElementById(id)))
                .filter(Boolean)
                .join(" ");
            const label =
              byIds(input.getAttribute("aria-labelledby")) ||
              (input.getAttribute("aria-label") ?? "").trim() ||
              text(input.labels?.[0] ?? null) ||
              (input.getAttribute("placeholder") ?? "").trim() ||
              (input.getAttribute("title") ?? "").trim();
            return { label, value: String(input.value ?? "") };
          }),
        budget,
      );
      budget -= found.length;
      for (const entry of found) {
        if (entry.label) labels.push(entry.label);
        if (entry.value) values.push(entry.value);
      }
      const lines = await Promise.all(
        found.map((_, index) =>
          inputs
            .nth(index)
            .ariaSnapshot({ mode: "ai", timeout: SECRET_JOIN_TIMEOUT_MS })
            .catch(() => ""),
        ),
      );
      for (const line of lines) {
        const ref = /\[ref=([^\]\s]+)\]/.exec(line)?.[1];
        if (ref) refs.push(ref);
      }
    } catch {
      // A frame that is navigating or already detached. Its marking is lost, not the snapshot.
    }
  }

  const kept: SecretField[] = [];
  for (const field of session.secretFields) {
    const value = await field.handle
      .evaluate((node) =>
        node.isConnected
          ? String((node as HTMLInputElement).value ?? "")
          : null,
      )
      .catch(() => null);
    if (value === null) {
      // The node left the page, or the page left the browser: the secret went with it.
      await field.handle.dispose().catch(() => undefined);
      continue;
    }
    kept.push(field);
    if (value) values.push(value);
  }
  session.secretFields = kept;

  return { labels, values, refs };
}

/**
 * The refs, in the snapshot just taken, of the fields a person typed a secret into.
 *
 * BY NODE, WHATEVER THE PAGE HAS DONE TO IT SINCE. A ref outlives a snapshot only while the node
 * keeps its role and name: rename the box — a validation message added to its label is enough —
 * and Playwright mints it a new ref (measured: `e1` became `e5`, value and all). So the ref kept
 * from the last time is asked first, and when it no longer names this node the page's text-entry
 * controls are asked in turn until one does. Asked of the node itself, through `aria-ref=`, which
 * resolves against the snapshot standing now; nothing about the label or the value is trusted.
 */
export async function typedIntoRefs(
  session: BotSession,
  target: Page,
  yaml: string,
): Promise<string[]> {
  const refs: string[] = [];
  let candidates: string[] | undefined;
  for (const field of session.secretFields) {
    if (await refNamesNode(target, field.ref, field.handle)) {
      refs.push(field.ref);
      continue;
    }
    candidates ??= parseAriaSnapshot(yaml)
      .elements.filter((element) => isTextEntryRole(element.role))
      .map((element) => element.ref);
    for (const ref of candidates) {
      if (await refNamesNode(target, ref, field.handle)) {
        field.ref = ref;
        refs.push(ref);
        break;
      }
    }
  }
  return refs;
}

/** Whether `ref`, in the current snapshot, is this very node. False for anything it cannot answer. */
async function refNamesNode(
  target: Page,
  ref: string,
  handle: ElementHandle,
): Promise<boolean> {
  try {
    const located = target.locator(`aria-ref=${ref}`);
    if ((await located.count()) !== 1) return false;
    return await located.evaluate((node, other) => node === other, handle, {
      timeout: SECRET_JOIN_TIMEOUT_MS,
    });
  } catch {
    return false;
  }
}

/** Follow a field a person just typed a secret into, from the next snapshot on. */
export function rememberSecretField(
  session: BotSession,
  handle: ElementHandle | null,
  ref: string,
): void {
  if (!handle) return;
  session.secretFields.push({ handle, ref });
  while (session.secretFields.length > SECRET_FIELD_LIMIT) {
    void session.secretFields
      .shift()
      ?.handle.dispose()
      .catch(() => undefined);
  }
}

/** Let every followed field go: the browser they lived in is gone. */
export function forgetSecretFields(session: BotSession): void {
  for (const field of session.secretFields.splice(0)) {
    void field.handle.dispose().catch(() => undefined);
  }
}
