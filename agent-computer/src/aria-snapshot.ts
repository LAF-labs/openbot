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

/** The roles a password box can arrive as, so the marking below does not go looking at buttons. */
const TEXT_ENTRY_ROLES = new Set(["textbox", "searchbox", "combobox"]);

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
 * The DOM's own password inputs are the first signal (`passwordLabels`), and this list is the
 * second, for the fields the DOM cannot mark: a one-time code is `type="text"`, a card number is
 * `type="tel"`, and a password box inside a payment iframe is not in the caller's query at all.
 * The same words the server's boundary refuses typing into (`default-policy.ts`), plus the codes
 * and numbers a person is asked for at a checkout. Over-matching costs the Bot the sight of a
 * field's contents; under-matching costs the person their secret.
 */
const SECRET_LABEL_WORDS = [
  "비밀번호",
  "비밀 번호",
  "암호",
  "password",
  "passcode",
  "인증번호",
  "인증 번호",
  "일회용",
  "otp",
  "카드번호",
  "카드 번호",
  "cvc",
  "cvv",
  "보안코드",
  "보안 코드",
];

const SECRET_LABEL = new RegExp(
  SECRET_LABEL_WORDS.map((word) =>
    word.replace(/[^\p{L}\p{N} ]/gu, (character) => `\\${character}`),
  ).join("|"),
  "iu",
);

/** Whether a text-entry element's label says its contents are not the Bot's to see. */
export function isSecretLabel(name: string): boolean {
  return SECRET_LABEL.test(name);
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
    name: descriptor.name.slice(0, 200),
  };

  // Values arrive as text, with quoting and escapes already resolved.
  if (typeof value === "string") {
    const text = value.trim();
    if (text) element.value = text.slice(0, 200);
  }

  if (descriptor.flags.has("disabled")) element.disabled = true;

  // Playwright emits `[checked]` only when something is checked, so absence is ambiguous on its own: a
  // Bot cannot tell an unticked box from a control that does not tick. Reported as false for the roles
  // that can be checked, and left off entirely for the ones that cannot.
  if (descriptor.flags.has("checked")) {
    element.checked = descriptor.flags.get("checked") !== "false";
  } else if (CHECKABLE_ROLES.has(descriptor.role)) {
    element.checked = false;
  }

  return element;
}

/**
 * Turn an aria snapshot into the flat element list the tool contract publishes.
 *
 * `passwordLabels` are the accessible names of the page's own password inputs, read from the DOM by
 * the caller because the accessible tree does not carry the type. Matching by label is the join
 * available: the tree gives a name and a ref, the DOM gives a type and a name, and the name is what
 * both have. It is not exact — two fields can share a label, and a password box inside an iframe is
 * not in the caller's query at all — so it is one of two signals the boundary uses, beside the
 * field's own label (`default-policy.ts`). Over-marking costs a Bot the use of a text field it
 * should have been asking a person to fill anyway.
 */
export function parseAriaSnapshot(
  yaml: string,
  passwordLabels: readonly string[] = [],
): {
  elements: SnapshotElement[];
  truncated: boolean;
} {
  const secret = new Set(
    passwordLabels
      .map((label) => label.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
  const elements: SnapshotElement[] = [];
  let truncated = false;

  const push = (element: SnapshotElement): void => {
    if (elements.length >= SNAPSHOT_ELEMENT_LIMIT) {
      truncated = true;
      return;
    }
    if (TEXT_ENTRY_ROLES.has(element.role)) {
      const label = element.name.replace(/\s+/g, " ").trim();
      if (secret.has(label)) element.type = "password";
      /*
       * THE VALUE OF A SECRET FIELD IS NOT THE BOT'S TO SEE, whether the page marked the box a
       * password or only labelled it one. What the Bot needs from a secret field is that it exists
       * and whether it is empty; the string in it is exactly what `computer_request_secret` exists
       * to keep out of the model. Dropped here, at the one place a value enters the element, so no
       * later reader has to remember to.
       */
      if (element.type === "password" || isSecretLabel(label)) {
        if (element.value !== undefined) element.value = "";
      }
    }
    elements.push(element);
  };

  let tree: unknown;
  try {
    tree = parseYaml(yaml, { schema: "failsafe" });
  } catch {
    // A snapshot that will not parse yields no elements rather than throwing. The caller's next move is
    // to take another one, and an exception here would reach the Bot as a broken computer.
    return { elements: [], truncated: false };
  }

  /** Depth first: the tree nests by containment, and a flat list is what a Bot acts on. */
  const walk = (node: unknown): void => {
    if (truncated) return;

    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }

    if (typeof node === "string") {
      // An entry with no value: `- button "Submit order" [ref=e44]`.
      const descriptor = parseDescriptor(node);
      const element = descriptor ? toElement(descriptor, undefined) : null;
      if (element) push(element);
      return;
    }

    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        const descriptor = parseDescriptor(key);
        const element = descriptor ? toElement(descriptor, value) : null;
        if (element) push(element);
        // Descend regardless of whether this entry was actionable: a `group "Pizza Size"` is not, and
        // its radios are.
        if (value && typeof value === "object") walk(value);
      }
    }
  };

  walk(tree);
  return { elements, truncated };
}
