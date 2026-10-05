/**
 * The box a person's typing lands in, followed from their keystroke on.
 *
 * NOTHING A PERSON TYPES DURING A TAKEOVER REACHES THE MODEL, `human-input.ts` promises — and until
 * 2026-09-16 only the boxes a page marked as a password, or a listed word named, kept that promise.
 * Measured (audit R3-01) on the real computer: a box called 승인번호, `/control/take`, `/human/type
 * "SEC-TAKEOVER-9911"`, `/control/release`, and the next `/snapshot` said `"value":"SEC-TAKEOVER-9911"`.
 * A word list cannot know every name a page gives the box a person is asked to fill; the box itself
 * is known, because the person's keystroke is what put the value there.
 *
 * So before any keystroke of theirs reaches the page, the page is asked which box has focus — through
 * frames, a payment window's from another origin included, and open shadow roots — and that box is
 * followed by identity, exactly as a box `computer_request_secret` filled is (`secret-fields.ts`):
 * marked and blanked in every later look, whatever the page renames it, until it is gone. What is
 * kept is where the typing went and a keyed digest of what the box held (`typed-values.ts`), never
 * the value.
 *
 * A PAGE THAT WILL NOT SAY is typed into blind: its next document is on its way, or it is too busy to
 * answer. The keystroke still goes — a person is typing, and a screen that eats keys is a broken
 * screen — and that document shows no box's contents to the Bot until it is gone.
 */
import type { ElementHandle, Frame, Page } from "playwright";
import { arrivalOf, documentOf } from "./page-arrival";
import { rememberSecretField, SECRET_JOIN_TIMEOUT_MS } from "./secret-fields";
import type { BotSession, SecretField } from "./sessions";
import { digestOf, digestOfBlock, keepTyped } from "./typed-values";
import { within } from "./within";

/** How deep a focused frame is followed. A payment window inside a checkout inside a portal is three. */
const FRAME_DEPTH_LIMIT = 5;

/** What the page says about its focus, in one frame. */
type InFocus =
  | { kind: "none" }
  | { kind: "frame" }
  | { kind: "same"; value: string }
  | { kind: "other" };

/**
 * The page's own answer, run in one frame: whether the element with focus holds typed text, is a
 * frame to look inside, or is the box the last keystroke landed in — with what that box holds now.
 *
 * TYPED TEXT IS AN INPUT THAT TAKES TEXT, A TEXTAREA, OR A TEXT-ENTRY ROLE. A plain `contenteditable`
 * is left out on purpose: the tree names it `generic`, which a look never lists (measured 2026-09-16),
 * so following it would cost every look a search for a box it could never show. An `<input
 * type="password">` is in: its markup already blanks it, and following it is what keeps its value
 * out of an address.
 */
function focusOf(last: Node | null): InFocus {
  let node = document.activeElement;
  while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
  if (!node) return { kind: "none" };
  const tag = node.localName;
  if (tag === "iframe" || tag === "frame") return { kind: "frame" };
  const role = node.getAttribute("role") ?? "";
  const takesText =
    tag === "textarea" ||
    (tag === "input" &&
      ![
        "button",
        "checkbox",
        "color",
        "file",
        "hidden",
        "image",
        "radio",
        "range",
        "reset",
        "submit",
      ].includes((node as HTMLInputElement).type)) ||
    ["textbox", "searchbox", "combobox", "spinbutton"].includes(role);
  if (!takesText) return { kind: "none" };
  if (node !== last) return { kind: "other" };
  return {
    kind: "same",
    value:
      tag === "input" || tag === "textarea"
        ? String((node as HTMLInputElement).value ?? "")
        : "",
  };
}

/** The element with focus in one frame, through open shadow roots. */
function deepFocus(): Element | null {
  let node = document.activeElement;
  while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
  return node;
}

/**
 * The same focused box, as a locator — which is what can be asked for the ref a look names it by. The
 * role engine's `:focus` pierces open shadow roots and answers in a background tab (measured
 * 2026-09-16), and `focusOf` has already said the focused element is one of these.
 */
const FOCUSED_BOX = [
  "input:focus",
  "textarea:focus",
  '[role="textbox"]:focus',
  '[role="searchbox"]:focus',
  '[role="combobox"]:focus',
  '[role="spinbutton"]:focus',
].join(", ");

/** Settled or not, kept apart from silence: `within` alone would read a failure as no answer. */
type Heard<T> = { value: T } | { error: unknown } | undefined;

function hear<T>(ms: number, work: Promise<T>): Promise<Heard<T>> {
  return within(
    ms,
    work.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ),
  );
}

/** Mark this tab's current document as typed into blind. See the top of this file. */
function typedBlind(session: BotSession, target: Page): void {
  session.typedBlind.set(target, documentOf(target));
}

/**
 * Whether a look at this tab has to show no box's contents, because a person typed into its current
 * document somewhere the page would not say. A document that has been replaced since is forgotten:
 * what was typed went with it.
 */
export function typedIntoBlind(session: BotSession, target: Page): boolean {
  if (!session.typedBlind.has(target)) return false;
  const typedAt = session.typedBlind.get(target);
  const now = documentOf(target);
  if (typedAt !== undefined && now !== undefined && now !== typedAt) {
    session.typedBlind.delete(target);
    return false;
  }
  return true;
}

/** What a followed box holds now, into its digest — or nothing, if it will not say. */
async function reread(field: SecretField, ms: number): Promise<void> {
  const read = await hear(
    ms,
    field.handle.evaluate((node) =>
      node.isConnected ? String((node as HTMLInputElement).value ?? "") : null,
    ),
  );
  if (read && "value" in read && typeof read.value === "string") {
    field.digest = digestOf(read.value) ?? field.digest;
  }
}

/** One frame's answer, compared with the last box typed into when that box is in this frame. */
async function askFrame(
  session: BotSession,
  frame: Frame,
  wait: () => number,
): Promise<InFocus | undefined> {
  const last = session.lastTyped;
  const lastHere = last?.frame === frame ? last.handle : null;
  const asked = await hear(wait(), frame.evaluate(focusOf, lastHere));
  if (asked && "value" in asked) return asked.value;
  if (asked && lastHere) {
    // The last box's document is gone, so its handle cannot be compared: ask without it.
    session.lastTyped = undefined;
    const again = await hear(wait(), frame.evaluate(focusOf, null));
    if (again && "value" in again) return again.value;
    return again ? { kind: "none" } : undefined;
  }
  // A frame that detached under the question has no box anybody can type into.
  return asked ? { kind: "none" } : undefined;
}

/** The frame inside the focused `<iframe>`, null when there is none to enter, undefined for silence. */
async function focusedChild(
  frame: Frame,
  wait: () => number,
): Promise<Frame | null | undefined> {
  const found = await hear(wait(), frame.evaluateHandle(deepFocus));
  if (!found) return undefined;
  if (!("value" in found)) return null;
  const element = found.value.asElement();
  if (!element) {
    void found.value.dispose().catch(() => undefined);
    return null;
  }
  const child = await hear(wait(), element.contentFrame());
  void element.dispose().catch(() => undefined);
  if (!child) return undefined;
  return "value" in child ? child.value : null;
}

/** Whether a new handle is a box already followed in this frame, and which. */
async function alreadyFollowed(
  session: BotSession,
  frame: Frame,
  handle: ElementHandle,
  wait: () => number,
): Promise<SecretField | undefined> {
  const here = session.secretFields.filter((field) => field.frame === frame);
  if (!here.length) return undefined;
  const compared = await hear(
    wait(),
    handle.evaluate(
      (node, known) => known.indexOf(node),
      here.map((field) => field.handle),
    ),
  );
  if (compared && "value" in compared) return here[compared.value];
  // One of them is from a document this frame has left, and cannot be compared: one at a time.
  const each = await Promise.all(
    here.map((field) =>
      hear(
        wait(),
        handle.evaluate((node, other) => node === other, field.handle),
      ),
    ),
  );
  return here.find((_, index) => {
    const answer = each[index];
    return answer !== undefined && "value" in answer && answer.value;
  });
}

/** Follow the focused box of a frame, once. Undefined when the frame would not say which it is. */
async function followFocused(
  session: BotSession,
  frame: Frame,
  wait: () => number,
): Promise<SecretField | null | undefined> {
  const boxes = frame.locator(FOCUSED_BOX);
  const count = await hear(wait(), boxes.count());
  if (!count) return undefined;
  if (!("value" in count)) return null;
  // The page said a box has focus and will not show which: typing into it is typing blind.
  if (count.value === 0) return undefined;
  // The last is the innermost: a host that delegates focus matches `:focus` before its own box does.
  const box = count.value > 1 ? boxes.last() : boxes;
  const [handle, line] = await Promise.all([
    hear(wait(), box.elementHandle({ timeout: SECRET_JOIN_TIMEOUT_MS })),
    /*
     * NOT READ-ONLY: a snapshot of one box becomes the one `aria-ref=` resolves this frame's refs
     * against (see `refsOfMarkedInputs`). Harmless here — a person holds the wheel, so the Bot has no
     * action to take with the refs it had, and its next look takes the page's tree again.
     */
    hear(
      wait(),
      box.ariaSnapshot({ mode: "ai", timeout: SECRET_JOIN_TIMEOUT_MS }),
    ),
  ]);
  if (!handle) return undefined;
  if (!("value" in handle)) return null;
  const known = await alreadyFollowed(session, frame, handle.value, wait);
  if (known) {
    void handle.value.dispose().catch(() => undefined);
    return known;
  }
  const ref =
    line && "value" in line
      ? (/\[ref=([^\]\s]+)\]/.exec(line.value)?.[1] ?? "")
      : "";
  return rememberSecretField(session, handle.value, ref, { frame });
}

/**
 * Before a person's keystroke or block of text reaches `target`: follow the box it will land in.
 *
 * Asked BEFORE, because the keystroke may be what moves on — an Enter that sends the form, a digit
 * that moves a code box to the next — and a box asked after it is either somewhere else or on a page
 * that is leaving (measured 2026-09-16: a read after Enter on a GET form waited for the next page and
 * then failed). The same question reads what the box holds so far, which is the value after the
 * keystroke before; the last one is read at the next keystroke, the next press, the release or the
 * next look, whichever comes first (`settleTyping`).
 *
 * `typed`, when the input is a block of text, is kept by digest as well: a pasted code is the whole
 * value, and it is the one a page that sends itself on the last digit carries away before anything
 * could read the box again.
 */
export async function followTyping(
  session: BotSession,
  target: Page,
  typed?: string,
): Promise<void> {
  if (typed !== undefined) keepTyped(session, digestOfBlock(typed));
  if (arrivalOf(target)) return typedBlind(session, target);
  // Already blind on this document: every box is blank to the Bot, so a question per key buys nothing.
  if (typedIntoBlind(session, target)) return;
  const deadline = Date.now() + SECRET_JOIN_TIMEOUT_MS;
  const wait = () => Math.max(deadline - Date.now(), 1);
  let frame = target.mainFrame();
  for (let depth = 0; depth < FRAME_DEPTH_LIMIT; depth += 1) {
    if (Date.now() >= deadline) break;
    const focus = await askFrame(session, frame, wait);
    if (!focus) break;
    if (focus.kind === "none") return;
    if (focus.kind === "same") {
      if (session.lastTyped) {
        session.lastTyped.digest =
          digestOf(focus.value) ?? session.lastTyped.digest;
      }
      return;
    }
    if (focus.kind === "frame") {
      const child = await focusedChild(frame, wait);
      if (child === undefined) break;
      // An iframe with nothing to enter is one the tree cannot see into either.
      if (child === null) return;
      frame = child;
      continue;
    }
    const followed = await followFocused(session, frame, wait);
    if (followed === undefined) break;
    if (followed === null) return;
    // Moving to another box is when the box before it is finished with, for now: read it once more.
    const before = session.lastTyped;
    session.lastTyped = followed;
    if (before && before !== followed) await reread(before, wait());
    return;
  }
  typedBlind(session, target);
}

/**
 * Before something that can send a form — a press, a release of the wheel — read what the last box
 * typed into holds now, so its digest is the value the form will carry. `every` reads every box.
 */
export async function settleTyping(
  session: BotSession,
  options: { every?: boolean } = {},
): Promise<void> {
  const fields = options.every
    ? session.secretFields
    : session.lastTyped
      ? [session.lastTyped]
      : [];
  await Promise.all(
    fields.map((field) => reread(field, SECRET_JOIN_TIMEOUT_MS)),
  );
}

/**
 * How long a piece of input waits for the one before it. Finding a box is bounded at a second, so a
 * piece still unfinished after this is a dispatch the page is not taking — a renderer in a loop does
 * not acknowledge a key — and the pieces behind it, the hand-back of the wheel among them, must not
 * wait on it for ever. Order stops mattering to a page that is taking no input anyway.
 */
export const TURN_WAIT_MS = 3 * SECRET_JOIN_TIMEOUT_MS;

/**
 * Apply one piece of a person's input after every piece before it, or once that one has had its
 * time. Never rejects, so one failed piece does not stop the ones behind it; the piece's own caller
 * hears its failure.
 */
export function inTurn<T>(
  session: BotSession,
  work: () => Promise<T>,
): Promise<T> {
  const turn = within(TURN_WAIT_MS, session.personInput).then(work);
  session.personInput = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}
