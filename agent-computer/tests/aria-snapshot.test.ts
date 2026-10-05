import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isSecretLabel,
  isTextEntryRole,
  namesToList,
  opaqueFramesIn,
  parseAriaSnapshot,
  parseDescriptor,
  readAriaSnapshot,
  withNames,
} from "../src/aria-snapshot";
import { listedTextEntryRefs } from "../src/secret-fields";

/**
 * The parser, tested against captured Playwright output.
 *
 * The fixture below is copied from `ariaSnapshot({ mode: "ai" })` against httpbin's form in the
 * container, after filling one field and ticking two boxes. Captured output matters because the real
 * shape includes nested wrappers and quoted text that plausible hand-written YAML can miss.
 *
 * Note what the real output shows that a plausible guess did not: flags come in any order
 * (`[checked] [active] [ref=e19]`, with ref last), Playwright quotes any value containing a colon, and
 * the tree nests several levels through `generic` and `paragraph` wrappers that carry refs of their own.
 */
const CAPTURED = `- generic [ref=e2]:
  - paragraph [ref=e3]:
    - generic [ref=e4]:
      - text: "Customer name:"
      - textbox "Customer name:" [ref=e5]: Katherine Johnson
  - paragraph [ref=e6]:
    - generic [ref=e7]:
      - text: "Telephone:"
      - textbox "Telephone:" [ref=e8]
  - group "Pizza Size" [ref=e12]:
    - paragraph [ref=e14]:
      - generic [ref=e15]:
        - radio "Small" [ref=e16]
        - text: Small
    - paragraph [ref=e17]:
      - generic [ref=e18]:
        - radio "Medium" [checked] [active] [ref=e19]
        - text: Medium
  - group "Pizza Toppings" [ref=e23]:
    - paragraph [ref=e25]:
      - generic [ref=e26]:
        - checkbox "Bacon" [ref=e27]
        - text: Bacon
    - paragraph [ref=e28]:
      - generic [ref=e29]:
        - checkbox "Extra Cheese" [checked] [ref=e30]
        - text: Extra Cheese
  - button "Submit order" [ref=e44]`;

describe("parseAriaSnapshot, against captured output", () => {
  test("the fixture is genuinely valid YAML", () => {
    // The guard against the mistake that made this rewrite necessary: an invented fixture will most
    // likely fail here first.
    expect(() => Bun.YAML.parse(CAPTURED)).not.toThrow();
  });

  test("keeps the controls and drops the scaffolding", () => {
    const { elements } = parseAriaSnapshot(CAPTURED);
    // `generic`, `paragraph`, `group` and `text` all carry refs but are not things a Bot can act on,
    // and a list full of them is what makes a model pick the wrong element.
    expect(elements.map((e) => e.role)).toEqual([
      "textbox",
      "textbox",
      "radio",
      "radio",
      "checkbox",
      "checkbox",
      "button",
    ]);
  });

  test("finds controls nested several levels deep", () => {
    const names = parseAriaSnapshot(CAPTURED).elements.map((e) => e.name);
    // The radios live under group > paragraph > generic. A parser reading only the top level would
    // return two textboxes and call that the page.
    expect(names).toContain("Small");
    expect(names).toContain("Extra Cheese");
  });

  test("reads ref, role and accessible name", () => {
    const { elements } = parseAriaSnapshot(CAPTURED);
    expect(elements[0]).toMatchObject({
      ref: "e5",
      role: "textbox",
      name: "Customer name:",
    });
    expect(elements.at(-1)).toMatchObject({
      ref: "e44",
      role: "button",
      name: "Submit order",
    });
  });

  /**
   * A half-ticked "select all", captured rather than written: `ariaSnapshot({ mode: "ai" })` against
   * a fieldset of three boxes in Chromium 151, the first with `indeterminate` set — what the box
   * above a partly-ticked list carries. Playwright writes it `[checked=mixed]`: a value, where an
   * ordinary tick is the bare `[checked]`. (Upstream OpenBot's fixture, #475.)
   */
  const MIXED = `- group "Toppings" [ref=e2]:
  - generic [ref=e4]:
    - checkbox "Select all" [checked=mixed] [ref=e5]
    - text: Select all
  - generic [ref=e6]:
    - checkbox "Bacon" [checked] [ref=e7]
    - text: Bacon
  - generic [ref=e8]:
    - checkbox "Extra Cheese" [ref=e9]
    - text: Extra Cheese`;

  test("a half-ticked box is not reported as ticked, and can still be acted on", () => {
    expect(() => Bun.YAML.parse(MIXED)).not.toThrow();
    const elements = parseAriaSnapshot(MIXED).elements;
    const byName = new Map(elements.map((e) => [e.name, e]));
    // Not checked, so a Bot asked to tick it clicks it. Told it was already checked, it left the
    // rows underneath unselected and said they were done.
    expect(byName.get("Select all")?.checked).toBe(false);
    // The two beside it are unchanged, so this is not a swap.
    expect(byName.get("Bacon")?.checked).toBe(true);
    expect(byName.get("Extra Cheese")?.checked).toBe(false);
    // The ref a click needs sits after the flag Playwright gave a value to.
    expect(byName.get("Select all")).toMatchObject({
      ref: "e5",
      role: "checkbox",
    });
  });

  test("a name or a value cut at its length is cut between characters", () => {
    // 199 letters and then an emoji: a cut at 200 units would keep the emoji's first half, and the
    // name goes into the trail's row before the action it names (`shared/sound-text.ts`).
    const long = `${"가".repeat(199)}😀나`;
    const { elements } = parseAriaSnapshot(
      `- link "${long}" [ref=e1]\n- textbox "메모" [ref=e2]: ${long}`,
    );
    expect(elements[0]?.name).toBe("가".repeat(199));
    expect(elements[1]?.value).toBe("가".repeat(199));
    for (const text of [elements[0]?.name, elements[1]?.value]) {
      expect(text?.isWellFormed()).toBe(true);
    }
  });

  test("reads a control's value, and omits it when empty", () => {
    const { elements } = parseAriaSnapshot(CAPTURED);
    expect(elements[0]?.value).toBe("Katherine Johnson");
    expect(elements[1]?.value).toBeUndefined();
  });

  test("reports checked AND unchecked for things that can be checked", () => {
    const byName = new Map(
      parseAriaSnapshot(CAPTURED).elements.map((e) => [e.name, e]),
    );
    expect(byName.get("Medium")?.checked).toBe(true);
    expect(byName.get("Extra Cheese")?.checked).toBe(true);
    // Playwright emits nothing for an unchecked control; false is inferred so a Bot can see the state
    // rather than assuming it.
    expect(byName.get("Small")?.checked).toBe(false);
    expect(byName.get("Bacon")?.checked).toBe(false);
    // A button cannot be checked, so the field is absent rather than false.
    expect(byName.get("Submit order")).not.toHaveProperty("checked");
  });

  /**
   * A PASSWORD BOX LOOKS EXACTLY LIKE A NAME FIELD IN HERE.
   *
   * Playwright reports `input[type=password]` as a `textbox` — that is its ARIA role — and the ai
   * snapshot's flags are about state (`[checked]`, `[disabled]`), not about markup. So the boundary,
   * whose flat rule is that a Bot must never type a password into a page, had nothing in the
   * snapshot to decide on: the server's contract has carried an `element.type` field the whole time
   * and nothing ever put a value in it.
   *
   * The caller reads the types out of the DOM in one call and hands over the labels; the join is by
   * name, because that is the only thing the accessible tree and the DOM both have. It is not exact,
   * which is why the shipped rule also matches the field's own label — see `default-policy.ts`.
   */
  test("marks the textbox a password input's label names", () => {
    const yaml = [
      '- textbox "아이디" [ref=e1]',
      '- textbox "비밀번호" [ref=e2]',
      '- button "로그인" [ref=e3]',
    ].join("\n");

    const byRef = new Map(
      parseAriaSnapshot(yaml, { labels: ["비밀번호"] }).elements.map((e) => [
        e.ref,
        e,
      ]),
    );
    expect(byRef.get("e2")?.type).toBe("password");
    // And nothing else is marked. Over-marking costs a Bot the use of an ordinary field.
    expect(byRef.get("e1")).not.toHaveProperty("type");
    expect(byRef.get("e3")).not.toHaveProperty("type");
  });

  test("marks nothing when the page has no password input", () => {
    const yaml = '- textbox "비밀번호" [ref=e1]';
    // A field somebody labelled 비밀번호 that is not a password input stays unmarked here. The label
    // is a signal, and it is the policy's to read; this function reports what the DOM said.
    expect(parseAriaSnapshot(yaml).elements[0]).not.toHaveProperty("type");
  });

  test("does not mark a button that happens to share a label", () => {
    const yaml = [
      '- button "비밀번호" [ref=e1]',
      '- textbox "비밀번호" [ref=e2]',
    ].join("\n");
    const byRef = new Map(
      parseAriaSnapshot(yaml, { labels: ["비밀번호"] }).elements.map((e) => [
        e.ref,
        e,
      ]),
    );
    expect(byRef.get("e1")).not.toHaveProperty("type");
    expect(byRef.get("e2")?.type).toBe("password");
  });

  test("empty and unparseable input produce no elements rather than throwing", () => {
    expect(parseAriaSnapshot("").elements).toEqual([]);
    expect(parseAriaSnapshot("\t- [[[ not yaml").elements).toEqual([]);
    expect(parseAriaSnapshot("").truncated).toBe(false);
  });

  test("the element list is bounded, and says when it was cut", () => {
    const many = Array.from(
      { length: 250 },
      (_, index) => `- button "B${index}" [ref=e${index}]`,
    ).join("\n");
    const { elements, truncated } = parseAriaSnapshot(many);
    expect(elements).toHaveLength(200);
    expect(truncated).toBe(true);
  });
});

describe("values a real parser handles and a pattern got wrong", () => {
  test("a quoted numeric value is not left with its quotes", () => {
    // Numeric-looking text remains a string, so one-time codes are not coerced.
    const { elements } = parseAriaSnapshot(
      '- textbox "Code" [ref=e1]: "123456"',
    );
    expect(elements[0]?.value).toBe("123456");
  });

  test("a value containing a colon survives", () => {
    const { elements } = parseAriaSnapshot(
      '- textbox "Homepage" [ref=e1]: "https://example.com:8443/path"',
    );
    expect(elements[0]?.value).toBe("https://example.com:8443/path");
  });

  test("an escaped quote inside a value survives", () => {
    const { elements } = parseAriaSnapshot(
      '- textbox "Note" [ref=e1]: "she said \\"yes\\""',
    );
    expect(elements[0]?.value).toBe('she said "yes"');
  });

  /**
   * Playwright quotes a value only when it has to, so the ones a Bot most often needs to read back
   * arrive bare: a telephone number, a postcode, an order reference.
   */
  test.each([
    ["555-0142", "a telephone number keeps both groups"],
    ["90210-1234", "a postcode keeps its extension"],
    ["0142-555", "a reference keeps its leading zero"],
    ["007", "a padded number keeps its padding"],
    ["2026-08-16", "a date stays the text on the page"],
    ["20:30", "a time is not read as a number"],
    ["1.2.3", "a version is not read as a number"],
    ["true", "a field holding a word is that word"],
  ])("an unquoted %s survives: %s", (written) => {
    const { elements } = parseAriaSnapshot(
      `- textbox "Field" [ref=e1]: ${written}`,
    );
    expect(elements[0]?.value).toBe(written);
  });
});

describe("parseDescriptor", () => {
  test("flags are read in any order, including ref last", () => {
    // Exactly what the captured output does: `[checked] [active] [ref=e19]`.
    const descriptor = parseDescriptor(
      'radio "Medium" [checked] [active] [ref=e19]',
    );
    expect(descriptor?.role).toBe("radio");
    expect(descriptor?.name).toBe("Medium");
    expect(descriptor?.flags.get("ref")).toBe("e19");
    expect(descriptor?.flags.has("checked")).toBe(true);
  });

  test("an escaped quote inside a name is unescaped", () => {
    const descriptor = parseDescriptor(
      'button "Delete \\"draft\\" now" [ref=e2]',
    );
    expect(descriptor?.name).toBe('Delete "draft" now');
  });

  test("a bracket inside the name is not mistaken for a flag", () => {
    // The reason this is scanned rather than matched: the parts can contain each other.
    const descriptor = parseDescriptor('button "Save [draft]" [ref=e3]');
    expect(descriptor?.name).toBe("Save [draft]");
    expect(descriptor?.flags.get("ref")).toBe("e3");
  });

  test("an unnamed control still parses", () => {
    const descriptor = parseDescriptor("button [ref=e1]");
    expect(descriptor).toMatchObject({ role: "button", name: "" });
    expect(descriptor?.flags.get("ref")).toBe("e1");
  });

  test("junk yields nothing rather than a half-built descriptor", () => {
    expect(parseDescriptor("")).toBeNull();
    expect(parseDescriptor("   ")).toBeNull();
  });
});

/**
 * THE SNAPSHOT USED TO HAND THE MODEL EVERY PASSWORD ON THE PAGE.
 *
 * Playwright's `mode: "ai"` tree puts an input's current value into the node, password boxes
 * included (measured: `- textbox "비밀번호" [ref=e2]: hunter2!SuperSecret`), and `toElement` copied
 * it onto the element it was about to mark `type: "password"`. So `computer_request_secret` — whose
 * whole promise is that the person types the value and the model never sees it — was undone by the
 * very next `computer_snapshot`, which the tool results tell the Bot to take.
 *
 * Asserted on the whole serialised result, not on one field: a value that leaked into a name or a
 * sibling would pass a narrower assertion and still be a password in a transcript.
 */
describe("what a secret field's value becomes", () => {
  const PASSWORD = "hunter2!SuperSecret";
  const OTP = "482913";
  const CARD = "5312-4400-1234-9876";
  const LOGIN = `- generic [ref=e1]:
  - textbox "아이디" [ref=e2]: sajang@example.test
  - textbox "비밀번호" [ref=e3]: ${PASSWORD}
  - textbox "인증번호 6자리" [ref=e4]: ${OTP}
  - textbox "카드 번호" [ref=e5]: ${CARD}
  - textbox "Password" [ref=e6]: ${PASSWORD}
  - button "로그인" [ref=e7]`;

  test("a password box the DOM marked loses its value and keeps its place", () => {
    const { elements } = parseAriaSnapshot(LOGIN, { labels: ["비밀번호"] });
    const marked = elements.find((element) => element.ref === "e3");
    expect(marked?.type).toBe("password");
    // Empty rather than absent: "there is a value here and it is not yours" is what the Bot needs to
    // know to press 로그인 rather than ask for it again.
    expect(marked?.value).toBe("");
    expect(JSON.stringify(elements)).not.toContain(PASSWORD);
  });

  test("a field the DOM could not mark is judged by its label", () => {
    // A one-time code is `type="text"` and a card number is `type="tel"`, so no password label
    // arrives for either — and both used to be handed to the model verbatim.
    const written = JSON.stringify(parseAriaSnapshot(LOGIN, {}).elements);
    expect(written).not.toContain(OTP);
    expect(written).not.toContain(CARD);
    expect(written).not.toContain(PASSWORD);
    // The username is not a secret and stays, which is the proof that the rule is about the label
    // rather than about every textbox on a login form.
    expect(written).toContain("sajang@example.test");
  });

  test("a secret field's value is dropped before the list is cut", () => {
    // The limit test above cuts the list; this pins that the cut never keeps a value the rule
    // would have dropped, because the two happen in the same `push`.
    const many = Array.from(
      { length: 5 },
      (_, index) =>
        `- textbox "비밀번호 ${index}" [ref=e${index}]: ${PASSWORD}${index}`,
    ).join("\n");
    expect(JSON.stringify(parseAriaSnapshot(many, {}))).not.toContain(PASSWORD);
  });

  test("the labels that mean a secret, and the ones that do not", () => {
    for (const label of [
      "비밀번호",
      "비밀 번호 확인",
      // The word the auditor's page used, and the word half of Korean retail writes. It was in
      // neither list, and a person's typed value went to the model through both nets (2026-09-10).
      "패스워드",
      "패스 워드",
      "비번",
      "암호",
      "Password",
      "PASSCODE",
      "인증번호 6자리",
      "인증 번호",
      "일회용 비밀번호",
      "OTP",
      "핀번호",
      "카드번호",
      "카드 번호",
      "CVC",
      "cvv",
      "보안코드",
      "보안 코드",
      // The four the audit's parser dry-run found keeping their values (R3-01, 2026-09-16).
      "승인번호",
      "카드 승인 번호",
      "인증코드",
      "인증 코드 입력",
      "주민등록번호 뒷자리",
      "주민등록 번호",
      "주민번호",
      "PIN",
      "pin",
      "간편결제 PIN",
      "PIN번호",
      "PIN 6자리",
      "PIN4",
      "Card PIN:",
      "pin_code",
    ]) {
      expect([label, isSecretLabel(label)]).toEqual([label, true]);
    }
    for (const label of [
      "아이디",
      "Customer name:",
      "검색",
      "주문번호",
      "우편번호",
      "승인 요청 사유",
      // PIN only on its own: inside another word it is a shipping address, a spinner, an opinion.
      "Shipping address",
      "Spinner",
      "Your opinion",
      "Pinterest 계정",
      "PINs and needles",
    ]) {
      expect([label, isSecretLabel(label)]).toEqual([label, false]);
    }
  });

  test("the audit's four labels lose their values, as the tree writes them", () => {
    const VALUES = ["SEC-APPROVAL-1111", "CODE-2222", "1234567", "0412"];
    const { elements } = parseAriaSnapshot(`- generic [ref=e1]:
  - textbox "승인번호" [ref=e2]: ${VALUES[0]}
  - textbox "인증코드" [ref=e3]: ${VALUES[1]}
  - textbox "주민등록번호 뒷자리" [ref=e4]: ${VALUES[2]}
  - textbox "PIN" [ref=e5]: ${VALUES[3]}
  - textbox "Shipping address" [ref=e6]: 서울시 중구`);
    const written = JSON.stringify(elements);
    for (const value of VALUES) expect(written).not.toContain(value);
    expect(elements.map((element) => element.value)).toEqual([
      "",
      "",
      "",
      "",
      "서울시 중구",
    ]);
  });
});

/**
 * A SECRET FIELD IS KNOWN BY WHAT IT IS, NOT ONLY BY WHAT IT IS CALLED.
 *
 * The join between the DOM and the tree used to be the label alone, and the label is the page's
 * to choose. Measured 2026-09-10 on `<input type="password" aria-labelledby="패스워드">`: the tree
 * named it 패스워드, `HTMLInputElement.labels` named it nothing, the word was in no list, and the
 * value a person had just typed through `computer_request_secret` rode out on the next snapshot —
 * in the published container and in main. These are the joins that do not need the page's
 * cooperation: the ref Playwright minted for the node, and the value read off the node.
 */
describe("a secret field the DOM knows by identity", () => {
  const SECRET = "PERSON-TYPED-SECRET-7788";
  const CODE = "482913";
  // The auditor's page, with a name no word list carries, so only identity can find it.
  const PAGE = `- generic [ref=e1]:
  - textbox "아이디" [ref=e2]: kim
  - textbox "로그인 키" [ref=e3]: ${SECRET}
  - textbox "6자리" [ref=e4]: "${CODE}"
  - button "로그인" [ref=e5]`;

  test("by ref: the node Playwright minted the ref for loses its value, whatever it is called", () => {
    const { elements } = parseAriaSnapshot(PAGE, { refs: ["e3"] });
    expect(elements.find((element) => element.ref === "e3")).toEqual({
      ref: "e3",
      role: "textbox",
      name: "로그인 키",
      type: "password",
      value: "",
    });
    const written = JSON.stringify(elements);
    expect(written).not.toContain(SECRET);
    // The username is untouched: identity marks one node, not the form.
    expect(written).toContain("kim");
  });

  test("by value: the box holding a secret is blanked by its contents, not its name", () => {
    const { elements } = parseAriaSnapshot(PAGE, { values: [CODE] });
    const code = elements.find((element) => element.ref === "e4");
    expect(code?.type).toBe("password");
    expect(code?.value).toBe("");
    expect(JSON.stringify(elements)).not.toContain(CODE);
  });

  test("by value, as the tree writes it: collapsed, trimmed, cut", () => {
    // Playwright collapses a value before writing it (measured on a textarea), and the parser trims
    // it. The DOM's copy is neither, and an exact comparison let every one of these through.
    const yaml = [
      `- textbox "a" [ref=e1]: ${SECRET}`,
      `- textbox "b" [ref=e2]: correct horse battery`,
      `- textbox "c" [ref=e3]: ${"z".repeat(300)}`,
    ].join("\n");
    const { elements } = parseAriaSnapshot(yaml, {
      values: [`  ${SECRET}  `, "correct\n  horse\tbattery", "z".repeat(300)],
    });
    expect(elements.map((element) => [element.type, element.value])).toEqual([
      ["password", ""],
      ["password", ""],
      ["password", ""],
    ]);
  });

  test("an empty value is not a value: every empty box is not a secret field", () => {
    const { elements } = parseAriaSnapshot('- textbox "검색" [ref=e1]', {
      values: ["", "   "],
    });
    expect(elements[0]).not.toHaveProperty("type");
  });

  test("a ref marks a field only: a button of that ref is not a place a secret is typed", () => {
    const { elements } = parseAriaSnapshot('- button "로그인" [ref=e5]', {
      refs: ["e5"],
    });
    expect(elements[0]).not.toHaveProperty("type");
  });

  test("a spinbutton — a numeric input — is a field a secret can be typed into", () => {
    const { elements } = parseAriaSnapshot(
      `- spinbutton "6자리" [ref=e1]: ${CODE}`,
      { refs: ["e1"] },
    );
    expect(elements[0]?.type).toBe("password");
    expect(elements[0]?.value).toBe("");
  });

  test("by word, 패스워드 is enough on its own now", () => {
    expect(isSecretLabel("패스워드")).toBe(true);
    const { elements } = parseAriaSnapshot(
      `- textbox "패스워드" [ref=e1]: ${SECRET}`,
    );
    expect(JSON.stringify(elements)).not.toContain(SECRET);
  });

  test("unverified: a field that could not be looked for in time could be any box, so no box shows its contents", () => {
    // What `snapshotPage` hands over when the page stopped answering while a field a person typed a
    // secret into was still being looked for: nothing marks the box, and nothing may show it.
    const { elements } = parseAriaSnapshot(PAGE, { unverified: true });
    const written = JSON.stringify(elements);
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain(CODE);
    expect(written).not.toContain("kim");
    // Blanked, not marked: the boxes are still boxes, present and empty, and nothing else changed.
    expect(
      elements.map((element) => [element.ref, element.value, element.type]),
    ).toEqual([
      ["e2", "", undefined],
      ["e3", "", undefined],
      ["e4", "", undefined],
      ["e5", undefined, undefined],
    ]);
  });
});

/**
 * THE FRAMES A SNAPSHOT COULD NOT SEE INTO.
 *
 * Captured with Playwright 1.62.1 and a real Chromium (2026-09-14): a page with a readable
 * cross-origin frame, an empty one and `<iframe src="chrome://version">`, which the browser never
 * gives a document. Playwright writes the colon after an iframe's line only when it came back from
 * inside it with something — the empty frame's single blank line included — so the bare line is the
 * one frame the Bot cannot see into.
 */
const WITH_FRAMES =
  '- generic [active] [ref=e1]:\n  - button "주문 확인" [ref=e2]\n  - iframe [ref=e3]:\n    - button "결제 진행" [ref=f1e2]\n  - iframe [ref=e4]:\n    \n  - iframe [ref=e5]';

describe("frames the snapshot could not see into", () => {
  test("the captured page has one, and its controls still parse", () => {
    expect(opaqueFramesIn(WITH_FRAMES)).toBe(1);
    expect(
      parseAriaSnapshot(WITH_FRAMES).elements.map((element) => element.name),
    ).toEqual(["주문 확인", "결제 진행"]);
  });

  test("a frame it entered is not one, whether or not anything was inside", () => {
    expect(
      opaqueFramesIn(
        '- iframe [ref=e3]:\n  - button "결제 진행" [ref=f1e2]\n- iframe [ref=e4]:\n  ',
      ),
    ).toBe(0);
  });

  test("the bare line counts wherever it sits, with the flags Playwright puts on it", () => {
    expect(
      opaqueFramesIn(
        "- iframe [ref=e1]\n- generic [ref=e2]:\n  - iframe [active] [ref=e3]\n  - paragraph [ref=e4]:\n    - iframe [ref=e5]",
      ),
    ).toBe(3);
  });

  test("text that mentions an iframe is not one, and neither is a control named like one", () => {
    expect(
      opaqueFramesIn(
        '- text: "- iframe [ref=e1]"\n- button "iframe [ref=e2]" [ref=e3]\n- iframe\n- iframe [ref=]',
      ),
    ).toBe(0);
  });

  test("counted to the last frame on a page past the element limit", () => {
    const buttons = Array.from(
      { length: 250 },
      (_, index) => `- button "b${index}" [ref=e${index + 10}]`,
    );
    const yaml = [...buttons, "- iframe [ref=e999]"].join("\n");
    expect(parseAriaSnapshot(yaml).truncated).toBe(true);
    expect(opaqueFramesIn(yaml)).toBe(1);
  });
});

/**
 * A control the tree prints without a name, though the browser has one for it.
 *
 * Playwright 1.62's AI tree blanks the name of a node whose name came from children it also prints
 * (`removeRedundantNames`), so `<a href><strong>헤드라인</strong></a>` arrives as `link [ref=…]:` with
 * the headline one level down. The list read `e137 link` and nothing more on 85 of Naver news's 200
 * lines (2026-10-04) — 44 of them its headlines — and the label hold, judging the empty name against a
 * browser that calls each headline by its words, refused every click on one.
 *
 * The name is the page's to give (`page-names.ts`), and this list does not guess at it: for a day
 * it did, from the words beneath the control, and `readAriaSnapshot` says what was wrong with
 * that. What is held here is the tree's half — such a control has no name and no value, whatever
 * is beneath it, and is one the page is asked about.
 */
describe("a control the tree prints without a name", () => {
  /** Captured from news.naver.com/section/101 on 2026-10-04; see the file's own header. */
  const NAVER_NEWS = readFileSync(
    join(import.meta.dir, "fixtures", "naver-news-headlines.yaml"),
    "utf8",
  );

  test("Naver's headlines, as captured, are the links the page is asked to name", () => {
    const read = readAriaSnapshot(NAVER_NEWS);
    // Each of these reads `e137 link` and nothing else in the tree's own list.
    expect(read.unnamed).toEqual([
      "e117",
      "e120",
      "e135",
      "e137",
      "e152",
      "e154",
    ]);
    const byRef = new Map(
      read.elements.map((element) => [element.ref, element.name]),
    );
    for (const ref of read.unnamed) {
      expect([ref, byRef.get(ref)]).toEqual([ref, ""]);
    }
    // A link with a name of its own keeps it, and the page is not asked about it.
    expect(byRef.get("e127")).toBe("헤드라인 뉴스 안내");
    expect(byRef.get("e144")).toBe("14 개의 관련뉴스 더보기");
    // What the look hands on once the page has answered as the browser names them: a headline by
    // its words, an image link by its image's alt text, the thumbnail by nothing.
    const headline = "LG전자 노사, 아동복지시설 봉사…가전 점검·AI 체험 지원";
    const banner = "AI 뉴스 알고리즘 추천 알고리즘 궁금하다면? 바로가기";
    const listed = new Map(
      withNames(
        read.elements,
        new Map([
          ["e117", banner],
          ["e135", ""],
          ["e137", headline],
        ]),
        new Set(read.unnamed),
      ).map((element) => [element.ref, element.name]),
    );
    expect(listed.get("e137")).toBe(headline);
    expect(listed.get("e117")).toBe(banner);
    expect(listed.get("e135")).toBe("");
    expect(listed.get("e127")).toBe("헤드라인 뉴스 안내");
  });

  /**
   * The thumbnail beside each headline goes to the same article and holds nothing with a name: on
   * the live page it is `aria-hidden`, and the label hold refuses it as not actionable whatever it
   * is called (41 of 41 on 2026-10-04). It stays listed rather than dropped, which is a rule about
   * addresses this list does not make. What it is called is not decided here — every control the
   * tree left nameless is nameless in the tree's list — but by the page (`page-names.test.ts`
   * holds a link around an image with no alt text to the browser's name for it: none).
   */
  test("the thumbnail link beside a headline stays a line of its own", () => {
    const { elements } = parseAriaSnapshot(NAVER_NEWS);
    expect(elements.map((element) => element.ref)).toEqual([
      "e117",
      "e120",
      "e127",
      "e135",
      "e137",
      "e144",
      "e152",
      "e154",
      "e161",
    ]);
  });

  /*
   * NOT GUESSED FROM WHAT IS BENEATH IT. Each of these was named by its words once — text, a
   * child's text, a child's own name, words nested through wrappers, one space apart — and each of
   * those names was the tree's spelling, which is not the browser's. Here they are what the tree
   * says of them: a control, and no name. An address, a placeholder and a frame's contents were
   * never part of one.
   */
  test("whatever is beneath it — text, a child's text, a child's own name — gives it no name here", () => {
    const yaml = `- link [ref=e1] [cursor=pointer]:
  - /url: https://example.test/a
  - strong [ref=e2]: 대출 더 조이면 누가 영향받나
- link [ref=e3] [cursor=pointer]:
  - /url: https://example.test/b
  - img "프리미엄콘텐츠 바로가기" [ref=e4]
- button [ref=e5]:
  - text: 장바구니
  - generic [ref=e6]: "3"
- link [ref=e7]:
  - /url: https://example.test/c
  - heading "공지사항" [level=3] [ref=e8]:
    - strong [ref=e9]: 공지사항
- link [ref=e10]:
  - /url: /news/1
  - generic [ref=e11]:
    - emphasis [ref=e12]: 동영상뉴스
    - generic [ref=e13]:
      - strong [ref=e14]: "반세기 만에 '역수출'"
      - text: "  세계 시장 주도  "
- link [ref=e15]:
  - /url: https://example.test/very/long/address
  - /placeholder: 검색어
  - iframe [ref=e16]:
    - button "프레임 안" [ref=f1e1]
  - text: 바로가기`;
    const read = readAriaSnapshot(yaml);
    expect(read.elements).toEqual([
      { ref: "e1", role: "link", name: "" },
      { ref: "e3", role: "link", name: "" },
      { ref: "e5", role: "button", name: "" },
      { ref: "e7", role: "link", name: "" },
      { ref: "e10", role: "link", name: "" },
      { ref: "e15", role: "link", name: "" },
      // A control inside one is still a line of its own, under the name the tree printed for it.
      { ref: "f1e1", role: "button", name: "프레임 안" },
    ]);
    expect(read.unnamed).toEqual(["e1", "e3", "e5", "e7", "e10", "e15"]);
  });

  test("a printed name is the name: what is beneath it is not added", () => {
    const yaml = `- link "댓글 개수 10 이상 +" [ref=e1]:
  - /url: /comments
  - generic [ref=e2]: "10+"`;
    expect(parseAriaSnapshot(yaml).elements[0]?.name).toBe(
      "댓글 개수 10 이상 +",
    );
  });

  /**
   * A control with nothing beneath it that could name it is asked about like any other: whether it
   * has a name is the page's to say, and for a link holding only an image with no alt text the page
   * says none (`page-names.test.ts`, where that decision can fail). Not borrowed from a neighbour
   * or from the address here, which the browser would call a rename on the click.
   */
  test("a link holding only an image without alt text, or nothing at all, is one the page is asked about", () => {
    const yaml = `- link [ref=e1] [cursor=pointer]:
  - /url: https://example.test/thumb
- link [ref=e2]:
  - /url: https://example.test/thumb
  - img [ref=e3]
- button [ref=e4]`;
    expect(readAriaSnapshot(yaml).unnamed).toEqual(["e1", "e2", "e4"]);
  });

  /*
   * NEVER ITS CONTENTS AS A VALUE. What the tree writes after the colon of a link or a button it
   * printed without a name is what is inside that control — its words, and where what is inside
   * can be edited, what a person typed there. The name of such a control is the page's to give
   * (`page-names.ts`, which leaves every field and editable region out), or nothing; handed on as
   * a `value`, the same contents would reach the model and the trail beside that name whatever the
   * page answered. Held for every role named by its contents, through the list the look hands on
   * (`withNames`) with the page answering and with it silent — and only for those: a control the
   * tree named keeps what is written after it, and so does a field.
   */
  test("a nameless control of a role named by its contents never hands those contents on as a value", () => {
    const typed = "hunter2!SuperSecret";
    const roles = [
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
    ];
    const yaml = [
      ...roles.map((role, index) => `- ${role} [ref=e${index}]: ${typed}`),
      // The same shape in ordinary words. Playwright writes one run of text beneath a control
      // after its colon, and drops it when it is the control's own name, printed or not: so this
      // is a control whose name it did not print, over text that differs from that name.
      "- button [ref=e20]: 다음",
      "- link [ref=e21] [cursor=pointer]: 대출 더 조이면 누가 영향받나",
      // Named by the tree, and a field: what is after the colon is theirs to say.
      '- button "장바구니" [ref=e30]: "3"',
      "- searchbox [ref=e31]: 무선 마우스",
    ].join("\n");
    const read = readAriaSnapshot(yaml);
    const nameless = [...roles.map((_, index) => `e${index}`), "e20", "e21"];
    expect(read.unnamed).toEqual(nameless);
    for (const element of read.elements) {
      if (!nameless.includes(element.ref)) continue;
      expect([element.ref, "value" in element]).toEqual([element.ref, false]);
    }
    // Silent, the page leaves each with no name; answering, with its own. Neither brings a value.
    const silent = withNames(read.elements, new Map(), new Set(read.unnamed));
    const answered = withNames(
      read.elements,
      new Map(nameless.map((ref) => [ref, "이름"])),
      new Set(read.unnamed),
    );
    for (const listed of [silent, answered]) {
      const written = JSON.stringify(listed);
      expect(written).not.toContain(typed);
      expect(written).not.toContain("다음");
      expect(written).not.toContain("대출");
      expect(
        listed.filter((element) => "value" in element).map(({ ref }) => ref),
      ).toEqual(["e30", "e31"]);
    }
    expect(silent.find((element) => element.ref === "e20")).toEqual({
      ref: "e20",
      role: "button",
      name: "",
    });
    expect(silent.find((element) => element.ref === "e30")).toEqual({
      ref: "e30",
      role: "button",
      name: "장바구니",
      value: "3",
    });
    expect(silent.find((element) => element.ref === "e31")?.value).toBe(
      "무선 마우스",
    );
  });

  /*
   * And beneath it, where the tree prints the contents as lines of their own: the shapes the
   * reviews of pull requests 65 and 69 were about — a nameless button around an unnamed search box
   * was named by what had been typed into the box, and a link around text that can be edited would
   * have been by what was typed there. Nothing after the colon is a string in these, so nothing is a
   * value; what must hold is that the control around a field or an editable region carries what
   * was typed in neither its name nor a value, with the page silent. A field's own label is not
   * borrowed either: the page is asked.
   */
  test("nor does the control around a field, or around text that can be edited, carry what was typed there", () => {
    const typed = "hunter2!SuperSecret";
    const yaml = `- button [ref=e1]:
  - textbox [ref=e2]: ${typed}
- link [ref=e3]:
  - generic [ref=e4]: ${typed}
  - text: 열기
- link [ref=e5]:
  - text: 검색
  - searchbox [ref=e6]: ${typed}
  - text: 하기
- link [ref=e7]:
  - text: 그대로
- button [ref=e8]:
  - textbox "검색어" [ref=e9]: ${typed}
- button [ref=e10]:
  - slider [ref=e11]: "73"`;
    const read = readAriaSnapshot(yaml);
    expect(read.unnamed).toEqual(["e1", "e3", "e5", "e7", "e8", "e10"]);
    const silent = withNames(read.elements, new Map(), new Set(read.unnamed));
    const around = silent.filter((element) =>
      read.unnamed.includes(element.ref),
    );
    expect(around).toEqual([
      { ref: "e1", role: "button", name: "" },
      { ref: "e3", role: "link", name: "" },
      { ref: "e5", role: "link", name: "" },
      { ref: "e7", role: "link", name: "" },
      { ref: "e8", role: "button", name: "" },
      { ref: "e10", role: "button", name: "" },
    ]);
    // The fields themselves are lines of their own, and say what is in them unless it is a secret.
    expect(silent.find((element) => element.ref === "e2")?.value).toBe(typed);
    expect(silent.find((element) => element.ref === "e11")?.value).toBe("73");
    const marked = readAriaSnapshot(yaml, { refs: ["e2", "e6", "e9"] });
    expect(
      JSON.stringify(
        withNames(marked.elements, new Map(), new Set(marked.unnamed)),
      ),
    ).not.toContain(typed);
  });

  /**
   * NEVER A VALUE INTO A NAME. What sits under a textbox is what is typed in it, and a password box
   * is a textbox: its contents as its label would undo everything `computer_request_secret` keeps.
   */
  test("a field's contents never become its name", () => {
    const secret = "hunter2!SuperSecret";
    const yaml = `- textbox [ref=e1]: ${secret}
- searchbox [ref=e2]: 무선 마우스
- combobox [ref=e3]:
  - option "서울" [selected] [ref=e4]
- spinbutton [ref=e5]: "482913"`;
    const { elements, unnamed } = readAriaSnapshot(yaml, { refs: ["e1"] });
    expect(elements.map((element) => element.name)).toEqual([
      "",
      "",
      "",
      "서울",
      "",
    ]);
    expect(JSON.stringify(elements)).not.toContain(secret);
    // Nor is the page asked to name one: its name is the tree's, or none.
    expect(unnamed).toEqual([]);
  });
});

/**
 * The page is asked for the name of every control the tree printed without one (`page-names.ts`),
 * and what it answers is the name the list says. Where it does not answer, the list says none.
 */
describe("the names the page gives the controls the tree left nameless", () => {
  test("the controls asked about are the nameless ones of a role named by its contents", () => {
    const yaml = `- link "이름 있음" [ref=e1]:
  - /url: /a
- link [ref=e2]:
  - /url: /b
  - strong [ref=e3]: 헤드라인
- button [ref=e4]
- textbox [ref=e5]: 입력한 값
- checkbox [ref=e6]:
  - text: 동의
- combobox [ref=e7]`;
    expect(readAriaSnapshot(yaml).unnamed).toEqual(["e2", "e4", "e6"]);
    // The list itself is the one `parseAriaSnapshot` gives.
    expect(readAriaSnapshot(yaml).elements).toEqual(
      parseAriaSnapshot(yaml).elements,
    );
  });

  test("and only those the list keeps: a control cut from the list is not asked about", () => {
    const lines = [
      ...buttonsAt(1, 150, 900),
      ...Array.from(
        { length: 100 },
        (_, index) =>
          `- link [ref=n${index}] [cursor=pointer] [box=10,100,80,20]:\n  - text: 링크 ${index}`,
      ),
      "- link [ref=below] [box=10,2000,80,20]:\n  - text: 아래",
    ];
    const read = readAriaSnapshot(lines.join("\n"), {}, VIEWPORT);
    expect(read.truncated).toBe(true);
    expect(read.unnamed).toHaveLength(100);
    expect(read.unnamed).not.toContain("below");
    const kept = new Set(read.elements.map((element) => element.ref));
    expect(read.unnamed.every((ref) => kept.has(ref))).toBe(true);
  });

  test("the page's name is the name the list says, cut like any other, and brings no value", () => {
    const yaml = `- link [ref=e1]:
  - /url: /a
  - text: ★
  - strong [ref=e2]: Headline
- button [ref=e3]: 다음
- link [ref=e4]:
  - text: 그대로`;
    const read = readAriaSnapshot(yaml);
    expect(read.elements.map((element) => element.name)).toEqual(["", "", ""]);
    const long = `${"가".repeat(199)}😀나`;
    const named = withNames(
      read.elements,
      new Map([
        ["e1", "Headline"],
        ["e3", long],
      ]),
    );
    expect(named).toEqual([
      { ref: "e1", role: "link", name: "Headline" },
      { ref: "e3", role: "button", name: "가".repeat(199) },
      // The page gave no name for this one, and nothing else does.
      { ref: "e4", role: "link", name: "" },
    ]);
    // The list it was given is not changed.
    expect(read.elements[0]?.name).toBe("");
  });

  /*
   * A CONTROL THE PAGE WAS ASKED ABOUT AND DID NOT ANSWER FOR IS LEFT NAMELESS. Nothing stands in
   * for the page's name. The words the tree prints beneath a control did once, and they cannot tell
   * an editable region from text — a plain `contenteditable` prints as `generic` — so as a name
   * they would have carried whatever was typed into one (review of pull request 69). Nameless, the hold
   * refuses the click as renamed: a refusal, never a secret on the trail. The tree's list has no
   * name for these controls to begin with, and the look says so again whatever list it is handed
   * (`asked`).
   */
  test("a control the page did not answer for has no name, so a typed secret cannot ride out as one", () => {
    const secret = "hunter2!SuperSecret";
    const read = readAriaSnapshot(`- link [ref=e1]:
  - generic [ref=e2]: ${secret}
  - text: 열기
- link [ref=e3]:
  - text: 그대로`);
    // The tree alone: no name, and nothing of what is beneath either link.
    expect(read.elements).toEqual([
      { ref: "e1", role: "link", name: "" },
      { ref: "e3", role: "link", name: "" },
    ]);
    expect(read.unnamed).toEqual(["e1", "e3"]);
    // The page answered for e3 and not for e1 (out of time, or the ref did not resolve).
    const named = withNames(
      read.elements,
      new Map([["e3", "그대로"]]),
      new Set(read.unnamed),
    );
    expect(named.map((element) => element.name)).toEqual(["", "그대로"]);
    expect(JSON.stringify(named)).not.toContain(secret);
    // And when the page answered nothing at all, every asked control is nameless.
    expect(
      withNames(read.elements, new Map(), new Set(read.unnamed)).map(
        (element) => element.name,
      ),
    ).toEqual(["", ""]);
    // The look's own rule, whatever it is handed: a name already on a control it asked about and
    // got no answer for does not go on.
    const carried = read.elements.map((element) => ({
      ...element,
      name: `${secret} 열기`,
    }));
    expect(
      withNames(carried, new Map(), new Set(read.unnamed)).map(
        (element) => element.name,
      ),
    ).toEqual(["", ""]);
  });

  test("an empty name from the page is a name: the browser calls that control nothing", () => {
    const read = readAriaSnapshot("- link [ref=e1]:\n  - text: 숨은 글자");
    expect(withNames(read.elements, new Map([["e1", ""]]))[0]?.name).toBe("");
  });

  /*
   * THE TREE NAMES A CONTROL OUT OF WHAT A PERSON TYPED, and prints that name itself: the link
   * around an editable region, the box whose `<label>` holds one, the button with one inside it
   * (measured 2026-10-05, `person-typing.ts`). On a tab a person typed into, the page is asked
   * about every control and says which names were drawn from the nodes they typed into. The tree
   * below is that tab's: `TYPED` is what the person typed.
   */
  const TYPED = "CANARY-typed-7391";
  const TYPED_INTO = `- link "링크 속 ${TYPED}" [ref=e1]:
  - /url: "#a"
- button "보내기" [ref=e2]
- button "이름 있는 버튼" [ref=e3]: ${TYPED}
- textbox "라벨 속 ${TYPED}" [ref=e4]: 봇이 쓴 값
- link [ref=e5]:
  - text: 그대로
- button "답 없는 버튼" [ref=e6]: ${TYPED}`;

  test("on a tab a person typed into: a name drawn from what they typed is the page's, any other the tree gave stands, and one the page did not answer for has none", () => {
    const read = readAriaSnapshot(TYPED_INTO);
    const asked = read.elements.map((element) => element.ref);
    const listed = namesToList(read.unnamed, asked, {
      names: new Map([
        ["e1", "링크 속"],
        ["e2", "보내기, 페이지가 부르는 대로"],
        ["e3", "이름 있는 버튼"],
        ["e4", "라벨 속"],
        ["e5", "그대로"],
      ]),
      drawn: new Set(["e1", "e3", "e4"]),
    });
    const list = withNames(read.elements, listed.names, listed.asked);
    expect(list).toEqual([
      { ref: "e1", role: "link", name: "링크 속" },
      // Not drawn from what they typed: the tree's name, whatever the page would call it.
      { ref: "e2", role: "button", name: "보내기" },
      // Drawn: the page's name, and what is inside it is not handed on as a value.
      { ref: "e3", role: "button", name: "이름 있는 버튼" },
      // A box's value is its own, and is blanked by the box, not by its name.
      { ref: "e4", role: "textbox", name: "라벨 속", value: "봇이 쓴 값" },
      // Left nameless by the tree: the page's name, as on any tab.
      { ref: "e5", role: "link", name: "그대로" },
      // Asked about and not answered for: no name, and nothing of what is inside it.
      { ref: "e6", role: "button", name: "" },
    ]);
    expect(JSON.stringify(list)).not.toContain(TYPED);
    // The page silent altogether: every control it was asked about is nameless, and none says it.
    const silent = namesToList(read.unnamed, asked, {
      names: new Map(),
      drawn: new Set(),
    });
    const blank = withNames(read.elements, silent.names, silent.asked);
    expect(blank.map((element) => element.name)).toEqual(Array(6).fill(""));
    expect(JSON.stringify(blank)).not.toContain(TYPED);
  });

  test("on a tab nobody typed into, only the nameless are asked about and a control the tree named is untouched", () => {
    const read = readAriaSnapshot(TYPED_INTO);
    const listed = namesToList(read.unnamed, read.unnamed, {
      names: new Map([["e5", "그대로"]]),
      drawn: new Set(),
    });
    expect([...listed.asked]).toEqual(["e5"]);
    const list = withNames(read.elements, listed.names, listed.asked);
    // The same objects, name and value: nothing about them was asked.
    for (const index of [0, 1, 2, 3, 5]) {
      expect(list[index]).toBe(read.elements[index] as (typeof list)[number]);
    }
    expect(list[4]).toEqual({ ref: "e5", role: "link", name: "그대로" });
  });
});

/** `count` buttons from `ref` up, each at `y` in a 1280×800 viewport. */
function buttonsAt(from: number, count: number, y: number): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      `- button "b${from + index}" [ref=e${from + index}] [cursor=pointer] [box=10,${y},80,20]`,
  );
}

const VIEWPORT = { width: 1280, height: 800 };

/**
 * Past the limit, what a person can see is kept first.
 *
 * Measured 2026-10-04: the first-200 cut dropped 16 of the 69 controls on Daum's screen, 11 of 61 on
 * a Naver search page and 9 of 98 on Naver news, and kept footer links far below the fold.
 */
describe("past the limit, the screen first", () => {
  test("everything on the screen is kept, then the rest from the top, handed back in page order", () => {
    // 150 below the fold, then 100 on the screen: the first-200 cut would keep 50 of the 100.
    const yaml = [
      ...buttonsAt(0, 150, 2_000),
      ...buttonsAt(150, 100, 300),
    ].join("\n");
    const { elements, truncated } = parseAriaSnapshot(yaml, {}, VIEWPORT);
    expect(truncated).toBe(true);
    expect(elements).toHaveLength(200);
    const kept = elements.map((element) => Number(element.ref.slice(1)));
    // All 100 on the screen, the first 100 of the rest, and page order throughout.
    expect(kept.filter((index) => index >= 150)).toHaveLength(100);
    expect(kept.filter((index) => index < 150)).toEqual(
      Array.from({ length: 100 }, (_, index) => index),
    );
    expect(kept).toEqual([...kept].sort((a, b) => a - b));
  });

  test("with more on the screen than the list holds, the first 200 of those", () => {
    const yaml = [...buttonsAt(0, 20, 5_000), ...buttonsAt(20, 230, 100)].join(
      "\n",
    );
    const kept = parseAriaSnapshot(yaml, {}, VIEWPORT).elements.map((element) =>
      Number(element.ref.slice(1)),
    );
    expect(kept).toEqual(Array.from({ length: 200 }, (_, index) => index + 20));
  });

  test("without a viewport, or without boxes, the cut is in page order as it was", () => {
    const boxed = [...buttonsAt(0, 150, 2_000), ...buttonsAt(150, 100, 300)];
    const plain = boxed.map((line) => line.replace(/ \[box=[^\]]*\]/, ""));
    for (const [yaml, viewport] of [
      [boxed.join("\n"), undefined],
      [plain.join("\n"), VIEWPORT],
    ] as const) {
      const kept = parseAriaSnapshot(yaml, {}, viewport).elements.map(
        (element) => element.ref,
      );
      expect(kept).toEqual(
        Array.from({ length: 200 }, (_, index) => `e${index}`),
      );
    }
  });

  test("a box only partly on the screen is on it; one beside it, or of no size, is not", () => {
    const yaml = [
      ...buttonsAt(0, 200, 3_000),
      '- link "걸친" [ref=e900] [box=1200,780,200,40]',
      '- link "오른쪽 밖" [ref=e901] [box=1280,100,50,20]',
      '- link "크기 없음" [ref=e902] [box=10,10,0,0]',
      '- link "위로 지나간" [ref=e903] [box=10,-60,50,20]',
    ].join("\n");
    const names = parseAriaSnapshot(yaml, {}, VIEWPORT).elements.map(
      (element) => element.name,
    );
    expect(names).toContain("걸친");
    for (const off of ["오른쪽 밖", "크기 없음", "위로 지나간"]) {
      expect(names).not.toContain(off);
    }
  });

  /**
   * A frame's boxes are measured from the frame's own corner (`getBoundingClientRect` in its
   * document), so a control at y=10 in a frame below the fold is below the fold, and one at y=900 in
   * a 200-pixel frame on the screen is scrolled out of the frame.
   */
  test("a control in a frame is placed by the frame, and clipped by it", () => {
    const yaml = [
      ...buttonsAt(0, 200, 3_000),
      "- iframe [ref=e900] [box=100,100,600,200]:",
      '  - button "프레임 안 보임" [ref=f1e1] [box=10,10,80,20]',
      '  - button "프레임 안 아래" [ref=f1e2] [box=10,900,80,20]',
      "- iframe [ref=e901] [box=100,1500,600,200]:",
      '  - button "아래 프레임" [ref=f2e1] [box=10,10,80,20]',
    ].join("\n");
    const names = parseAriaSnapshot(yaml, {}, VIEWPORT).elements.map(
      (element) => element.name,
    );
    expect(names).toContain("프레임 안 보임");
    expect(names).not.toContain("프레임 안 아래");
    expect(names).not.toContain("아래 프레임");
  });

  test("a box is read wherever Playwright writes it among the flags", () => {
    expect(
      parseDescriptor(
        'link "기사" [ref=e12] [cursor=pointer] [box=-4,120,640,24]',
      )?.flags.get("box"),
    ).toBe("-4,120,640,24");
    // And a frame it could not enter still counts with a box beside its ref.
    expect(opaqueFramesIn("- iframe [ref=e3] [box=0,0,300,250]")).toBe(1);
  });

  /**
   * A box a person typed a secret into is found again, once the page renames it, among the boxes
   * the list will show (`typedIntoRefs`). That search was the first 200 in page order: with the
   * screen first, a box on the screen past that point would be listed, contents and all, and never
   * searched.
   */
  test("the boxes searched for a typed secret are the boxes the list keeps", () => {
    const yaml = [
      ...buttonsAt(0, 210, 3_000),
      '- textbox "인증 칸" [ref=e900] [box=10,100,80,20]: 482913',
    ].join("\n");
    const listed = parseAriaSnapshot(yaml, {}, VIEWPORT)
      .elements.filter((element) => isTextEntryRole(element.role))
      .map((element) => element.ref);
    expect(listed).toEqual(["e900"]);
    expect(listedTextEntryRefs(yaml, VIEWPORT)).toEqual(listed);
    // What the search used to be, which this box was past.
    expect(listedTextEntryRefs(yaml)).toEqual([]);
  });

  test("a secret field kept for being on the screen still loses its value", () => {
    const yaml = [
      ...buttonsAt(0, 210, 3_000),
      '- textbox "비밀번호" [ref=e900] [box=10,100,80,20]: hunter2!SuperSecret',
    ].join("\n");
    const { elements, truncated } = parseAriaSnapshot(yaml, {}, VIEWPORT);
    expect(truncated).toBe(true);
    expect(elements.find((element) => element.ref === "e900")?.value).toBe("");
    expect(JSON.stringify(elements)).not.toContain("hunter2");
  });
});
