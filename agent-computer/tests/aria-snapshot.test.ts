import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isSecretLabel,
  isTextEntryRole,
  opaqueFramesIn,
  parseAriaSnapshot,
  parseDescriptor,
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
 * A control whose name the tree prints beneath it rather than beside it.
 *
 * Playwright 1.62's AI tree blanks the name of a node whose name came from children it also prints
 * (`removeRedundantNames`), so `<a href><strong>헤드라인</strong></a>` arrives as `link [ref=…]:` with
 * the headline one level down. The list read `e137 link` and nothing more on 85 of Naver news's 200
 * lines (2026-10-04) — 44 of them its headlines — and the label hold, judging the empty name against a
 * browser that calls each headline by its words, refused every click on one.
 */
describe("a name the tree prints beneath the control", () => {
  /** Captured from news.naver.com/section/101 on 2026-10-04; see the file's own header. */
  const NAVER_NEWS = readFileSync(
    join(import.meta.dir, "fixtures", "naver-news-headlines.yaml"),
    "utf8",
  );

  test("Naver's headlines are named by their headlines, as captured", () => {
    const byRef = new Map(
      parseAriaSnapshot(NAVER_NEWS).elements.map((element) => [
        element.ref,
        element.name,
      ]),
    );
    // Each of these read `e137 link` and nothing else before.
    expect(byRef.get("e137")).toBe(
      "LG전자 노사, 아동복지시설 봉사…가전 점검·AI 체험 지원",
    );
    expect(byRef.get("e154")).toBe(
      "19년간 팔지 못한 상업용지…LH 미매각 토지 21.9조원",
    );
    // An image link is named by its image's alt text.
    expect(byRef.get("e117")).toBe(
      "AI 뉴스 알고리즘 추천 알고리즘 궁금하다면? 바로가기",
    );
    // A link with a name of its own keeps it, and is not given its words a second time.
    expect(byRef.get("e127")).toBe("헤드라인 뉴스 안내");
    expect(byRef.get("e144")).toBe("14 개의 관련뉴스 더보기");
  });

  /**
   * The thumbnail beside each headline goes to the same article and holds nothing with a name: on
   * the live page it is `aria-hidden`, and the label hold refuses it as not actionable whatever it
   * is called (41 of 41 on 2026-10-04). It stays a nameless line rather than borrowing the
   * headline's name — the browser would then call it a rename — and stays listed rather than
   * dropped, which is a rule about addresses this list does not make.
   */
  test("the thumbnail link beside a headline stays nameless, and stays", () => {
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
    expect(elements.find((element) => element.ref === "e135")?.name).toBe("");
  });

  test("a link takes the words inside it: text, a child's text, a child's own name", () => {
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
    - strong [ref=e9]: 공지사항`;
    expect(
      parseAriaSnapshot(yaml).elements.map((element) => element.name),
    ).toEqual([
      "대출 더 조이면 누가 영향받나",
      "프리미엄콘텐츠 바로가기",
      "장바구니 3",
      // A child that has a name says that name, once: the name is already made of what is under it.
      "공지사항",
    ]);
  });

  test("words nested through nameless wrappers are found, in page order, one space apart", () => {
    const yaml = `- link [ref=e1]:
  - /url: /news/1
  - generic [ref=e2]:
    - emphasis [ref=e3]: 동영상뉴스
    - generic [ref=e4]:
      - strong [ref=e5]: "반세기 만에 '역수출'"
      - text: "  세계 시장 주도  "`;
    expect(parseAriaSnapshot(yaml).elements[0]?.name).toBe(
      "동영상뉴스 반세기 만에 '역수출' 세계 시장 주도",
    );
  });

  test("a printed name is the name: what is beneath it is not added", () => {
    const yaml = `- link "댓글 개수 10 이상 +" [ref=e1]:
  - /url: /comments
  - generic [ref=e2]: "10+"`;
    expect(parseAriaSnapshot(yaml).elements[0]?.name).toBe(
      "댓글 개수 10 이상 +",
    );
  });

  test("an address, a placeholder and a frame's contents are no part of a name", () => {
    const yaml = `- link [ref=e1]:
  - /url: https://example.test/very/long/address
  - /placeholder: 검색어
  - iframe [ref=e2]:
    - button "프레임 안" [ref=f1e1]
  - text: 바로가기`;
    const [link, inFrame] = parseAriaSnapshot(yaml).elements;
    expect(link?.name).toBe("바로가기");
    // The frame's own control is still listed on its own line.
    expect(inFrame?.name).toBe("프레임 안");
  });

  /**
   * DECIDED: an image with no alt text says nothing, so a link holding only one stays nameless. The
   * browser calls it nothing too — which is what the hold is asked about — and a name borrowed from
   * a neighbour, or from the address, would be refused as a rename on the click.
   */
  test("a link holding only an image without alt text, or nothing at all, stays nameless", () => {
    const yaml = `- link [ref=e1] [cursor=pointer]:
  - /url: https://example.test/thumb
- link [ref=e2]:
  - /url: https://example.test/thumb
  - img [ref=e3]
- button [ref=e4]`;
    expect(
      parseAriaSnapshot(yaml).elements.map((element) => element.name),
    ).toEqual(["", "", ""]);
  });

  test("text that became the name is not repeated as a value", () => {
    const { elements } = parseAriaSnapshot("- button [ref=e1]: 다음");
    expect(elements[0]).toEqual({ ref: "e1", role: "button", name: "다음" });
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
    const { elements } = parseAriaSnapshot(yaml, { refs: ["e1"] });
    expect(elements.map((element) => element.name)).toEqual([
      "",
      "",
      "",
      "서울",
      "",
    ]);
    expect(JSON.stringify(elements)).not.toContain(secret);
  });

  test("a name from inside is cut at its length between characters, like any other", () => {
    const long = `${"가".repeat(199)}😀나`;
    const { elements } = parseAriaSnapshot(
      `- link [ref=e1]:\n  - /url: /x\n  - strong [ref=e2]: ${long}`,
    );
    expect(elements[0]?.name).toBe("가".repeat(199));
    expect(elements[0]?.name.isWellFormed()).toBe(true);
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
