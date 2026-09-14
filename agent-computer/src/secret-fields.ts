/**
 * Which fields on a page hold a secret, for the snapshot to mark and blank — by markup, and by the
 * identity of the node a person typed one into.
 *
 * THE ACCESSIBLE TREE DOES NOT SAY. Playwright reports `<input type="password">` as a `textbox`,
 * the same as a name field, and the boundary's whole rule about secrets is that a Bot must never
 * type into one nor read what is in it. The parsing half of the join lives in `aria-snapshot.ts`
 * (`SecretSignals`), which has no Playwright in it; this is the half that asks the page.
 */
import type { ElementHandle, Frame, Page } from "playwright";
import { isTextEntryRole, parseAriaSnapshot } from "./aria-snapshot";
import type { BotSession, SecretField } from "./sessions";
import { within } from "./within";

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
 * How long a join may wait on one element — or on one frame. They answer in milliseconds or not at
 * all — a hidden input snapshots to nothing and a vanished one is an error at once (measured) — and a
 * snapshot is what the Bot is waiting on, so this is a bound on a mistake rather than a wait.
 *
 * A FRAME WITH NO DOCUMENT IS THE "NOT AT ALL". Its request accepted and never answered, it gives
 * `evaluateAll` nothing to run in, and `evaluateAll` has no timeout: until 2026-09-14 the join waited
 * on such a frame for ever, and every snapshot of the page with it (W3-c). The join stops waiting
 * here, and asks again once the page's tree is taken — see {@link SecretJoin}.
 */
export const SECRET_JOIN_TIMEOUT_MS = 1_000;

/** What the markup says about one frame's marked inputs, or null when the frame would not say. */
type MarkedInputs = { label: string; value: string }[] | null;

/**
 * One frame's marked inputs, by label and value. Read-only, which is what makes a read that has not
 * answered safe to leave running: whatever it does when it does answer changes nothing on the page.
 */
function readMarkedInputs(frame: Frame): Promise<MarkedInputs> {
  return (
    frame
      .locator(SECRET_INPUT_SELECTOR)
      .evaluateAll(
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
        SECRET_INPUT_LIMIT,
      )
      // A frame that is navigating or already detached. Its marking is lost, not the snapshot.
      .catch(() => null)
  );
}

/**
 * The refs of a frame's first `count` marked inputs, read with a snapshot of each one.
 *
 * NOT READ-ONLY. A snapshot of one input becomes the one `aria-ref=` resolves that frame's refs
 * against (Playwright 1.62.1 keeps one last snapshot per frame's injected script), which is why these
 * are taken before the page's tree and never after it without the tree being taken again — whether
 * or not a ref came back, since the snapshot was taken either way (see `snapshotPage`).
 */
async function refsOfMarkedInputs(
  frame: Frame,
  count: number,
): Promise<string[]> {
  const inputs = frame.locator(SECRET_INPUT_SELECTOR);
  const lines = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      inputs
        .nth(index)
        .ariaSnapshot({ mode: "ai", timeout: SECRET_JOIN_TIMEOUT_MS })
        .catch(() => ""),
    ),
  );
  return lines.flatMap((line) => {
    const ref = /\[ref=([^\]\s]+)\]/.exec(line)?.[1];
    return ref ? [ref] : [];
  });
}

/** The value in a field a person typed a secret into, or null once its node or document is gone. */
function readTypedField(field: SecretField): Promise<string | null> {
  return field.handle
    .evaluate((node) =>
      node.isConnected ? String((node as HTMLInputElement).value ?? "") : null,
    )
    .catch(() => null);
}

/** Labels, values and refs, in the shape `parseAriaSnapshot` joins them. */
export type SecretMarks = {
  labels: string[];
  values: string[];
  refs: string[];
};

/**
 * What the join found in time, and a way to hear from what it did not.
 *
 * THE FRAME THAT ARRIVES WHILE THE TREE IS BEING TAKEN. The tree waits for frames the join has given
 * up on, and one that arrives in that window reaches the tree with its secret box filled in and
 * nothing marking it: measured 2026-09-14, a frame arriving 1.4 s into a tree taken after a join
 * that had stopped at 1 s came back as `textbox "PIN4" [ref=f1e2]: late-s3cret`, and with this
 * switched off the snapshot carried `"name":"간편결제","value":"LATE-FRAME-SECRET-4455"` (the
 * fixture's `/late-frame`) and left a box with no name unmarked. A frame the page adds after
 * the join has asked is the same window. So `late` waits once more for every frame and field that had
 * not answered — the read that was left running, not a new one — and asks the frames that were not
 * there yet, and hands over what they say. Its refs are read the way the join's are, with a snapshot
 * of each input, and when it took one (`snapshotted`) the caller must take the page's tree again.
 * `refs: false` reads labels and values only, for a caller with no time left to do that. Callable
 * again: each call waits only for what is still silent, or new.
 */
export type SecretJoin = SecretMarks & {
  late(options: {
    refs: boolean;
  }): Promise<SecretMarks & { snapshotted: boolean }>;
};

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
 * Every frame and every field is asked at once and waited for {@link SECRET_JOIN_TIMEOUT_MS}; what
 * has not answered by then is `late`'s. Never throws. A page that is navigating under us costs the
 * marking, not the snapshot.
 */
export async function secretSignals(
  session: BotSession,
  target: Page,
): Promise<SecretJoin> {
  /** How many inputs' refs one look reads, across every frame. */
  let budget = SECRET_INPUT_LIMIT;
  /** Every frame asked so far, answered or not. */
  const asked = new Set<Frame>();
  let frames: { frame: Frame; read: Promise<MarkedInputs> }[] = [];
  let fields = session.secretFields.map((field) => ({
    field,
    read: readTypedField(field),
  }));

  /**
   * Ask the frames not asked yet, wait for what is still silent, join what answers, and keep what
   * does not for the next call. Says whether an input was snapshotted for its ref.
   */
  const hear = async (into: SecretMarks, readRefs: boolean) => {
    for (const frame of target.frames()) {
      if (asked.has(frame)) continue;
      asked.add(frame);
      frames.push({ frame, read: readMarkedInputs(frame) });
    }
    const [frameAnswers, fieldAnswers] = await Promise.all([
      Promise.all(
        frames.map(({ read }) => within(SECRET_JOIN_TIMEOUT_MS, read)),
      ),
      Promise.all(
        fields.map(({ read }) => within(SECRET_JOIN_TIMEOUT_MS, read)),
      ),
    ]);
    let snapshotted = false;
    const refReads: Promise<string[]>[] = [];
    frames.forEach(({ frame }, index) => {
      const found = frameAnswers[index];
      if (!found) return;
      for (const entry of found) {
        if (entry.label) into.labels.push(entry.label);
        if (entry.value) into.values.push(entry.value);
      }
      const count = readRefs ? Math.min(found.length, budget) : 0;
      budget -= count;
      if (count > 0) {
        snapshotted = true;
        refReads.push(refsOfMarkedInputs(frame, count));
      }
    });
    fields.forEach(({ field }, index) => {
      const value = fieldAnswers[index];
      if (value === undefined) return;
      if (value === null) {
        // The node left the page, or the page left the browser: the secret went with it.
        session.secretFields = session.secretFields.filter(
          (kept) => kept !== field,
        );
        void field.handle.dispose().catch(() => undefined);
        return;
      }
      if (value) into.values.push(value);
    });
    into.refs.push(...(await Promise.all(refReads)).flat());
    frames = frames.filter((_, index) => frameAnswers[index] === undefined);
    fields = fields.filter((_, index) => fieldAnswers[index] === undefined);
    return snapshotted;
  };

  const marks: SecretMarks = { labels: [], values: [], refs: [] };
  await hear(marks, true);
  return {
    ...marks,
    async late({ refs }) {
      const heard: SecretMarks = { labels: [], values: [], refs: [] };
      const snapshotted = await hear(heard, refs);
      return { ...heard, snapshotted };
    },
  };
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

/**
 * Whether `ref`, in the current snapshot, is this very node. False for anything it cannot answer —
 * including a ref into a frame with no document, whose `count` has no timeout and waits for ever
 * (measured 2026-09-14).
 */
async function refNamesNode(
  target: Page,
  ref: string,
  handle: ElementHandle,
): Promise<boolean> {
  try {
    const located = target.locator(`aria-ref=${ref}`);
    if ((await within(SECRET_JOIN_TIMEOUT_MS, located.count())) !== 1) {
      return false;
    }
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
