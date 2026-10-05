/**
 * Turning Playwright's aria snapshot into the flat element list the tool contract publishes.
 *
 * Playwright's `mode: "ai"` output is YAML: each entry is a mapping whose key describes the element
 * and whose value is that control's contents. A YAML parser preserves quoted values, colons, escaped
 * quotes, multi-line values and deeper indentation.
 *
 * Parsed under the failsafe schema, which resolves every scalar as a string. What a control contains
 * is text, and nothing here wants it typed.
 *
 * What remains to parse by hand is one descriptor per element,
 * `textbox "Customer name:" [ref=e5] [checked]`, and that is scanned rather than matched, because the
 * parts can contain one another: an accessible name can hold a bracket and a flag can hold a quote.
 *
 * This module has no Playwright import, so parser tests do not need a browser.
 */

import { parse as parseYaml } from "yaml";
import { cutAtCodeUnits } from "../../shared/sound-text";

/** How many elements a snapshot will describe. Bounded for the same reason the text extract is. */
const SNAPSHOT_ELEMENT_LIMIT = 200;

/**
 * The roles worth handing to a Bot that wants to act.
 *
 * Role allow-list, not a CSS selector list. `mode: "ai"` returns the whole accessible tree, which on
 * a real page is mostly headings, paragraphs and generic containers. What a Bot needs in order to fill
 * in a form is the controls, and naming them by ARIA role is both shorter and more correct than
 * guessing at tag names: a `div[role=button]` is a button here, and Playwright has already worked out
 * which is which.
 */
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

/**
 * The roles a Bot acts on whose accessible name is the text inside them (WAI-ARIA's name from
 * content, the list Playwright's own `allowsNameFromContent` keeps). A control of one of these that
 * the tree printed without a name is one the page is asked to name, and one that says no `value`
 * (`leftNameless`).
 *
 * Not a textbox, searchbox, combobox or spinbutton: what sits under one of those in the tree is its
 * value, and a value never becomes a name. A password box's contents would otherwise ride out as its
 * label, and the server finds the box a person typed a secret into by its name
 * (`server/src/computer/gateway/secrets.ts`).
 */
const NAMED_FROM_CONTENT = new Set([
  "button",
  "checkbox",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "switch",
  "tab",
]);

/** The roles whose unchecked state is meaningful, so absence of `[checked]` means false, not unknown. */
const CHECKABLE_ROLES = new Set([
  "checkbox",
  "menuitemcheckbox",
  "menuitemradio",
  "radio",
  "switch",
]);

/**
 * One thing on the page a Bot can act on.
 *
 * Mirrors `SnapshotElement` in the server's published contract (`server/src/computer/schema.ts`), the
 * same way the workspace entry type does. Duplicated rather than shared because this process is a
 * separate deployable with no code in common with the server; the two must be changed together, and a
 * field added here and not there is invisible until a Bot asks for it.
 */
export type SnapshotElement = {
  ref: string;
  role: string;
  name: string;
  /** Present for form controls, so the Bot can tell an empty field from a filled one. */
  value?: string;
  /**
   * An input's type, where it is one the boundary has to be able to see.
   *
   * Only `"password"` is set today, and only because the boundary cannot do its job without it: a
   * Bot must never type a password into a page, and Playwright's accessible tree reports a password
   * box as an ordinary `textbox` — the ARIA role for one is textbox, and the snapshot's flags are
   * about state (`[checked]`, `[disabled]`), not about markup. The server's own contract has carried
   * an `element.type` field this whole time, the policy language advertises it, and nothing was ever
   * putting a value in it.
   */
  type?: string;
  disabled?: boolean;
  checked?: boolean;
};

/**
 * The roles a secret can be typed into, so the marking below does not go looking at buttons.
 *
 * `spinbutton` is `<input type="number">`, which is what a card's CVC or a six-digit code is on a
 * page that wants the numeric keyboard — a secret field by any other role.
 */
const TEXT_ENTRY_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
]);

/** Whether an element of this role is one a value can be typed into. */
export function isTextEntryRole(role: string): boolean {
  return TEXT_ENTRY_ROLES.has(role);
}

/**
 * What the caller read off the DOM about the page's secret fields, which the accessible tree does
 * not say.
 *
 * THE TREE REPORTS A PASSWORD BOX AS A `textbox` with a name and a value, and nothing else, so which
 * textboxes hold a secret has to be read off the DOM and joined back. The join used to be BY LABEL
 * ALONE, and a label is the one thing a page decides: `<input type="password"
 * aria-labelledby="패스워드">` reached the tree named 패스워드 while `HTMLInputElement.labels` —
 * blind to `aria-labelledby` — reported it unlabelled, the two never met, and the value a person had
 * just typed through `computer_request_secret` rode out on the next snapshot (measured 2026-09-10,
 * in the published container and in main).
 *
 * - `refs`: IDENTITY. The refs Playwright minted for the DOM's own secret inputs, and for the nodes a
 *   person typed a secret into — a ref names one element, whatever it is called.
 * - `values`: the current contents of those same inputs. A tree value equal to one IS that input's
 *   value, since the tree read it off the node; this is the net under a ref that could not be read.
 * - `labels`: the accessible names of the DOM's secret inputs, the join that used to be the rule.
 */
export type SecretSignals = {
  refs?: Iterable<string>;
  values?: Iterable<string>;
  labels?: Iterable<string>;
  /**
   * A field a person typed a secret into could not be looked for to the end in this tree
   * (`typedIntoRefs`), so no text-entry control's contents are shown: any of them could be it.
   */
  unverified?: boolean;
};

/**
 * A value as the tree renders it, so the DOM's copy and the tree's can be compared.
 *
 * Playwright collapses an input's value the way it collapses a name before it writes it into the
 * tree (measured: a textarea holding `"  multi\nline   value  "` arrives as `multi line value`), and
 * `toElement` below trims and cuts it. An exact comparison missed every secret with a space at
 * either end — which is the one a person is least likely to have noticed typing. The first 64
 * characters: past that, two different values that agree are not a risk anybody runs.
 */
export function comparableValue(value: string): string {
  return value
    .replace(/[\u200b\u00ad]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

/**
 * Labels that mean a field holds something the Bot must never be shown.
 *
 * THE SNAPSHOT USED TO HAND THE MODEL EVERY PASSWORD ON THE PAGE. Playwright's `mode: "ai"` tree
 * puts an input's current value into the node, password boxes included (measured:
 * `- textbox "비밀번호" [ref=e2]: hunter2!SuperSecret`), and `toElement` copied it onto the element
 * it was about to mark `type: "password"`. So `computer_request_secret` — whose whole promise is that
 * the person types the value and the model never sees it — was undone by the very next
 * `computer_snapshot`, which the tool results tell the Bot to take. The value went into the tool
 * result, from there into the thread, and from there into every later turn.
 *
 * The DOM's own secret inputs and the fields a person typed a secret into are the first signal
 * (`SecretSignals`, by identity), and this list is the last, for the fields nothing marks: a one-time
 * code is `type="text"` and a card number `type="tel"` on a page that sets no `autocomplete` token.
 * The same words the server's boundary refuses typing into (`default-policy.ts`), plus the codes
 * and numbers a person is asked for at a checkout. Over-matching costs the Bot the sight of a
 * field's contents; under-matching costs the person their secret.
 *
 * 패스워드 is here because it was not: the word Korean sites write in place of 비밀번호 was in
 * neither list, and the one page the auditor built used exactly that word. The word is not what
 * fixes that page — identity is — it is what keeps the last net from missing the commonest case.
 *
 * 승인번호, 인증코드, 주민등록번호 and PIN for the same reason (audit R3-01, 2026-09-16): a parser
 * dry-run kept all four boxes' values, and the audit's takeover reproduction typed into a box called
 * 승인번호. What fixes a takeover is following the box a person typed into (`person-typing.ts`);
 * these keep the last net from missing the boxes a Korean checkout and 본인인증 actually ask for.
 */
const SECRET_LABEL_WORDS = [
  "비밀번호",
  "비밀 번호",
  "패스워드",
  "패스 워드",
  "비번",
  "암호",
  "password",
  "passcode",
  "인증번호",
  "인증 번호",
  "일회용",
  "otp",
  "핀번호",
  "핀 번호",
  "카드번호",
  "카드 번호",
  "cvc",
  "cvv",
  "보안코드",
  "보안 코드",
  "승인번호",
  "승인 번호",
  "인증코드",
  "인증 코드",
  "주민등록번호",
  "주민등록 번호",
  "주민번호",
];

/**
 * Words that mean a secret only standing on their own. PIN is inside Shipping, Spinner and opinion,
 * so it matches with no letter on either side; a digit may sit beside it, because that is how a
 * PIN's length is written (PIN4, PIN 6자리), and so may Hangul (PIN번호) or an underscore (pin_code).
 */
const SECRET_LABEL_WHOLE_WORDS = ["pin"];

const escapedWord = (word: string): string =>
  word.replace(/[^\p{L}\p{N} ]/gu, (character) => `\\${character}`);

const SECRET_LABEL = new RegExp(
  [
    ...SECRET_LABEL_WORDS.map(escapedWord),
    ...SECRET_LABEL_WHOLE_WORDS.map(
      (word) => `(?<![a-z])${escapedWord(word)}(?![a-z])`,
    ),
  ].join("|"),
  "iu",
);

/** Whether a text-entry element's label says its contents are not the Bot's to see. */
export function isSecretLabel(name: string): boolean {
  return SECRET_LABEL.test(name);
}

/**
 * An iframe the snapshot could not see into, as Playwright writes one: its line, with no colon.
 *
 * Playwright snapshots each iframe's document on its own and splices it in under the iframe's line,
 * adding the colon only when that came back with something (`ariaSnapshotForFrame`, 1.62.1). A frame
 * it could not enter — detached while it looked, or one that never gave it a document, like a frame
 * the browser itself refused to load — is caught there and left as the bare line. An empty frame it
 * DID enter still gets its colon. Measured on 1.62.1 with a real Chromium: `<iframe
 * src="chrome://version">` and an iframe replaced every 20 ms came back bare; an X-Frame-Options
 * refusal, a CSP `frame-ancestors` refusal, a connection refused, a data: URL, a PDF and a page that
 * reloads itself every 30 ms all came back with the colon. An iframe whose request is accepted and
 * never answered comes back bare too, once the tree's timeout has run out on it (measured
 * 2026-09-14; `FRAME_WAIT_MS` in snapshot.ts is that timeout).
 *
 * Matched on the line rather than off the parsed tree, the way Playwright matches it, so a page past
 * the element limit is still counted to its last frame.
 */
const UNSEEN_IFRAME =
  /^[ \t]*- iframe(?: \[[^\]\n]*\])* \[ref=[^\]\n]+\](?: \[[^\]\n]*\])*$/gm;

/**
 * How many iframes on the page the snapshot could not see into.
 *
 * `laf:frame_opaque` on a read is a frame whose text would not come; this is the same fact for a
 * snapshot, and the number the audit row for a snapshot carries (`opaqueFrames`).
 */
export function opaqueFramesIn(yaml: string): number {
  return yaml.match(UNSEEN_IFRAME)?.length ?? 0;
}

/** The descriptor half of an entry: everything before the colon. */
type Descriptor = {
  role: string;
  name: string;
  flags: Map<string, string>;
};

/**
 * Read `textbox "Customer name:" [ref=e5] [checked]`.
 *
 * Scanned left to right rather than matched with a pattern, because the parts can contain each other:
 * an accessible name can contain a bracket, and a flag value can contain a quote. A single expression
 * that handles every page is not maintainable.
 */
export function parseDescriptor(text: string): Descriptor | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // The role runs up to the first space, quote or bracket.
  let index = 0;
  while (
    index < trimmed.length &&
    trimmed[index] !== " " &&
    trimmed[index] !== '"' &&
    trimmed[index] !== "["
  ) {
    index += 1;
  }
  const role = trimmed.slice(0, index);
  if (!role) return null;

  let name = "";
  const flags = new Map<string, string>();

  while (index < trimmed.length) {
    const char = trimmed[index];

    if (char === '"') {
      // The accessible name, consuming escapes so a name containing a quote survives intact.
      index += 1;
      let collected = "";
      while (index < trimmed.length && trimmed[index] !== '"') {
        if (trimmed[index] === "\\" && index + 1 < trimmed.length) {
          collected += trimmed[index + 1];
          index += 2;
          continue;
        }
        collected += trimmed[index];
        index += 1;
      }
      index += 1;
      name = collected;
      continue;
    }

    if (char === "[") {
      index += 1;
      let collected = "";
      while (index < trimmed.length && trimmed[index] !== "]") {
        collected += trimmed[index];
        index += 1;
      }
      index += 1;
      const equals = collected.indexOf("=");
      if (equals === -1) {
        flags.set(collected.trim(), "");
      } else {
        flags.set(
          collected.slice(0, equals).trim(),
          collected.slice(equals + 1).trim(),
        );
      }
      continue;
    }

    index += 1;
  }

  return { role, name, flags };
}

/**
 * Whether the tree printed this control without a name although its role is named by what is
 * inside it. One predicate for the two things it decides, so they cannot come apart: the page is
 * asked to name the control (`readAriaSnapshot`), and what the tree wrote after its colon is not
 * handed on as a `value` (`toElement`).
 */
function leftNameless(descriptor: Descriptor): boolean {
  return !descriptor.name && NAMED_FROM_CONTENT.has(descriptor.role);
}

/** Build an element from a descriptor and whatever YAML gave as its value, or null if not actionable. */
function toElement(
  descriptor: Descriptor,
  value: unknown,
): SnapshotElement | null {
  if (!INTERACTIVE_ROLES.has(descriptor.role)) return null;

  const ref = descriptor.flags.get("ref");
  // No ref means nothing can be done to it, so it is noise in a list whose entire purpose is acting.
  if (!ref) return null;

  const element: SnapshotElement = {
    ref,
    role: descriptor.role,
    // The name the tree printed, or none: this list never makes one up (`readAriaSnapshot`).
    // Between characters: the name goes into the trail's row before the action it names
    // (`shared/sound-text.ts`).
    name: cutAtCodeUnits(descriptor.name, 200),
  };

  /*
   * Values arrive as text, with quoting and escapes already resolved.
   *
   * NEVER FOR A CONTROL NAMED BY ITS CONTENTS THAT THE TREE LEFT NAMELESS. What is written after
   * the colon of such a link or button is what is inside it — the words the page is about to be
   * asked for as its name, and, where what is inside can be edited, what a person typed there.
   * Handed on as a `value` they would reach the model and the trail beside whatever name the page
   * gave, the one it leaves every field and editable region out of (`page-names.ts`) — or beside
   * no name at all.
   *
   * This held only as a side effect until 2026-10-05: those words were the control's name here
   * (`nameFromWithin`, pull request 65), and "text that became the name is not said a second time"
   * was the rule. The name went — the look had replaced it on every such control since 572a3eab —
   * and with the old condition left standing the contents came straight back as a `value` (seen in
   * this parser's tests: `- button [ref=e1]: 다음` read `value: "다음"`). So the rule is its own,
   * and says what it is about. A control the tree named keeps what is written after it, and so
   * does a field.
   *
   * The shape is rare. Playwright drops a single run of text that is the control's own name,
   * printed or not — a button whose words run past 900 characters is `button [ref=e30]` and
   * nothing after it (measured 2026-10-05) — so text after a nameless control's colon takes a
   * name it did not print and text that differs from that name: none of the 48 real pages' trees
   * read that day had one. Unguarded, the one that does puts what is inside the control into a
   * tool result.
   */
  if (typeof value === "string" && !leftNameless(descriptor)) {
    const text = value.trim();
    if (text) element.value = cutAtCodeUnits(text, 200);
  }

  if (descriptor.flags.has("disabled")) element.disabled = true;

  // Playwright emits `[checked]` only when something is checked, so absence is ambiguous on its own: a
  // Bot cannot tell an unticked box from a control that does not tick. Reported as false for the roles
  // that can be checked, and left off entirely for the ones that cannot.
  //
  // `[checked=mixed]` is the third state, and the one spelling Playwright gives this flag a value
  // for: the box above a partly-ticked list. It is not ticked. Read as ticked — which anything but
  // the word "false" used to be — a Bot asked to choose everything saw "전체 선택" already done,
  // clicked nothing, and reported rows chosen that were not. The contract is yes or no, so "partly"
  // is no: which is also the answer that gets the right action, since clicking it ticks it.
  // (Upstream OpenBot #475.)
  if (descriptor.flags.has("checked")) {
    const state = descriptor.flags.get("checked");
    element.checked = state !== "mixed" && state !== "false";
  } else if (CHECKABLE_ROLES.has(descriptor.role)) {
    element.checked = false;
  }

  return element;
}

/** The page's viewport, in CSS pixels. */
export type Viewport = { width: number; height: number };

/** A rectangle in the page's viewport, in CSS pixels. */
type Rect = { left: number; top: number; right: number; bottom: number };

/**
 * Where the document being read sits in the page's viewport, and the part of it a person can see:
 * the viewport itself for the page, narrowed by each frame a document is inside.
 */
type View = { originX: number; originY: number; clip: Rect };

/**
 * An entry's `[box=x,y,width,height]`, placed in the page's viewport.
 *
 * Playwright measures each box with `getBoundingClientRect` in the entry's own document, so a box
 * inside a frame starts from the frame's corner, not the page's (`ariaSnapshotForFrame` asks every
 * frame for boxes with the same options).
 */
function boxOf(descriptor: Descriptor, view: View): Rect | null {
  const written = descriptor.flags.get("box")?.split(",").map(Number);
  if (written?.length !== 4 || !written.every(Number.isFinite)) return null;
  const [x = 0, y = 0, width = 0, height = 0] = written;
  return {
    left: view.originX + x,
    top: view.originY + y,
    right: view.originX + x + width,
    bottom: view.originY + y + height,
  };
}

/** What two rectangles share, or null when that is nothing — an empty box included. */
function overlap(a: Rect, b: Rect): Rect | null {
  const shared = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return shared.left < shared.right && shared.top < shared.bottom
    ? shared
    : null;
}

/** The view inside a frame: from its corner, and only as much of it as shows. Null when none does. */
function frameView(box: Rect | null, view: View | null): View | null {
  if (!box || !view) return null;
  const clip = overlap(box, view.clip);
  return clip ? { originX: box.left, originY: box.top, clip } : null;
}

/**
 * Turn an aria snapshot into the flat element list the tool contract publishes.
 *
 * `secrets` is what the caller read off the DOM about the page's secret fields, because the
 * accessible tree does not carry the type — see {@link SecretSignals} for the three joins and why
 * the label alone was not enough. Whatever a signal matches is marked `type: "password"` and loses
 * its value; a field's own label (`isSecretLabel`) drops the value on its own as well. Over-marking
 * costs a Bot the use of a text field it should have been asking a person to fill anyway.
 *
 * `viewport` is the page's, for a tree taken with `boxes: true`: past the limit, what is on the
 * screen is kept first (`keptOf`). Without one, or without boxes, the cut is in page order.
 *
 * This is the tree's list and no more: a control the tree printed without a name has none here.
 * The list a Bot is shown is the look's (`readAriaSnapshot`, then `withNames`).
 */
export function parseAriaSnapshot(
  yaml: string,
  secrets: SecretSignals = {},
  viewport?: Viewport,
): {
  elements: SnapshotElement[];
  truncated: boolean;
} {
  const { elements, truncated } = readAriaSnapshot(yaml, secrets, viewport);
  return { elements, truncated };
}

/**
 * {@link parseAriaSnapshot}, and the refs of the kept controls the tree printed without a name
 * although their role is named by what is inside them (`leftNameless`) — the ones whose name the
 * page is asked for (`page-names.ts`). Here they have no name, and no value; the look gives each
 * the page's name or, where the page did not give one in time, leaves it with none (`withNames`).
 *
 * THE TREE BLANKS A NAME THAT IS SPELLED OUT BENEATH IT. Playwright 1.62's AI snapshot drops the
 * name of a node whose name came from children it also prints, each with a ref of its own
 * (`removeRedundantNames`), so a link whose headline sits in a `<strong>` is written
 * `link [ref=e137]:` with the headline under it — and the model read `e137 link`, nothing more. The
 * browser still calls that link by its headline, and the label hold asks the browser
 * (`label-hold.ts`): a click held to the empty name the list had given was refused as a rename.
 * Measured 2026-10-04 on five Korean pages (Naver home, news and search, Daum, 4insure): 190 links
 * were blank for this reason and the hold refused all 190.
 *
 * THE NAME IS NOT GUESSED HERE. For a day it was — the words the tree printed beneath the control,
 * joined with one space (`nameFromWithin`, pull request 65), which held 186 of those 190. The
 * tree does not say what a name needs: which neighbours were inline, and the browser joins those
 * with no space (`<b>A</b><i>B</i>` is named "AB") — 16 of 59 links on a Naver search page were
 * "무선 마우스" here and "무선마우스" to the browser; whether a decoration is hidden from the
 * accessibility tree, which it prints like any other text (`<span aria-hidden="true">★</span>` is
 * `- text: ★`, under a link the browser names "Headline"); that a table is named by its caption;
 * or that a run of text can be edited, so that what a person typed into it would be the name of
 * the link around it (`withNames`). With the page's names the same five pages held every control
 * not hidden from the accessibility tree, exactly (203 of 203, measured 2026-10-04), and since
 * 572a3eab the look replaced the guess on every control it was made for — computed, then thrown
 * away. It was deleted on 2026-10-05; the list the look hands on was the same before and after on
 * those five pages, control for control, with the page answering and with it silent (831 of 831).
 */
export function readAriaSnapshot(
  yaml: string,
  secrets: SecretSignals = {},
  viewport?: Viewport,
): {
  elements: SnapshotElement[];
  truncated: boolean;
  unnamed: string[];
  /**
   * Where each kept control is drawn in its own document, as the tree wrote it (`[box=…]`), for a
   * tree taken with boxes: how a control is matched to an element the page counted
   * (`marked-refs.ts`).
   */
  boxes: Map<string, string>;
} {
  const secretLabels = new Set(
    [...(secrets.labels ?? [])]
      .map((label) => label.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
  const secretRefs = new Set(secrets.refs ?? []);
  // Empty is not a value: an empty box must not match an empty password box and be marked with it.
  const secretValues = new Set(
    [...(secrets.values ?? [])].map(comparableValue).filter(Boolean),
  );
  const found: Found[] = [];

  const push = (
    element: SnapshotElement,
    seen: boolean,
    unnamed: boolean,
    box: string | undefined,
  ): void => {
    if (TEXT_ENTRY_ROLES.has(element.role)) {
      const label = element.name.replace(/\s+/g, " ").trim();
      if (
        secretRefs.has(element.ref) ||
        secretLabels.has(label) ||
        (element.value !== undefined &&
          secretValues.has(comparableValue(element.value)))
      ) {
        element.type = "password";
      }
      /*
       * THE VALUE OF A SECRET FIELD IS NOT THE BOT'S TO SEE, whether the page marked the box a
       * password or only labelled it one. What the Bot needs from a secret field is that it exists
       * and whether it is empty; the string in it is exactly what `computer_request_secret` exists
       * to keep out of the model. Dropped here, at the one place a value enters the element, so no
       * later reader has to remember to.
       */
      if (
        element.type === "password" ||
        isSecretLabel(label) ||
        secrets.unverified
      ) {
        if (element.value !== undefined) element.value = "";
      }
    }
    found.push({ element, seen, unnamed, ...(box ? { box } : {}) });
  };

  let tree: unknown;
  try {
    tree = parseYaml(yaml, { schema: "failsafe" });
  } catch {
    // A snapshot that will not parse yields no elements rather than throwing. The caller's next move is
    // to take another one, and an exception here would reach the Bot as a broken computer.
    return { elements: [], truncated: false, unnamed: [], boxes: new Map() };
  }

  /** One entry: an element if it is one, and then whatever is beneath it. */
  const take = (key: string, value: unknown, view: View | null): void => {
    const descriptor = parseDescriptor(key);
    const box = descriptor && view ? boxOf(descriptor, view) : null;
    const element = descriptor ? toElement(descriptor, value) : null;
    if (element && descriptor) {
      push(
        element,
        Boolean(box && view && overlap(box, view.clip)),
        leftNameless(descriptor),
        descriptor.flags.get("box"),
      );
    }
    // Descend regardless of whether this entry was actionable: a `group "Pizza Size"` is not, and
    // its radios are. A frame's document measures its boxes from the frame's own corner.
    if (value && typeof value === "object") {
      walk(value, descriptor?.role === "iframe" ? frameView(box, view) : view);
    }
  };

  /** Depth first: the tree nests by containment, and a flat list is what a Bot acts on. */
  const walk = (node: unknown, view: View | null): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, view);
      return;
    }

    if (typeof node === "string") {
      // An entry with no value: `- button "Submit order" [ref=e44]`.
      take(node, undefined, view);
      return;
    }

    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) take(key, value, view);
    }
  };

  walk(
    tree,
    viewport
      ? {
          originX: 0,
          originY: 0,
          clip: {
            left: 0,
            top: 0,
            right: viewport.width,
            bottom: viewport.height,
          },
        }
      : null,
  );
  const { kept, truncated } = keptOf(found);
  return {
    elements: kept.map(({ element }) => element),
    truncated,
    unnamed: kept.flatMap(({ element, unnamed }) =>
      unnamed ? [element.ref] : [],
    ),
    boxes: new Map(
      kept.flatMap(({ element, box }) => (box ? [[element.ref, box]] : [])),
    ),
  };
}

/**
 * The list with the page's own names on the controls whose name is the page's to give
 * (`namesFromThePage`), cut where every name is cut.
 *
 * A CONTROL THE PAGE DID NOT ANSWER FOR IS LEFT WITHOUT A NAME, and nothing stands in for it. The
 * words the tree printed beneath the control once did (`readAriaSnapshot` says what became of
 * them), and they cannot tell an editable region from ordinary text — Playwright prints a plain
 * `contenteditable` as `generic` with no mark (`person-typing.ts` measured it, 2026-09-16) — so a
 * nameless link wrapping one would have carried whatever had been typed into it as its name, to
 * the model and the trail (review of pull request 69). When the page's own name comes, it leaves
 * editable regions out on every path (`page-names.ts`); when it does not come in time, or the ref
 * did not resolve, the honest list has no name for that control — the hold then compares the
 * empty name with the browser's, which is a refusal and never a secret on the trail. A control
 * the tree itself named, and that is not in `asked`, is untouched.
 *
 * `asked` is every control whose name is not the tree's to give: the ones it left nameless, and —
 * on a tab a person typed into — the ones it named out of what they typed, or might have
 * (`namesToList`). It is the look's own statement of the rule and holds whatever list it is
 * handed: a name already on one of these does not go on unless `names` gives it.
 *
 * `valueless` is every control whose contents are not the Bot's to read: one that holds a node a
 * person typed into — is one, is inside one, has one inside it — or that could not be asked. What
 * the tree writes after such a control's colon is what is inside it (`toElement`):
 * `- button "보내기" [ref=e9]: <what a person typed in the region inside it>`, and just as much
 * `- combobox "검색" [ref=e4]: 검색: <what they typed>` for a box that is a wrapper around the
 * region. So it goes whatever the control's role, where until 2026-10-05 a box kept it: the box a
 * person typed into is blanked by ref, and the box AROUND it was not a box anybody followed. A box
 * is left saying that it holds something (`""`), as a secret field is; anything else says nothing.
 */
export function withNames(
  elements: SnapshotElement[],
  names: ReadonlyMap<string, string>,
  asked: ReadonlySet<string> = new Set(names.keys()),
  valueless: ReadonlySet<string> = new Set(),
): SnapshotElement[] {
  return elements.map((element) => {
    const name = names.get(element.ref);
    const renamed = name !== undefined || asked.has(element.ref);
    const emptied = valueless.has(element.ref) && element.value !== undefined;
    if (!renamed && !emptied) return element;
    const { value, ...rest } = element;
    return {
      ...rest,
      ...(renamed
        ? { name: name === undefined ? "" : cutAtCodeUnits(name, 200) }
        : {}),
      ...(!emptied
        ? value === undefined
          ? {}
          : { value }
        : TEXT_ENTRY_ROLES.has(element.role)
          ? { value: "" }
          : {}),
    };
  });
}

/**
 * What the page said of the controls it was asked about, as {@link withNames} takes it: the names
 * that go on the list, every control whose tree name does not stand, and every control whose
 * contents do not go on.
 *
 * A control the tree left nameless takes the page's name, as it always did. A control the tree
 * NAMED is asked about only where it could be named out of what a person typed (`snapshotPage`),
 * and then:
 *
 * - drawn from what they typed (`drawn`): the page's name, which leaves that out — the link around
 *   an editable region, the button a box labels, the box whose `<label>` holds a region, the link
 *   inside a region (`page-names.ts`);
 * - holding what they typed (`holds`): no contents either;
 * - not drawn from it: the tree's own name, untouched — the page's answer for it is not used, so
 *   nothing about an ordinary control changes because somebody typed elsewhere on the page;
 * - not answered for: no name and no contents. Whether it was drawn from what they typed is
 *   exactly what is not known, and this is the side to be wrong on: it costs the Bot one look's
 *   name for that control.
 *
 * `nearBefore` is the controls that were near a node a person typed into BEFORE the tree was taken
 * (`nearRefs`). The tree read their names a moment later, and the page is asked a moment after
 * that: a region that left in between is in the tree's name and in nothing the page can say now.
 * So such a control never keeps the tree's name or its contents, whatever the page answers: it is
 * listed under what the page calls it now, which the region is no part of.
 */
export function namesToList(
  unnamed: readonly string[],
  asked: readonly string[],
  answers: {
    names: ReadonlyMap<string, string>;
    drawn: ReadonlySet<string>;
    holds: ReadonlySet<string>;
  },
  nearBefore: ReadonlySet<string> = new Set(),
): { names: Map<string, string>; asked: Set<string>; valueless: Set<string> } {
  const nameless = new Set(unnamed);
  const names = new Map<string, string>();
  const notTheTrees = new Set(unnamed);
  const valueless = new Set<string>();
  for (const ref of asked) {
    const name = answers.names.get(ref);
    if (name === undefined) {
      notTheTrees.add(ref);
      valueless.add(ref);
      continue;
    }
    const distrusted = nearBefore.has(ref);
    if (answers.holds.has(ref) || distrusted) valueless.add(ref);
    if (nameless.has(ref) || answers.drawn.has(ref) || distrusted) {
      names.set(ref, name);
      notTheTrees.add(ref);
    }
  }
  return { names, asked: notTheTrees, valueless };
}

/**
 * An element, whether any of it was inside the viewport when the tree was taken, and whether the
 * tree printed it without a name.
 */
type Found = {
  element: SnapshotElement;
  seen: boolean;
  unnamed: boolean;
  /** Its `[box=…]` as written, in its own document's coordinates. */
  box?: string;
};

/**
 * The elements the list keeps: all of them, or — past the limit — every one a person could see,
 * then the rest, in page order within each and handed back in page order.
 *
 * THE CUT USED TO BE THE FIRST 200 IN PAGE ORDER, so a page whose header and menus run long lost
 * what was on the screen and kept its footer. Measured 2026-10-04, frames placed by their frame:
 * Daum lost 16 of the 69 controls on its screen, Naver search 11 of 61, Naver news 9 of 98, while
 * links far below the fold stayed in; kept screen first, none of the 36 was lost. What the person
 * is looking at is what a Bot is most often asked about.
 *
 * Handed back in page order rather than seen-first, because the list is read as the page, top to
 * bottom (`server/src/computer/snapshot-lines.ts`).
 */
function keptOf(found: Found[]): { kept: Found[]; truncated: boolean } {
  if (found.length <= SNAPSHOT_ELEMENT_LIMIT) {
    return { kept: found, truncated: false };
  }
  const seen = found.filter((entry) => entry.seen).length;
  let roomForSeen = Math.min(seen, SNAPSHOT_ELEMENT_LIMIT);
  let roomForRest = SNAPSHOT_ELEMENT_LIMIT - roomForSeen;
  const kept = found.filter((entry) => {
    if (entry.seen) return roomForSeen-- > 0;
    return roomForRest-- > 0;
  });
  return { kept, truncated: true };
}
