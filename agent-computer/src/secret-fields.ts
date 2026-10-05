/**
 * Which fields on a page hold a secret, for the snapshot to mark and blank — by markup, and by the
 * identity of the node a person typed one into.
 *
 * THE ACCESSIBLE TREE DOES NOT SAY. Playwright reports `<input type="password">` as a `textbox`,
 * the same as a name field, and the boundary's whole rule about secrets is that a Bot must never
 * type into one nor read what is in it. The parsing half of the join lives in `aria-snapshot.ts`
 * (`SecretSignals`), which has no Playwright in it; this is the half that asks the page.
 */
import { randomBytes } from "node:crypto";
import type { ElementHandle, Frame, Page } from "playwright";
import {
  isTextEntryRole,
  readAriaSnapshot,
  type Viewport,
} from "./aria-snapshot";
import { type Control, typedRefs } from "./marked-refs";
import type { BotSession, SecretField } from "./sessions";
import { digestOf, keepTyped } from "./typed-values";
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

/**
 * How many fields a session follows. Each is a live handle into the page, and each is looked for at
 * every snapshot (`typedIntoRefs`).
 *
 * Twenty-four, not the eight it was while only `computer_request_secret` filled these: a person
 * holding the wheel types into every box of the form in front of them, and a Korean checkout is card
 * number in four boxes, expiry in two, CVC, the card password's first two digits and a birth date —
 * nine on one page before 본인인증 asks for five more. A box pushed off the end is a box whose value
 * the next look shows, so the list is sized for the form, not for the typical login.
 */
const SECRET_FIELD_LIMIT = 24;

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

/**
 * What a followed node holds now, or null once it has left its document. Runs in the page.
 *
 * A box holds its value. An editable region holds its text, read only as far as a digest reads
 * (`comparableValue` keeps 64 characters): a document a person is writing is not carried out of
 * the page at every look.
 */
export function heldBy(node: Element): string | null {
  if (!node.isConnected) return null;
  const tag = node.localName;
  return tag === "input" || tag === "textarea"
    ? String((node as HTMLInputElement).value ?? "")
    : (node.textContent ?? "").slice(0, 512);
}

/** The answer of a handle that can no longer be asked anything: its document is gone. */
const UNASKABLE = Symbol("unaskable");

/** What a field a person typed into holds, or null while its node is out of its document. */
function readTypedField(
  field: SecretField,
): Promise<string | null | typeof UNASKABLE> {
  return field.handle.evaluate(heldBy).catch(() => UNASKABLE);
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
 * The values of the fields a person typed a secret into are read here too, by their handles.
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
      /*
       * A node that is out of its document, or that did not answer, is STILL FOLLOWED. It used to
       * be let go here, and a node a page takes out and puts back — a tab kept alive behind
       * another, a dialog closed and reopened — came back holding what a person typed with nobody
       * following it (measured 2026-10-05). A field is let go when its document is
       * (`quietOn`), and not before.
       */
      if (value === undefined || value === null) return;
      if (value === UNASKABLE) {
        // Only a field that was never marked in its page: nothing else will say its document went.
        if (!field.document) letGo(session, field);
        return;
      }
      if (value) into.values.push(value);
      field.digest = digestOf(value) ?? field.digest;
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
 * The text-entry controls the look will list, each with where the tree says it is drawn: the ones a
 * typed-into box is looked for among.
 *
 * BY THE LIST'S OWN CUT, from the same call with the same viewport. Past 200 controls the list keeps
 * what is on the screen first (`keptOf` in aria-snapshot.ts); asked of the first 200 in page order,
 * as this used to be, a box on the screen past that point would be listed with its contents and
 * never looked for here — a renamed box holding a secret, shown.
 */
function listedTextEntry(yaml: string, viewport?: Viewport): Control[] {
  const read = readAriaSnapshot(yaml, {}, viewport);
  return read.elements
    .filter((element) => isTextEntryRole(element.role))
    .map(({ ref }) => {
      const box = read.boxes.get(ref);
      return box ? { ref, box } : { ref };
    });
}

/** The refs of {@link listedTextEntry}. */
export function listedTextEntryRefs(
  yaml: string,
  viewport?: Viewport,
): string[] {
  return listedTextEntry(yaml, viewport).map(({ ref }) => ref);
}

/**
 * The refs, in the snapshot just taken, of the boxes a person typed into — and whether the page
 * could be asked at all.
 *
 * BY THE MARK ON THE NODE, WHATEVER THE PAGE HAS DONE TO IT SINCE. A ref outlives a snapshot only
 * while the node keeps its role and name: rename the box — a validation message added to its label
 * is enough — and Playwright mints it a new ref (measured: `e1` became `e5`, value and all). So a
 * box is never looked for by its ref or its label. Its node carries the mark from the keystroke on
 * (`markTypedInto`); the page says where its marked boxes are drawn and how many there are
 * (`scanTyped`), the controls drawn there are asked whether they carry it, and every listed box is
 * asked only when that finds fewer than the page counted.
 *
 * ONE QUESTION TO A FRAME, NOT ONE TO EVERY BOX ABOUT EVERY BOX. Until 2026-10-05 each followed box
 * was asked against each listed text-entry control in turn, two round trips a pair — and once a
 * box stayed followed while it was out of its document, a closed step of nine boxes beside a form
 * of twelve was over two hundred sequential round trips at every look, for the life of the
 * document. A box that is out of its document is in no tree and is asked against nothing; a box
 * this session no longer follows is still found, since the mark is on the node.
 *
 * A control that does not answer is taken to be one. NOT COMPLETE is the look's deadline come
 * before the question could be put: the caller then shows no box's contents (`unverified`).
 */
export async function typedIntoRefs(
  target: Page,
  yaml: string,
  typed: TypedInto["boxes"],
  deadline: number,
  viewport?: Viewport,
): Promise<{ refs: string[]; complete: boolean }> {
  if (typed.expected === 0) return { refs: [], complete: true };
  const ms = Math.min(SECRET_JOIN_TIMEOUT_MS, deadline - Date.now());
  if (ms <= 0) return { refs: [], complete: false };
  return {
    refs: [
      ...(await typedRefs(target, listedTextEntry(yaml, viewport), typed, ms)),
    ],
    complete: true,
  };
}

/** Stop following one field, keeping the digest of what it held. */
function letGo(session: BotSession, field: SecretField): void {
  session.secretFields = session.secretFields.filter((kept) => kept !== field);
  if (session.lastTyped === field) session.lastTyped = undefined;
  keepTyped(session, field.digest);
  void field.handle.dispose().catch(() => undefined);
}

/**
 * Follow a field a person just typed into, from the next snapshot on — and say which record follows it.
 *
 * `known` is what the caller already has: the frame the field is in, and the digest of what was
 * typed. With no handle — the page left on the keystroke — there is no field to follow, and the
 * digest is what is kept, for the address the page left for.
 */
export function rememberSecretField(
  session: BotSession,
  handle: ElementHandle | null,
  known: { frame?: Frame; digest?: string | undefined } = {},
): SecretField | null {
  if (!handle) {
    keepTyped(session, known.digest);
    return null;
  }
  const field: SecretField = {
    handle,
    ...(known.frame ? { frame: known.frame } : {}),
    ...(known.digest ? { digest: known.digest } : {}),
  };
  session.secretFields.push(field);
  while (session.secretFields.length > SECRET_FIELD_LIMIT) {
    const oldest = session.secretFields[0];
    if (oldest) letGo(session, oldest);
  }
  return field;
}

/**
 * The marks this service leaves in a page, each a property under `Symbol.for` of a name drawn when
 * the process starts: on a node a person typed into, on the document that holds one, and — for one
 * look at a time — on everything that could take its name from one.
 *
 * A MARK ON THE NODE, NOT AN ARGUMENT TO THE QUESTION. The reader is sent to the page as source and
 * takes no argument, because a page that replaces `Map` breaks the passing of a list (`reader.ts`,
 * 고용24) — and a question that has to leave a node out has to be told which. A property under a
 * symbol is not an attribute: no observer of the page's hears it, no style sheet matches it, it
 * goes where the node goes, and it is the same in every frame, so no node has to be matched to the
 * document it is in. A page that looks for it can find it, and learns that somebody typed into a
 * node it has been sending that typing's events to all along.
 *
 * AND IT OUTLIVES THE FOLLOWING. This session follows twenty-four nodes and no more, and a page can
 * take a node out of its document and put it back. The mark stays on the node through both, and
 * the document's own mark says there is one to look for — so the names around a node and the
 * page's text are made without every marked node the document holds now, not only the ones still
 * on a list here. (A box's own value in the list is another matter: that is blanked by the field
 * that follows it, for as long as one does — `SECRET_FIELD_LIMIT`.)
 */
const MARKS = `laf.quiet.${randomBytes(9).toString("base64url")}`;
const TYPED_MARK = MARKS;
const DOCUMENT_MARK = `${MARKS}.document`;
const NEAR_MARK = `${MARKS}.near`;

/**
 * Mark a node as typed into, and its document as holding one; the document's mark is a name of its
 * own, kept if it already has one and answered either way. Runs in the page.
 */
function markTyped(node: Element, marks: string): string {
  const [typed = "", holder = "", fresh = ""] = marks.split("|");
  (node as unknown as Record<symbol, boolean>)[Symbol.for(typed)] = true;
  const page = node.ownerDocument as unknown as Record<symbol, unknown>;
  const known = page[Symbol.for(holder)];
  if (typeof known === "string") return known;
  page[Symbol.for(holder)] = fresh;
  return fresh;
}

/**
 * Mark a field this session has just begun to follow, in its page, and remember the frame it is in.
 * False when that could not be done in time — the caller then knows nothing about where the typing
 * went that a later look could use, which is what typing blind is (`person-typing.ts`).
 */
export async function markTypedInto(
  session: BotSession,
  field: SecretField,
  ms: number = SECRET_JOIN_TIMEOUT_MS,
): Promise<boolean> {
  const wait = Math.max(1, Math.min(ms, SECRET_JOIN_TIMEOUT_MS));
  const frame =
    field.frame ??
    (await within(
      wait,
      field.handle.ownerFrame().catch(() => null),
    ));
  if (!frame) return false;
  field.frame = frame;
  const named = await within(
    wait,
    field.handle
      .evaluate(
        markTyped,
        `${TYPED_MARK}|${DOCUMENT_MARK}|${randomBytes(6).toString("base64url")}`,
      )
      .catch(() => undefined),
  );
  if (!named) return false;
  field.document = named;
  session.typedFrames.add(frame);
  return true;
}

/**
 * Runs in one frame, sent as source: where the marked nodes of this document are now, and what could
 * take its name from one.
 *
 * `gone` when the document carries no mark: it is not the one a person typed into — and only then,
 * however few of its marked nodes are in it at this moment: a page puts a node back. Otherwise the
 * document's own name and, apart by `|`: how many controls a look could list are NEAR a marked node
 * that the scan before this one (`also`) had not found; where each near control is drawn; how many
 * marked nodes are boxes a look could list; and where each of those is drawn.
 *
 * NEAR IS EVERYTHING A NAME COULD REACH A MARKED NODE THROUGH, followed the other way: from the node,
 * and from everything inside it, up to each element above (a parent, a shadow tree's host, the slot
 * it is assigned to), across to whatever is labelled by one of those (`aria-labelledby`, in the
 * same tree) or owns it by id (`aria-owns`: from any tree when it is in the document, as the
 * browser's own tree resolves it, and from its own tree, as a name is computed),
 * and from a `<label>` to the control it is for — and on from each of those, until nothing is
 * added. Those are the paths the role engine computes a name along (`page-names.ts` follows the
 * same ones forward), so a control that is not near cannot be named out of what a person typed,
 * and is not asked about.
 *
 * EACH LOOK'S NEAR MARKS ARE ITS OWN. A near element carries, under the near mark, the token of
 * every scan that found it near, and a control of the list is asked whether it carries THIS look's
 * (`marked-refs.ts`). It carried only the latest scan's until 2026-10-05, so a read of the same tab
 * that overlapped a look — a routine running while a person chats — wrote over the look's token
 * between its scan and its question, the look found nothing near, and the link around what a
 * person had typed was listed under the tree's name. A token is taken off only by a scan whose
 * own token was made more than a minute after it (a token begins with the moment it was made, by
 * this service's clock), which is four times as long as any look may take: nothing a look in
 * progress wrote can be removed, by anybody, and nothing waits on anything — so there is nothing
 * to starve or to deadlock. With no token, nothing is marked near at all: a read needs only to
 * know what is there.
 *
 * A box is said as Playwright says a box in the tree (`getBoundingClientRect`, rounded), so the
 * look can try the controls drawn at those places first.
 */
function scanTyped(packed: string): string {
  const [
    typedName = "",
    holderName = "",
    nearName = "",
    token = "",
    also = "",
  ] = packed.split("|");
  const typed = Symbol.for(typedName);
  const near = Symbol.for(nearName);
  type Marked = Record<symbol, unknown>;
  const named = (document as unknown as Marked)[Symbol.for(holderName)];
  if (typeof named !== "string") return "gone";
  const marked: Element[] = [];
  /** Everything that names or owns something else by id. */
  const referring: Element[] = [];
  const everyElement = (
    root: Document | ShadowRoot | Element,
    each: (element: Element) => void,
  ): void => {
    for (const element of Array.from(root.querySelectorAll("*"))) {
      each(element);
      if (element.shadowRoot) everyElement(element.shadowRoot, each);
    }
  };
  everyElement(document, (element) => {
    if ((element as unknown as Marked)[typed] === true) marked.push(element);
    if (
      element.hasAttribute("aria-labelledby") ||
      element.hasAttribute("aria-owns")
    ) {
      referring.push(element);
    }
  });

  /** The roles a look lists, and the elements that have one of them without saying so. */
  const listed =
    /^(button|checkbox|combobox|link|listbox|menuitem|menuitemcheckbox|menuitemradio|option|radio|searchbox|slider|spinbutton|switch|tab|textbox)$/;
  const textEntry = /^(textbox|searchbox|combobox|spinbutton)$/;
  const roles = (element: Element): string[] =>
    (element.getAttribute("role") ?? "").split(/\s+/);
  const listable = (element: Element): boolean => {
    const tag = element.localName;
    return (
      roles(element).some((role) => listed.test(role)) ||
      tag === "button" ||
      tag === "select" ||
      tag === "textarea" ||
      tag === "option" ||
      tag === "datalist" ||
      (tag === "input" && (element as HTMLInputElement).type !== "hidden") ||
      ((tag === "a" || tag === "area") && element.hasAttribute("href"))
    );
  };
  const drawnAt = (element: Element): string => {
    const box = element.getBoundingClientRect();
    return [box.x, box.y, box.width, box.height].map(Math.round).join(",");
  };

  /** A box a look lists as one that holds text. */
  const isBox = (node: Element): boolean => {
    const tag = node.localName;
    return (
      tag === "textarea" ||
      (tag === "input" && (node as HTMLInputElement).type !== "hidden") ||
      roles(node).some((role) => textEntry.test(role))
    );
  };
  /** The marked nodes that are such boxes: asked for by this mark, not by a token. */
  const boxes = marked.filter(isBox);
  const typedPart = `${boxes.length}|${boxes.map(drawnAt).join(";")}`;
  if (!token || marked.length === 0) return `${named}|0||${typedPart}`;

  /**
   * The tokens an element carries, with the ones too old to be any look's taken off. By the moment
   * this scan's own token was made, which is this service's clock: the page's is the page's to set.
   */
  const now = Number.parseInt(token, 10);
  const carried = (element: Element): string[] => {
    const held = (element as unknown as Marked)[near];
    return typeof held === "string"
      ? held
          .split(" ")
          .filter((each) => each && now - Number.parseInt(each, 10) < 60_000)
      : [];
  };
  const reached: Element[] = [];
  let fresh = 0;
  const reach = (node: Node | null | undefined): void => {
    if (node?.nodeType !== 1) return;
    const element = node as Element;
    const tokens = carried(element);
    if (tokens.includes(token)) return;
    (element as unknown as Marked)[near] = [...tokens, token].join(" ");
    reached.push(element);
    if (listable(element) && !(also && tokens.includes(also))) fresh += 1;
  };
  /** Reach everything a name could come through to `element`: what is above it, labelled by it, owning it. */
  const spread = (element: Element): void => {
    reach((element as HTMLElement).assignedSlot);
    const above = element.parentNode;
    reach(above && above.nodeType === 11 ? (above as ShadowRoot).host : above);
    if (element.localName === "label") {
      reach((element as HTMLLabelElement).control);
    }
    const id = element.id;
    if (!id) return;
    const root = element.getRootNode();
    for (const other of referring) {
      /*
       * A label is looked for in the labelled element's own tree. What is owned is looked for in
       * two: in the document, from whatever tree the owner is in, when the browser builds its
       * tree's children — and in the owner's own tree when it computes a NAME (Playwright's
       * `getIdRefs`). For one commit (2026-10-05) only the document counted, and a button in a
       * shadow tree that owns the note beside it kept the name the tree gave it: its own word and
       * what a person had typed into the note.
       */
      const same = other.getRootNode() === root;
      const labels = same ? (other.getAttribute("aria-labelledby") ?? "") : "";
      const owns =
        root === document || same
          ? (other.getAttribute("aria-owns") ?? "")
          : "";
      if (`${labels} ${owns}`.split(/\s+/).includes(id)) reach(other);
    }
  };
  for (const node of marked) {
    /*
     * A box is not near itself: its name is never its own contents, so it is asked about only if
     * something else it is near says so — and keeps the name the tree gave it when the page says
     * nothing. Everything else that carries the mark is: an editable region's own name can be the
     * words inside it, and so can the name of what was editable only while a person typed — a
     * tab renamed in place is plain again once it loses focus, and is called what was typed.
     */
    if (isBox(node) && !(node as HTMLElement).isContentEditable) spread(node);
    else reach(node);
    everyElement(node, reach);
    if (node.shadowRoot) everyElement(node.shadowRoot, reach);
  }
  for (let at = 0; at < reached.length; at += 1) {
    spread(reached[at] as Element);
  }
  return `${named}|${fresh}|${reached
    .filter(listable)
    .map(drawnAt)
    .join(";")}|${typedPart}`;
}

/** How a page says its own JavaScript threw inside {@link scanTyped}: nothing after it is said. */
const SCAN_THREW = "!";

/** What the page said, in one scan, about what a person typed into a tab. */
export type TypedInto = {
  /**
   * Where the typing is could not be said: a person typed blind (`person-typing.ts`), or a frame
   * they typed in did not answer. Every box and editable region of the tab is taken for one.
   */
  every: boolean;
  /** A document of this tab is one a person typed into, whether or not its nodes are in it now. */
  present: boolean;
  /** The mark a typed-into node carries, for everything that leaves such nodes out. */
  mark: string;
  /** The controls that could take a name from one, as this scan marked them. */
  near: {
    mark: string;
    tokens: string[];
    boxes: Set<string>;
    expected: number;
  };
  /** The boxes of the list that are such nodes: where each is drawn, and how many. */
  boxes: { mark: string; boxes: Set<string>; expected: number };
};

let scans = 0;

/** A token for one scan: the moment it is made, which is how its age is told in the page. */
export function scanToken(): string {
  scans += 1;
  return `${Date.now()}.${scans}`;
}

/**
 * What a person typed into this tab, for everything that must not draw on it: the names a look
 * lists (`page-names.ts`), the boxes it blanks (`typedIntoRefs`) and the page's text
 * (`page-text.ts`).
 *
 * WHAT A LOOK BLANKS BY REF IS THE BOX ITSELF, AND THE BOX IS NOT THE ONLY PLACE ITS CONTENTS ARE
 * SAID. The browser names the link around an editable region by the region's words, the button a
 * box labels by the box's value and the box beside a `<label>` by whatever the label holds; and an
 * editable region's text is the page's text. Measured 2026-10-05 (`person-typing.ts`): each of those
 * handed a person's typing to the Bot from a node this session was already following, or from one
 * it had chosen not to follow.
 *
 * ASKED OF THE DOCUMENT, NOT OF THE LIST OF FIELDS. Each frame a person typed in is asked where its
 * marked nodes are now ({@link scanTyped}), so a node a page took out while a look went by is
 * found again when it is put back, and one this session no longer follows still gives no control
 * its name. A frame whose document is gone answers that, and its fields are let go then: the only
 * time one is, apart from the limit.
 *
 * `token` is given by a look, which then asks the controls of its list whether they carry it; a
 * read gives none. `also` is the token of the same look's scan before this one ({@link bothScans}).
 *
 * `every` is the answer when the question cannot be settled: a person typed where the page would
 * not say (`blind`), or a frame they typed in did not answer in time. Then every box and editable
 * region of the tab is taken for one, and every name is the page's — which is what blind costs.
 */
export async function quietOn(
  session: BotSession,
  target: Page,
  blind: boolean,
  ms: number = SECRET_JOIN_TIMEOUT_MS,
  look: { token: string; also?: string } = { token: "" },
): Promise<TypedInto> {
  const wait = Math.max(1, Math.min(ms, SECRET_JOIN_TIMEOUT_MS));
  const source = `(() => { try { return (${scanTyped.toString()})(${JSON.stringify(`${TYPED_MARK}|${DOCUMENT_MARK}|${NEAR_MARK}|${look.token}|${look.also ?? ""}`)}); } catch (error) { return ${JSON.stringify(SCAN_THREW)}; } })()`;
  const frames = [...session.typedFrames].filter((frame) => {
    if (!frame.isDetached()) return frame.page() === target;
    forgetFrame(session, frame);
    return false;
  });
  const answers = await Promise.all(
    frames.map((frame) =>
      within(
        wait,
        frame.evaluate(source).catch(() => undefined),
      ),
    ),
  );
  const said: TypedInto = {
    every: blind,
    present: blind,
    mark: TYPED_MARK,
    near: {
      mark: NEAR_MARK,
      tokens: look.token ? [look.token] : [],
      boxes: new Set(),
      expected: 0,
    },
    boxes: { mark: TYPED_MARK, boxes: new Set(), expected: 0 },
  };
  answers.forEach((answer, index) => {
    const frame = frames[index] as Frame;
    if (answer === "gone") {
      forgetFrame(session, frame);
      return;
    }
    const [named, fresh, nearAt, boxes, boxesAt] =
      typeof answer === "string" ? answer.split("|") : [];
    said.present = true;
    if (boxesAt === undefined) {
      // Silent, failed, or thrown inside the page: where the typing is in this frame is not known.
      said.every = true;
      return;
    }
    // A field of an earlier document of this frame went with that document.
    forgetFrame(session, frame, named);
    said.near.expected += Number(fresh);
    for (const box of (nearAt ?? "").split(";")) {
      if (box) said.near.boxes.add(box);
    }
    said.boxes.expected += Number(boxes);
    for (const box of boxesAt.split(";")) if (box) said.boxes.boxes.add(box);
  });
  return said;
}

/**
 * One look's two scans as one answer: before its tree was taken, and after.
 *
 * THE TREE'S NAMES ARE A MOMENT'S, AND THE PAGE IS ASKED AT ANOTHER. Asked only afterwards — after
 * the late join and the search for typed-into boxes, a second or more on — a region a dialog took
 * with it as it closed, or a re-render moved, answered that nothing was near, and the name the tree
 * had read a moment earlier stood: `link "… <what a person typed>"`. So what is near is asked on
 * both sides of the tree and both answers count. A control that was near BEFORE the tree is one
 * whose tree name is not to be trusted whatever the page says of it afterwards (`before` in
 * `nearRefs`); the count of near controls is the first scan's and whatever the second found that
 * the first had not; and a box that was a typed-into box on either side is looked for.
 *
 * KNOWN AND LEFT: what is in the document only BETWEEN the two scans — put in after the first,
 * read by the tree, taken out before the second — is seen by neither. A region so, and a box so:
 * the boxes looked for are the larger of the two counts, which is every box either scan saw and
 * no box that neither did.
 */
export function bothScans(before: TypedInto, after: TypedInto): TypedInto {
  return {
    every: before.every || after.every,
    present: before.present || after.present,
    mark: after.mark,
    near: {
      mark: after.near.mark,
      tokens: [...before.near.tokens, ...after.near.tokens],
      boxes: new Set([...before.near.boxes, ...after.near.boxes]),
      expected: before.near.expected + after.near.expected,
    },
    boxes: {
      mark: after.boxes.mark,
      boxes: new Set([...before.boxes.boxes, ...after.boxes.boxes]),
      expected: Math.max(before.boxes.expected, after.boxes.expected),
    },
  };
}

/**
 * A document of this frame is gone, and what was typed into it with it: its fields are let go.
 * `now` is the document the frame holds instead, when that one was typed into as well.
 */
function forgetFrame(session: BotSession, frame: Frame, now?: string): void {
  if (now === undefined) session.typedFrames.delete(frame);
  for (const field of session.secretFields) {
    if (field.frame === frame && field.document !== now) letGo(session, field);
  }
}

/**
 * Let every followed field go, and everything known about what was typed: the tabs they lived in,
 * and every address that could carry it, are gone.
 */
export function forgetSecretFields(session: BotSession): void {
  for (const field of session.secretFields.splice(0)) {
    void field.handle.dispose().catch(() => undefined);
  }
  session.lastTyped = undefined;
  session.typedDigests = [];
  session.ownDigests = [];
  session.typedBlind = new WeakMap();
  session.typedFrames = new Set();
}
