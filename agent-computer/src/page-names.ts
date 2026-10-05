/**
 * The name the browser gives a control the tree printed without one, computed in the page.
 *
 * THE TREE BLANKS A NAME THAT IS SPELLED OUT BENEATH IT (`removeRedundantNames`, Playwright 1.62), and
 * the label hold asks the role engine what the control is called (`label-hold.ts`). The list used to
 * guess that name from the words the tree printed beneath the control (pull request 65; the guess
 * was deleted on 2026-10-05, and `readAriaSnapshot` in aria-snapshot.ts keeps its record), and the
 * guess was wrong wherever the tree prints what the name leaves out or spaces what the name runs
 * together: an `aria-hidden` ★ before a headline, a `<mark>` inside a word, a table read whole
 * where the name is its caption, words only a screen reader is given. Each was a click refused as
 * `laf:label_changed`, and the spaces the guess put in made the policy and the high-risk reading
 * judge every name in two spellings.
 *
 * So the name is computed here, from the DOM, by the same steps the role engine takes — Playwright
 * 1.62.1's `getTextAlternativeInternal` (packages/injected/src/roleUtils.ts, Apache-2.0), followed
 * branch for branch so that what the list says is what the hold will find: `aria-labelledby`, then
 * `aria-label`, then what the markup names natively (an image's alt, a table's caption, a submit
 * button's value), then the contents — skipping what is hidden from the accessibility tree, joining
 * inline neighbours with nothing and anything else with a space, `::before` and `::after` included —
 * and last a `title`. The browser's own answer per element is not to be had: a default-mode
 * `ariaSnapshot()` on `aria-ref=eN` gives it and leaves the refs after it unresolvable (measured
 * 2026-09-13 and 2026-10-04), and Playwright's own name function lives in a world a page script
 * cannot reach.
 *
 * ONE PLACE IT DEPARTS FROM THE BROWSER, ON PURPOSE: A FIELD'S CONTENTS ARE NOBODY'S NAME. The browser
 * names a button that wraps a search box by what was typed into the box, and a control labelled by a
 * text field by that field's value. Here a text field, a select, a spinbutton or a slider says nothing
 * at all, wherever it is met — so a password a person typed never rides out as a label. Where that
 * makes the name differ from the browser's, the hold refuses the click as renamed; a refusal, never a
 * secret on the trail.
 *
 * AND WHAT A PERSON TYPED IS IN NO NAME AT ALL, WHOEVER PRINTED IT. The tree is not asked to leave
 * anything out, and it names a link by the words of the editable region inside it, a button by the
 * box that labels it, and a link inside a region by what was typed around it — each with a name of
 * its own, so none of them was ever asked about here (measured 2026-10-05, `person-typing.ts`).
 * While a tab holds a node a person typed into, every control the list keeps is asked about, the
 * routine says which of them take their name from such a node (`drawn`), and those are listed
 * under the name computed here: the node's own contents left out, and the text inside a region a
 * person typed into said by nothing — not even by a control that is itself inside it. The nodes
 * are known by the mark they carry in the page (`Hush`, `quietOn` in secret-fields.ts), as the
 * reader knows them: no frame has to be matched to a ref, and nothing has to be handed in.
 */
import type { Page } from "playwright";
import { fromDocument } from "./page-arrival";
import type { Hush } from "./reader";

/**
 * How long the names of one look may take. Measured 2026-10-04 on five Korean pages: tens of
 * milliseconds. A look that runs out leaves the controls it asked about with no name: nothing
 * stands in for the page's (`withNames` in aria-snapshot.ts says why).
 */
export const PAGE_NAMES_MS = 1_000;

/**
 * Each element's accessible name, or null where it could not be computed. Runs in the page, called
 * on the first of them (`ElementHandle.evaluate` runs on one element and hands the rest over).
 *
 * Each name is led by one character: `1` when the control takes its name from a node a person typed
 * into — it is an editable one, is inside one, holds one, or is labelled by one — and `0` when it
 * does not. In the string, so that the answer stays the array of strings it was.
 *
 * ASKED TWO WAYS, BECAUSE A PAGE CAN BREAK THE FIRST. All at once, the elements arrive as a list,
 * and Playwright carries a list into the page with the page's own `Map`: on one that replaces it
 * (고용24, `reader.ts`) the question throws before a line of this runs, and until 2026-10-05 no
 * name ever came back from such a page. So it is also asked of one element — the first argument —
 * with everything else it needs in a string, `0` or `1` for `every` and then the mark, and
 * answered with a string, which such a page leaves alone. And nothing here keeps anything in a
 * `Map` of its own for the same reason.
 *
 * Self-contained, because Playwright sends it to the page as source: nothing from this module's scope
 * is there when it runs.
 */
export function namesOf(
  first: Element,
  asked: { elements: Element[]; mark: string; every: boolean } | string,
): (string | null)[] | string | null {
  const alone = typeof asked === "string";
  const elements = alone ? [first] : asked.elements;
  const every = alone ? asked.charAt(0) === "1" : asked.every;
  const markName = alone ? asked.slice(1) : asked.mark;
  type Embedded = { element: Element; hidden: boolean };
  type Options = {
    visited: Set<Element>;
    /**
     * A control hidden from the accessibility tree is named as the hold's second question names it
     * (`includeHidden`), so a click on it is refused as hidden rather than as renamed.
     */
    includeHidden: boolean;
    /** `"self"` for the control being named, `"descendant"` beneath it. */
    within?: "self" | "descendant";
    labelledBy?: Embedded;
    label?: Embedded;
    native?: Embedded;
  };

  const VALID_ROLES = new Set(
    "alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main mark marquee math meter menu menubar menuitem menuitemcheckbox menuitemradio navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem".split(
      " ",
    ),
  );
  /** The roles whose name is always their contents. */
  const FROM_CONTENT = new Set(
    "button cell checkbox columnheader gridcell heading link menuitem menuitemcheckbox menuitemradio option radio row rowheader switch tab tooltip treeitem".split(
      " ",
    ),
  );
  /** And the roles that give their contents to a name only beneath the control being named. */
  const FROM_CONTENT_BENEATH = new Set(
    " caption code contentinfo definition deletion emphasis insertion list listitem mark none paragraph presentation region row rowgroup section strong subscript superscript table term time".split(
      " ",
    ),
  );
  /** What a field holds, by role: never part of anybody's name (see the module comment). */
  const HOLDS_A_VALUE = new Set([
    "textbox",
    "searchbox",
    "combobox",
    "listbox",
    "spinbutton",
    "slider",
  ]);
  const LANDMARK_ANCESTOR =
    "article:not([role]), aside:not([role]), main:not([role]), nav:not([role]), section:not([role]), [role=article], [role=complementary], [role=main], [role=navigation], [role=region]";
  const GLOBAL_ARIA: [string, string[] | undefined][] = [
    ["aria-atomic", undefined],
    ["aria-busy", undefined],
    ["aria-controls", undefined],
    ["aria-current", undefined],
    ["aria-describedby", undefined],
    ["aria-details", undefined],
    ["aria-dropeffect", undefined],
    ["aria-flowto", undefined],
    ["aria-grabbed", undefined],
    ["aria-hidden", undefined],
    ["aria-keyshortcuts", undefined],
    [
      "aria-label",
      "caption code deletion emphasis generic insertion paragraph presentation strong subscript superscript".split(
        " ",
      ),
    ],
    [
      "aria-labelledby",
      "caption code deletion emphasis generic insertion paragraph presentation strong subscript superscript".split(
        " ",
      ),
    ],
    ["aria-live", undefined],
    ["aria-owns", undefined],
    ["aria-relevant", undefined],
    ["aria-roledescription", ["generic"]],
  ];

  // Kept by element, in `WeakMap`s: a page that replaces `Map` has not replaced these (see above).
  const styles = {
    "": new WeakMap<Element, { style: CSSStyleDeclaration | undefined }>(),
    "::before": new WeakMap<
      Element,
      { style: CSSStyleDeclaration | undefined }
    >(),
    "::after": new WeakMap<
      Element,
      { style: CSSStyleDeclaration | undefined }
    >(),
  };
  const styleOf = (
    element: Element,
    pseudo?: "::before" | "::after",
  ): CSSStyleDeclaration | undefined => {
    const cache = styles[pseudo ?? ""];
    const known = cache.get(element);
    if (known) return known.style;
    const view = element.ownerDocument?.defaultView;
    const style = view ? view.getComputedStyle(element, pseudo) : undefined;
    cache.set(element, { style });
    return style;
  };
  const tagOf = (element: Element): string =>
    typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  const parentOf = (element: Element): Element | undefined => {
    if (element.parentElement) return element.parentElement;
    const parent = element.parentNode;
    if (parent && parent.nodeType === 11 && (parent as ShadowRoot).host) {
      return (parent as ShadowRoot).host;
    }
    return undefined;
  };
  const idRefs = (element: Element, ref: string | null): Element[] => {
    if (!ref) return [];
    let root: Node = element;
    while (root.parentNode) root = root.parentNode;
    if (root.nodeType !== 11 && root.nodeType !== 9) return [];
    const found: Element[] = [];
    try {
      for (const id of ref.split(" ").filter(Boolean)) {
        const match = (root as Document | ShadowRoot).querySelector(
          `#${CSS.escape(id)}`,
        );
        if (match && !found.includes(match)) found.push(match);
      }
    } catch {
      return [];
    }
    return found;
  };

  const explicitRole = (element: Element): string | null =>
    (element.getAttribute("role") ?? "")
      .split(" ")
      .map((role) => role.trim())
      .find((role) => VALID_ROLES.has(role)) ?? null;
  const hasGlobalAria = (element: Element, role: string | null): boolean =>
    GLOBAL_ARIA.some(
      ([attribute, prohibited]) =>
        !prohibited?.includes(role ?? "") && element.hasAttribute(attribute),
    );
  const hasTabIndex = (element: Element): boolean =>
    !Number.isNaN(Number(String(element.getAttribute("tabindex"))));
  const isFocusable = (element: Element): boolean => {
    if ((element as HTMLButtonElement).disabled === true) return false;
    const tag = tagOf(element);
    const natively = ["BUTTON", "DETAILS", "SELECT", "TEXTAREA"].includes(tag)
      ? true
      : tag === "A" || tag === "AREA"
        ? element.hasAttribute("href")
        : tag === "INPUT" && !(element as HTMLInputElement).hidden;
    return natively || hasTabIndex(element);
  };
  const implicitRole = (element: Element): string | null => {
    const tag = tagOf(element);
    switch (tag) {
      case "A":
      case "AREA":
        return element.hasAttribute("href") ? "link" : null;
      case "ARTICLE":
        return "article";
      case "ASIDE":
        return "complementary";
      case "BLOCKQUOTE":
        return "blockquote";
      case "BUTTON":
        return "button";
      case "CAPTION":
        return "caption";
      case "CODE":
        return "code";
      case "DATALIST":
        return "listbox";
      case "DD":
        return "definition";
      case "DEL":
        return "deletion";
      case "DETAILS":
      case "FIELDSET":
      case "OPTGROUP":
        return "group";
      case "DFN":
      case "DT":
        return "term";
      case "DIALOG":
        return "dialog";
      case "EM":
        return "emphasis";
      case "FIGURE":
        return "figure";
      case "FOOTER":
        return element.closest(LANDMARK_ANCESTOR) ? null : "contentinfo";
      case "HEADER":
        return element.closest(LANDMARK_ANCESTOR) ? null : "banner";
      case "FORM":
        return element.hasAttribute("aria-label") ||
          element.hasAttribute("aria-labelledby")
          ? "form"
          : null;
      case "SECTION":
        return element.hasAttribute("aria-label") ||
          element.hasAttribute("aria-labelledby")
          ? "region"
          : null;
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
        return "heading";
      case "HR":
        return "separator";
      case "IMG":
        return element.getAttribute("alt") === "" &&
          !element.getAttribute("title") &&
          !hasGlobalAria(element, null) &&
          !hasTabIndex(element)
          ? "presentation"
          : "img";
      case "INPUT": {
        const type = (element as HTMLInputElement).type.toLowerCase();
        if (["email", "search", "tel", "text", "url", ""].includes(type)) {
          const list = idRefs(element, element.getAttribute("list"))[0];
          if (list && tagOf(list) === "DATALIST") return "combobox";
          return type === "search" ? "searchbox" : "textbox";
        }
        if (type === "hidden") return null;
        if (type === "file") return "button";
        const byType: Record<string, string> = {
          button: "button",
          checkbox: "checkbox",
          image: "button",
          number: "spinbutton",
          radio: "radio",
          range: "slider",
          reset: "button",
          submit: "button",
        };
        return byType[type] ?? "textbox";
      }
      case "INS":
        return "insertion";
      case "LI":
        return "listitem";
      case "MAIN":
        return "main";
      case "MARK":
        return "mark";
      case "MATH":
        return "math";
      case "MENU":
      case "OL":
      case "UL":
        return "list";
      case "METER":
        return "meter";
      case "NAV":
        return "navigation";
      case "OPTION":
        return "option";
      case "OUTPUT":
        return "status";
      case "P":
        return "paragraph";
      case "PROGRESS":
        return "progressbar";
      case "SEARCH":
        return "search";
      case "SELECT":
        return element.hasAttribute("multiple") ||
          (element as HTMLSelectElement).size > 1
          ? "listbox"
          : "combobox";
      case "STRONG":
        return "strong";
      case "SUB":
        return "subscript";
      case "SUP":
        return "superscript";
      case "SVG":
        return "img";
      case "TABLE":
        return "table";
      case "TBODY":
      case "TFOOT":
      case "THEAD":
        return "rowgroup";
      case "TD":
        return "cell";
      case "TH":
        return "columnheader";
      case "TEXTAREA":
        return "textbox";
      case "TIME":
        return "time";
      case "TR":
        return "row";
      default:
        return null;
    }
  };
  const roleOf = (element: Element): string => {
    const explicit = explicitRole(element);
    if (!explicit) return implicitRole(element) ?? "";
    if (explicit === "none" || explicit === "presentation") {
      const implicit = implicitRole(element);
      if (hasGlobalAria(element, implicit) || isFocusable(element)) {
        return implicit ?? "";
      }
    }
    return explicit;
  };

  /** A field, a select, a spinbutton, a slider — or the host of an editable region. */
  const holdsAValue = (element: Element): boolean => {
    if (HOLDS_A_VALUE.has(roleOf(element))) return true;
    const tag = tagOf(element);
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      const type = (element as HTMLInputElement).type.toLowerCase();
      return ![
        "button",
        "submit",
        "reset",
        "image",
        "checkbox",
        "radio",
        "file",
        "hidden",
      ].includes(type);
    }
    const editable = (element as HTMLElement).isContentEditable === true;
    const parent = parentOf(element) as HTMLElement | undefined;
    return editable && parent?.isContentEditable !== true;
  };

  /** A node a person typed into: it carries the mark (`quietOn` in secret-fields.ts). */
  const mark = Symbol.for(markName);
  const isTypedInto = (node: Node): boolean =>
    markName !== "" &&
    (node as unknown as Record<symbol, unknown>)[mark] === true;
  /** One step up, out of a shadow tree by its host. */
  const above = (node: Node): Node | null =>
    node.parentNode ?? (node as ShadowRoot).host ?? null;
  /** A typed-into node, or anything inside one. */
  const insideTyped = (node: Node | null): boolean => {
    if (markName === "") return false;
    for (let at = node; at; at = above(at)) if (isTypedInto(at)) return true;
    return false;
  };
  /** Whether an element holds a typed-into node, in its own tree or in a shadow tree beneath it. */
  const holdsTyped = (element: Element): boolean => {
    if (markName === "") return false;
    const beneath = (root: Element | ShadowRoot): boolean =>
      Array.from(root.querySelectorAll("*")).some(
        (inner) =>
          isTypedInto(inner) ||
          (inner.shadowRoot !== null && beneath(inner.shadowRoot)),
      );
    return (
      beneath(element) ||
      (element.shadowRoot !== null && beneath(element.shadowRoot))
    );
  };
  /** Text a person typed: inside a typed-into node, or in any editable region when every one is. */
  const typedText = (node: Node): boolean =>
    every
      ? (node.parentElement as HTMLElement | null)?.isContentEditable === true
      : insideTyped(node);
  /** Set while one control is named: its name was drawn, somewhere on the way, from such a node. */
  let drawn = false;

  const visibleText = (node: Text): boolean => {
    const range = node.ownerDocument.createRange();
    range.selectNode(node);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const ignored = (element: Element): boolean =>
    ["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE"].includes(tagOf(element));
  const hiddenAbove = new WeakMap<Element, boolean>();
  const noneOrAriaHidden = (element: Element): boolean => {
    const known = hiddenAbove.get(element);
    if (known !== undefined) return known;
    let hidden =
      !!element.parentElement?.shadowRoot &&
      !(element as HTMLElement).assignedSlot;
    if (!hidden) {
      const style = styleOf(element);
      hidden =
        !style ||
        style.display === "none" ||
        (element.getAttribute("aria-hidden") ?? "").toLowerCase() === "true";
    }
    if (!hidden) {
      const parent = parentOf(element);
      if (parent) hidden = noneOrAriaHidden(parent);
    }
    hiddenAbove.set(element, hidden);
    return hidden;
  };
  const hiddenForAria = (element: Element): boolean => {
    if (ignored(element)) return true;
    const style = styleOf(element);
    const isSlot = element.nodeName === "SLOT";
    if (style?.display === "contents" && !isSlot) {
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && !hiddenForAria(child as Element)) {
          return false;
        }
        if (child.nodeType === 3 && visibleText(child as Text)) return false;
      }
      return true;
    }
    const optionInSelect =
      element.nodeName === "OPTION" && !!element.closest("select");
    if (!optionInSelect && !isSlot && style) {
      if (
        typeof element.checkVisibility === "function" &&
        !element.checkVisibility()
      ) {
        return true;
      }
      if (style.visibility !== "visible") return true;
    }
    return noneOrAriaHidden(element);
  };

  /**
   * The text a CSS `content` value gives: its strings and `attr()`s, the alternative after a `/`, or
   * undefined for anything else (an image, a counter) — as the role engine reads it.
   */
  const contentText = (
    element: Element,
    content: string,
    pseudo: boolean,
  ): string | undefined => {
    type Token =
      | { kind: "string"; value: string }
      | { kind: "function"; value: string }
      | { kind: "ident"; value: string }
      | { kind: "close" }
      | { kind: "slash" }
      | { kind: "other" };
    const tokens: Token[] = [];
    let at = 0;
    const isIdent = (char: string | undefined): boolean =>
      !!char && /[A-Za-z0-9_\-\u0080-\uffff\\]/.test(char);
    while (at < content.length) {
      const char = content[at] ?? "";
      if (/\s/.test(char)) {
        at += 1;
      } else if (char === '"' || char === "'") {
        at += 1;
        let value = "";
        while (at < content.length && content[at] !== char) {
          if (content[at] === "\\") {
            const hex = /^[0-9a-fA-F]{1,6}\s?/.exec(content.slice(at + 1));
            if (hex) {
              const code = Number.parseInt(hex[0].trim(), 16);
              value += String.fromCodePoint(
                code === 0 || code > 0x10ffff ? 0xfffd : code,
              );
              at += 1 + hex[0].length;
            } else {
              if (content[at + 1] !== "\n") value += content[at + 1] ?? "";
              at += 2;
            }
            continue;
          }
          value += content[at];
          at += 1;
        }
        at += 1;
        tokens.push({ kind: "string", value });
      } else if (char === "/") {
        tokens.push({ kind: "slash" });
        at += 1;
      } else if (char === ")") {
        tokens.push({ kind: "close" });
        at += 1;
      } else if (isIdent(char) && !/[0-9]/.test(char)) {
        let value = "";
        while (isIdent(content[at])) {
          value += content[at];
          at += 1;
        }
        if (content[at] === "(") {
          at += 1;
          if (value.toLowerCase() === "url") {
            // A url's contents are not tokens: run to its close.
            while (at < content.length && content[at] !== ")") at += 1;
            at += 1;
            tokens.push({ kind: "other" });
          } else {
            tokens.push({ kind: "function", value: value.toLowerCase() });
          }
        } else {
          tokens.push({ kind: "ident", value });
        }
      } else {
        tokens.push({ kind: "other" });
        at += 1;
      }
    }
    let read = tokens;
    const slash = tokens.findIndex((token) => token.kind === "slash");
    if (slash !== -1) read = tokens.slice(slash + 1);
    else if (!pseudo) return undefined;
    let text = "";
    for (let index = 0; index < read.length; ) {
      const token = read[index];
      const name = read[index + 1];
      if (token?.kind === "string") {
        text += token.value;
        index += 1;
      } else if (
        token?.kind === "function" &&
        token.value === "attr" &&
        name?.kind === "ident" &&
        read[index + 2]?.kind === "close"
      ) {
        text += element.getAttribute(name.value) ?? "";
        index += 3;
      } else {
        return undefined;
      }
    }
    return text;
  };
  const cssContent = (
    element: Element,
    pseudo?: "::before" | "::after",
  ): string | undefined => {
    const style = styleOf(element, pseudo);
    let text: string | undefined;
    const value = style?.content;
    if (
      style &&
      value &&
      value !== "none" &&
      value !== "normal" &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    ) {
      text = contentText(element, value, !!pseudo);
    }
    if (
      pseudo &&
      text !== undefined &&
      (style?.display || "inline") !== "inline"
    ) {
      text = ` ${text} `;
    }
    return text;
  };

  const fromContent = (role: string, beneath: boolean): boolean =>
    FROM_CONTENT.has(role) || (beneath && FROM_CONTENT_BENEATH.has(role));

  const fromLabels = (labels: NodeListOf<HTMLLabelElement>, options: Options) =>
    [...labels]
      .map((label) =>
        alternative(label, {
          visited: options.visited,
          includeHidden: options.includeHidden,
          label: { element: label, hidden: hiddenForAria(label) },
        }),
      )
      .filter(Boolean)
      .join(" ");

  const contents = (element: Element, options: Options): string => {
    const tokens: string[] = [];
    const visit = (node: Node, skipSlotted: boolean) => {
      if (skipSlotted && (node as Element | Text).assignedSlot) return;
      if (node.nodeType === 1) {
        const display = styleOf(node as Element)?.display || "inline";
        let token = alternative(node as Element, options);
        if (display !== "inline" || node.nodeName === "BR")
          token = ` ${token} `;
        tokens.push(token);
      } else if (node.nodeType === 3) {
        tokens.push(typedText(node) ? "" : (node.textContent ?? ""));
      }
    };
    tokens.push(cssContent(element, "::before") ?? "");
    const own = cssContent(element);
    if (own !== undefined) {
      tokens.push(own);
    } else {
      const assigned =
        element.nodeName === "SLOT"
          ? (element as HTMLSlotElement).assignedNodes()
          : [];
      if (assigned.length) {
        for (const child of assigned) visit(child, false);
      } else {
        for (let child = element.firstChild; child; child = child.nextSibling) {
          visit(child, true);
        }
        if (element.shadowRoot) {
          for (
            let child = element.shadowRoot.firstChild;
            child;
            child = child.nextSibling
          ) {
            visit(child, true);
          }
        }
        for (const owned of idRefs(
          element,
          element.getAttribute("aria-owns"),
        )) {
          visit(owned, true);
        }
      }
    }
    tokens.push(cssContent(element, "::after") ?? "");
    return tokens.join("");
  };

  const alternative = (element: Element, options: Options): string => {
    if (options.visited.has(element)) return "";
    if (
      !drawn &&
      options.within !== "self" &&
      (insideTyped(element) || holdsTyped(element))
    ) {
      drawn = true;
    }
    const beneath: Options = {
      ...options,
      within: options.within === "self" ? "descendant" : options.within,
    };
    // The one departure from the browser (see the module comment): before anything else, and on
    // every path — beneath the control, through `aria-labelledby`, through a `<label>`.
    if (options.within !== "self" && holdsAValue(element)) {
      options.visited.add(element);
      return "";
    }
    const throughHidden =
      !!options.labelledBy?.hidden ||
      !!options.native?.hidden ||
      !!options.label?.hidden;
    if (
      !options.includeHidden &&
      (ignored(element) || (!throughHidden && hiddenForAria(element)))
    ) {
      options.visited.add(element);
      return "";
    }

    const labelledByAttribute = element.getAttribute("aria-labelledby");
    const labelledBy =
      labelledByAttribute === null ? [] : idRefs(element, labelledByAttribute);
    if (!options.labelledBy) {
      const byReference = labelledBy
        .map((reference) =>
          alternative(reference, {
            visited: options.visited,
            includeHidden: options.includeHidden,
            labelledBy: {
              element: reference,
              hidden: hiddenForAria(reference),
            },
          }),
        )
        .join(" ");
      if (byReference) return byReference;
    }

    const role = roleOf(element);
    const tag = tagOf(element);
    if (
      (options.label ||
        options.labelledBy ||
        options.within === "descendant") &&
      ![...((element as HTMLInputElement).labels ?? [])].includes(
        element as HTMLLabelElement,
      ) &&
      !labelledBy.includes(element)
    ) {
      if (["progressbar", "scrollbar", "meter"].includes(role)) {
        options.visited.add(element);
        return (
          element.getAttribute("aria-valuetext") ??
          element.getAttribute("aria-valuenow") ??
          element.getAttribute("value") ??
          ""
        );
      }
      if (role === "menu") {
        options.visited.add(element);
        return "";
      }
    }

    const ariaLabel = element.getAttribute("aria-label") ?? "";
    if (ariaLabel.trim()) {
      options.visited.add(element);
      return ariaLabel;
    }

    const titleOf = () => element.getAttribute("title") ?? "";
    const named = labelledBy.length > 0;
    if (role !== "presentation" && role !== "none") {
      const input = element as HTMLInputElement;
      const labels = (): NodeListOf<HTMLLabelElement> | [] =>
        input.labels ?? [];
      if (
        tag === "INPUT" &&
        ["button", "submit", "reset"].includes(input.type)
      ) {
        options.visited.add(element);
        const value = input.value || "";
        if (value.trim()) return value;
        if (input.type === "submit") return "Submit";
        if (input.type === "reset") return "Reset";
        return titleOf();
      }
      if (tag === "INPUT" && input.type === "file") {
        options.visited.add(element);
        const found = labels();
        if (found.length && !options.labelledBy) {
          return fromLabels(found as NodeListOf<HTMLLabelElement>, options);
        }
        return "Choose File";
      }
      if (tag === "INPUT" && input.type === "image") {
        options.visited.add(element);
        const found = labels();
        if (found.length && !options.labelledBy) {
          return fromLabels(found as NodeListOf<HTMLLabelElement>, options);
        }
        const alt = element.getAttribute("alt") ?? "";
        if (alt.trim()) return alt;
        const title = titleOf();
        if (title.trim()) return title;
        return "Submit";
      }
      if (
        !named &&
        [
          "BUTTON",
          "OUTPUT",
          "INPUT",
          "TEXTAREA",
          "SELECT",
          "METER",
          "PROGRESS",
        ].includes(tag)
      ) {
        options.visited.add(element);
        const found = labels();
        if (found.length) {
          return fromLabels(found as NodeListOf<HTMLLabelElement>, options);
        }
        if (tag !== "BUTTON") {
          // A box with no label is called by its title, or by its placeholder where it has no
          // title and is of a kind that shows one. Boxes are named here since 2026-10-05: one
          // whose `<label>` holds what a person typed is listed under this name.
          const title = titleOf();
          const showsPlaceholder =
            tag === "TEXTAREA" ||
            (tag === "INPUT" &&
              [
                "text",
                "password",
                "number",
                "search",
                "tel",
                "email",
                "url",
              ].includes(input.type));
          if (!showsPlaceholder || title) return title;
          return element.getAttribute("placeholder") ?? "";
        }
      }
      if (!named && (tag === "FIELDSET" || tag === "FIGURE")) {
        options.visited.add(element);
        const caption = tag === "FIELDSET" ? "LEGEND" : "FIGCAPTION";
        for (
          let child = element.firstElementChild;
          child;
          child = child.nextElementSibling
        ) {
          if (tagOf(child) === caption) {
            return alternative(child, {
              ...beneath,
              native: { element: child, hidden: hiddenForAria(child) },
            });
          }
        }
        return titleOf();
      }
      if (tag === "IMG" || tag === "AREA") {
        options.visited.add(element);
        const alt = element.getAttribute("alt") ?? "";
        if (alt.trim()) return alt;
        return titleOf();
      }
      if (tag === "TABLE") {
        options.visited.add(element);
        for (
          let child = element.firstElementChild;
          child;
          child = child.nextElementSibling
        ) {
          if (tagOf(child) === "CAPTION") {
            return alternative(child, {
              ...beneath,
              native: { element: child, hidden: hiddenForAria(child) },
            });
          }
        }
        const summary = element.getAttribute("summary") ?? "";
        if (summary) return summary;
      }
      const inSvg = (element as SVGElement).ownerSVGElement;
      if (tag === "SVG" || inSvg) {
        options.visited.add(element);
        for (
          let child = element.firstElementChild;
          child;
          child = child.nextElementSibling
        ) {
          if (
            tagOf(child) === "TITLE" &&
            (child as SVGElement).ownerSVGElement
          ) {
            return alternative(child, {
              ...beneath,
              labelledBy: { element: child, hidden: hiddenForAria(child) },
            });
          }
        }
      }
      if (inSvg && tag === "A") {
        const title = element.getAttribute("xlink:title") ?? "";
        if (title.trim()) {
          options.visited.add(element);
          return title;
        }
      }
    }

    const summary =
      tag === "SUMMARY" && role !== "presentation" && role !== "none";
    if (
      fromContent(role, options.within === "descendant") ||
      summary ||
      options.labelledBy ||
      options.label ||
      options.native
    ) {
      options.visited.add(element);
      const text = contents(element, beneath);
      if (options.within === "self" ? text.trim() : text) return text;
    }
    if (
      (role !== "presentation" && role !== "none") ||
      tag === "IFRAME" ||
      tag === "FRAME"
    ) {
      options.visited.add(element);
      const title = titleOf();
      if (title.trim()) return title;
    }
    options.visited.add(element);
    return "";
  };

  const names = elements.map((target) => {
    try {
      /*
       * The control itself: around a typed-into node or inside one, its words are that node's. One
       * that IS such a node says so only when it is an editable region — a region's own name can
       * be its contents, and a box's never is.
       */
      drawn =
        every ||
        (isTypedInto(target)
          ? (target as HTMLElement).isContentEditable === true
          : false) ||
        insideTyped(above(target)) ||
        holdsTyped(target);
      const text = alternative(target, {
        visited: new Set(),
        includeHidden: hiddenForAria(target),
        within: "self",
      });
      // As the role engine reads a name before comparing it (`normalizeWhiteSpace`).
      const name = text
        .replace(/[\u200b\u00ad]/g, "")
        .trim()
        .replace(/\s+/g, " ");
      return `${drawn ? "1" : "0"}${name}`;
    } catch {
      return null;
    }
  });
  return alone ? (names[0] ?? null) : names;
}

/** The document a ref belongs to: `f3e12` is frame 3's, `e12` the page's. */
function documentOf(ref: string): string {
  return /^f\d+/.exec(ref)?.[0] ?? "";
}

/** What the page said of the controls it was asked about. */
export type PageNames = {
  /** The name of each ref the page answered for. */
  names: Map<string, string>;
  /** The refs, among those, whose name is drawn from a node a person typed into (`Hush`). */
  drawn: Set<string>;
};

/**
 * The page's names for these refs, where the page gave one. A ref that names nothing now, a frame
 * that has lost its document, a look out of time: that ref is left out, and the caller decides what
 * a control the page did not answer for is called (`withNames`).
 *
 * A ref resolves only through a locator, and only in the world the tree was taken in: measured
 * 2026-10-04 on 1.62.1, `evaluateAll` on `aria-ref=e3` answered an empty list where `count()`
 * answered 1, every time, so the names cannot be asked for in one call by selector. Each ref is
 * resolved to a handle — all at once, so the round trips overlap — and each document's handles are
 * named in one evaluation. Measured on Naver news's 86 nameless controls, median of three: a handle
 * each and one evaluation took 46 ms, an evaluation per ref 75 ms.
 *
 * WHERE THE ONE EVALUATION FAILS, EACH ELEMENT IS ASKED ON ITS OWN, in what is left of the time. A
 * page that replaces `Map` fails it every time (`namesOf` says how), and such a page used to get
 * no names at all — which, now that a tab a person typed into is asked about every control, would
 * have left every control on it nameless after somebody signed in by hand. Measured 2026-10-05 on
 * the fixture's page with 고용24's `Map`: the list of elements threw `refs.set is not a function`,
 * and an element with a string answered.
 *
 * `hush` is the mark the nodes a person typed into carry in the page, and whether every box and
 * region is to be taken for one; the same mark in every document, so nothing is matched to a frame.
 *
 * Every wait is bounded by `ms` in all, since a frame with no document never answers (`within.ts`),
 * and every handle is let go once it has been asked, late ones included.
 */
export async function namesFromThePage(
  target: Page,
  refs: readonly string[],
  ms: number,
  hush: Hush = { mark: "", every: false },
): Promise<PageNames> {
  const names = new Map<string, string>();
  const drawn = new Set<string>();
  if (refs.length === 0 || ms <= 0) return { names, drawn };
  /*
   * Half the time to find the elements and the rest to name them, so a ref that names nothing — a
   * node the page removed since the tree — waits out its half and does not take its document's
   * names down with it.
   */
  const findFor = Math.max(1, Math.floor(ms / 2));
  const foundBy = Date.now() + findFor;
  const until = Date.now() + ms;
  const byDocument = new Map<string, string[]>();
  for (const ref of refs) {
    const key = documentOf(ref);
    byDocument.set(key, [...(byDocument.get(key) ?? []), ref]);
  }
  await Promise.all(
    [...byDocument.values()].map(async (inDocument) => {
      const asked = inDocument.map((ref) =>
        target
          .locator(`aria-ref=${ref}`)
          .elementHandle({ timeout: findFor })
          .catch(() => null),
      );
      const handles = await Promise.all(
        asked.map((handle) =>
          fromDocument(target, foundBy - Date.now(), handle),
        ),
      );
      asked.forEach((handle, index) => {
        if (handles[index] === undefined) {
          void handle.then((late) => late?.dispose()).catch(() => undefined);
        }
      });
      const found = handles.flatMap((handle, index) =>
        handle ? [{ handle, ref: inDocument[index] ?? "" }] : [],
      );
      const first = found[0]?.handle;
      if (!first) return;
      // Its failure kept apart from its silence: one that failed is asked again, element by element.
      const together = await fromDocument(
        target,
        until - Date.now(),
        first
          .evaluate(namesOf, {
            elements: found.map(({ handle }) => handle),
            mark: hush.mark,
            every: hush.every,
          })
          .catch(() => "failed" as const),
      );
      const answered = Array.isArray(together)
        ? together
        : together === undefined
          ? []
          : await Promise.all(
              found.map(({ handle }) =>
                fromDocument(
                  target,
                  until - Date.now(),
                  handle
                    .evaluate(namesOf, `${hush.every ? "1" : "0"}${hush.mark}`)
                    .catch(() => null),
                ),
              ),
            );
      void Promise.all(
        found.map(({ handle }) => handle.dispose().catch(() => undefined)),
      );
      found.forEach(({ ref }, index) => {
        const answer = answered[index];
        if (typeof answer !== "string") return;
        names.set(ref, answer.slice(1));
        if (answer.charAt(0) === "1") drawn.add(ref);
      });
    }),
  );
  return { names, drawn };
}
