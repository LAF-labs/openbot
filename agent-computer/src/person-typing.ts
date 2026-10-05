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
 *
 * AN EDITABLE REGION IS A BOX TOO. A `contenteditable` — a rich editor, a chat composer, a title a
 * person can rename — was left unfollowed until 2026-10-05, because the tree prints a plain one as
 * `generic`, which a look never lists. What a look does list is the control AROUND one, named by
 * the words inside it, and the page's text has every region's in it. Measured that day through
 * this service's own doors (`takeover-secret.test.ts`): a canary a person typed into a region came
 * back as the name of the link, the button, the tab and the option around it, of the button it
 * labelled and of the box whose `<label>` held it, as the name of a link inside it, and in `/read`
 * for every shape — a region that says it is a text box included, which was followed and blanked
 * in the list and read out whole as text. So the region is followed like any box, and it is what a
 * look and a read are kept clear of (`quietOn` in secret-fields.ts).
 */
import type { ElementHandle, Frame, JSHandle, Page } from "playwright";
import { arrivalOf, documentOf } from "./page-arrival";
import {
  heldBy,
  markTypedInto,
  rememberSecretField,
  SECRET_JOIN_TIMEOUT_MS,
} from "./secret-fields";
import type { BotSession, SecretField } from "./sessions";
import { digestOf, digestOfBlock, keepTyped } from "./typed-values";
import { within } from "./within";

/** How deep a focused frame is followed. A payment window inside a checkout inside a portal is three. */
const FRAME_DEPTH_LIMIT = 5;

/** What the page says about the element that has focus. `region`: see `SecretField.region`. */
type InFocus =
  | { kind: "none" }
  | { kind: "frame" }
  | { kind: "same"; value: string }
  | { kind: "other"; region: boolean };

/** The element with focus in one frame, through open shadow roots. */
function deepFocus(): Element | null {
  let node = document.activeElement;
  while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
  return node;
}

/**
 * The page's own answer about one element, the one that had focus: whether it holds typed text, is
 * a frame to look inside, or is the box the last keystroke landed in — with what that box holds now.
 *
 * TYPED TEXT IS AN INPUT THAT TAKES TEXT, A TEXTAREA, A TEXT-ENTRY ROLE, OR AN EDITABLE REGION. An
 * `<input type="password">` is in: its markup already blanks it, and following it is what keeps its
 * value out of an address. A region that is not a text box is in too, and said to be one (`region`):
 * the tree names it `generic`, which a look never lists (measured 2026-09-16), so no look searches
 * its boxes for it — which is why it used to be left out, and is not the same as nothing showing
 * what was typed there (the top of this file).
 *
 * What a region holds is read as far as a digest reads (`comparableValue` keeps 64 characters): a
 * document a person is writing is not carried out of the page on every keystroke.
 *
 * IT ANSWERS WITH A STRING ({@link inFocus} reads it). It answered with an object until
 * 2026-10-05, and an object comes back as nothing from a page that replaces `Map` (고용24;
 * `reader.ts` says how): there, every key a person pressed was a key typed blind, and the whole
 * document showed the Bot no box's contents for as long as it lived.
 */
function saidOf(node: Element, last: Node | null): string {
  const tag = node.localName;
  if (tag === "iframe" || tag === "frame") return "f";
  const role = node.getAttribute("role") ?? "";
  const isBox =
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
  const editable = (node as HTMLElement).isContentEditable === true;
  if (!isBox && !editable) return "n";
  if (node !== last) return isBox ? "o0" : "o1";
  return `s${
    tag === "input" || tag === "textarea"
      ? String((node as HTMLInputElement).value ?? "")
      : (node.textContent ?? "").slice(0, 512)
  }`;
}

/** What {@link saidOf} answered, or nothing when it is not an answer it gives. */
export function inFocus(said: unknown): InFocus | undefined {
  if (typeof said !== "string") return undefined;
  if (said === "n") return { kind: "none" };
  if (said === "f") return { kind: "frame" };
  if (said === "o0" || said === "o1") {
    return { kind: "other", region: said === "o1" };
  }
  return said.startsWith("s")
    ? { kind: "same", value: said.slice(1) }
    : undefined;
}

/**
 * The same focused box, as a locator — which is what can be asked for the ref a look names it by. The
 * role engine's `:focus` pierces open shadow roots and answers in a background tab (measured
 * 2026-09-16). Asked for the ref and nothing else: which element it is was already answered, by the
 * element.
 */
const FOCUSED_BOX = [
  "input:focus",
  "textarea:focus",
  '[role="textbox"]:focus',
  '[role="searchbox"]:focus',
  '[role="combobox"]:focus',
  '[role="spinbutton"]:focus',
  "[contenteditable]:focus",
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

/**
 * Mark this tab's current document as typed into blind: a person typed, and where cannot be known.
 * See `followTyping` for when that is.
 */
export function typedBlind(session: BotSession, target: Page): void {
  session.typedBlind.set(target, documentOf(target));
}

/**
 * Whether a look at this tab has to show no box's contents, because a person typed into its current
 * document somewhere that could not be known. A document that has been replaced since is forgotten:
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
  const read = await hear(ms, field.handle.evaluate(heldBy));
  if (read && "value" in read && typeof read.value === "string") {
    field.digest = digestOf(read.value) ?? field.digest;
  }
}

/** What had focus in a frame, as an element and as what the page says of it. */
type Focused = { element: ElementHandle | null; focus: InFocus };

/**
 * One frame's answer about the element `asked` names — what had focus when it was asked — compared
 * with the last box typed into when that box is in this frame. Undefined for silence.
 */
async function askFrame(
  session: BotSession,
  frame: Frame,
  asked: Promise<JSHandle>,
  wait: () => number,
): Promise<Focused | undefined> {
  const found = await hear(wait(), asked);
  if (!found) return undefined;
  // A frame that detached under the question has no box anybody can type into.
  const element = "value" in found ? found.value.asElement() : null;
  if (!element) return { element: null, focus: { kind: "none" } };
  const last = session.lastTyped;
  const lastHere = last?.frame === frame ? last.handle : null;
  const said = await hear(wait(), element.evaluate(saidOf, lastHere));
  if (said && "value" in said) {
    const focus = inFocus(said.value);
    return focus ? { element, focus } : undefined;
  }
  if (said && lastHere) {
    // The last box's document is gone, so its handle cannot be compared: ask without it.
    session.lastTyped = undefined;
    const again = await hear(wait(), element.evaluate(saidOf, null));
    if (!again) return undefined;
    const focus = "value" in again ? inFocus(again.value) : undefined;
    return { element, focus: focus ?? { kind: "none" } };
  }
  return said ? { element, focus: { kind: "none" } } : undefined;
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
  if (compared && "value" in compared && typeof compared.value === "number") {
    return here[compared.value];
  }
  // One of them is from a document this frame has left, or the page will not take a list (one that
  // replaces `Map` throws on it): one at a time.
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

/**
 * Follow the element a keystroke is about to land in, and mark it in its page. Undefined when it
 * could not be marked there: followed here and unknown to every later question, which is blind.
 */
async function followFocused(
  session: BotSession,
  frame: Frame,
  element: ElementHandle,
  wait: () => number,
  region: boolean,
): Promise<SecretField | undefined> {
  const [known, line] = await Promise.all([
    alreadyFollowed(session, frame, element, wait),
    /*
     * For the ref a look names it by, where it has one. NOT READ-ONLY: a snapshot of one box becomes
     * the one `aria-ref=` resolves this frame's refs against (see `refsOfMarkedInputs`). Harmless
     * here — a person holds the wheel, so the Bot has no action to take with the refs it had, and
     * its next look takes the page's tree again. A page whose focus the locator does not find — a
     * document edited whole has no attribute to find it by — is followed by its element all the
     * same, and looked for at the next look.
     */
    hear(
      SECRET_JOIN_TIMEOUT_MS,
      frame
        .locator(FOCUSED_BOX)
        .last()
        .ariaSnapshot({ mode: "ai", timeout: SECRET_JOIN_TIMEOUT_MS }),
    ),
  ]);
  const field =
    known ??
    rememberSecretField(
      session,
      element,
      line && "value" in line
        ? (/\[ref=([^\]\s]+)\]/.exec(line.value)?.[1] ?? "")
        : "",
      { frame, region },
    );
  if (!field) return undefined;
  if (!field.document && !(await markTypedInto(session, field))) {
    return undefined;
  }
  return field;
}

/** Let handles go once nothing more is asked of them. */
function release(...asked: Promise<JSHandle>[]): void {
  for (const each of asked) {
    void each.then((handle) => handle.dispose()).catch(() => undefined);
  }
}

/**
 * How long the page is given to say what has focus, before a keystroke is sent into it.
 *
 * LONGER THAN ANY OTHER QUESTION HERE, because of what it costs to give up: a document typed into
 * blind shows the Bot no box's contents, its own included, and no name the page did not compute
 * again, for as long as the document lives — on a single-page app, the session. And waiting costs
 * the person nothing a busy page was not already costing them: a page that cannot answer this
 * cannot take the key either, and both are waiting for the same thread. It was one second until
 * 2026-10-05, shared with finding the box's ref, and one slow answer under one key was enough.
 */
const FOCUS_WAIT_MS = 3 * SECRET_JOIN_TIMEOUT_MS;

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
 * And answered before the key is sent, never after it: the page takes a key ahead of a question
 * that was put first, so an answer that came late would be the focus the key left behind.
 *
 * BLIND IS FOR WHAT COULD NOT BE KNOWN, and that is four things: the tab's next document was already
 * on its way, so no question could reach the page ahead of the key; the page said nothing about
 * its focus for {@link FOCUS_WAIT_MS}; the focus was inside a frame that could not be entered in
 * that time, or more than {@link FRAME_DEPTH_LIMIT} deep; or the element could not be marked in its
 * page. It is not for a page that was slow to hand over the box's ref, one that replaces `Map`, or
 * a document edited whole — each of which used to be, and each of which is followed by the element
 * the page named.
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
  const deadline = Date.now() + FOCUS_WAIT_MS;
  const wait = () => Math.max(deadline - Date.now(), 1);
  let frame = target.mainFrame();
  /** Every element asked for on the way down, let go at the end unless a field took it. */
  const asked: Promise<JSHandle>[] = [];
  for (let depth = 0; depth < FRAME_DEPTH_LIMIT; depth += 1) {
    if (Date.now() >= deadline) break;
    const here = frame.evaluateHandle(deepFocus);
    asked.push(here);
    const found = await askFrame(session, frame, here, wait);
    if (!found) break;
    const { element, focus } = found;
    if (focus.kind === "none" || !element) return release(...asked);
    if (focus.kind === "same") {
      if (session.lastTyped) {
        session.lastTyped.digest =
          digestOf(focus.value) ?? session.lastTyped.digest;
      }
      return release(...asked);
    }
    if (focus.kind === "frame") {
      const child = await hear(wait(), element.contentFrame());
      if (!child) break;
      // An iframe with nothing to enter is one the tree cannot see into either.
      if (!("value" in child) || !child.value) return release(...asked);
      frame = child.value;
      continue;
    }
    const followed = await followFocused(
      session,
      frame,
      element,
      wait,
      focus.region,
    );
    if (!followed) break;
    // Moving to another box is when the box before it is finished with, for now: read it once more.
    const before = session.lastTyped;
    session.lastTyped = followed;
    if (before && before !== followed) {
      await reread(before, SECRET_JOIN_TIMEOUT_MS);
    }
    // The element is the field's now, unless the field was one already followed.
    return release(
      ...asked.filter((each) => each !== here || followed.handle !== element),
    );
  }
  release(...asked);
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
 * How long a piece of input waits for the one before it. Finding a box is bounded — the focus at
 * {@link FOCUS_WAIT_MS}, then its mark, its ref and one more read of the box before it, a second
 * each — so a piece still unfinished after this is a dispatch the page is not taking — a renderer
 * in a loop does not acknowledge a key — and the pieces behind it, the hand-back of the wheel among
 * them, must not wait on it for ever. Order stops mattering to a page that is taking no input
 * anyway. Six seconds since 2026-10-05, where it was three: the focus is waited for longer, so
 * that a slow page is not a page typed into blind.
 */
export const TURN_WAIT_MS = FOCUS_WAIT_MS + 3 * SECRET_JOIN_TIMEOUT_MS;

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
