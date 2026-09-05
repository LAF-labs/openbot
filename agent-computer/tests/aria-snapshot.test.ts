import { describe, expect, test } from "bun:test";
import {
  isSecretLabel,
  parseAriaSnapshot,
  parseDescriptor,
} from "../src/aria-snapshot";

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
      parseAriaSnapshot(yaml, ["비밀번호"]).elements.map((e) => [e.ref, e]),
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
      parseAriaSnapshot(yaml, ["비밀번호"]).elements.map((e) => [e.ref, e]),
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
    const { elements } = parseAriaSnapshot(LOGIN, ["비밀번호"]);
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
    const written = JSON.stringify(parseAriaSnapshot(LOGIN, []).elements);
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
    expect(JSON.stringify(parseAriaSnapshot(many, []))).not.toContain(PASSWORD);
  });

  test("the labels that mean a secret, and the ones that do not", () => {
    for (const label of [
      "비밀번호",
      "비밀 번호 확인",
      "암호",
      "Password",
      "PASSCODE",
      "인증번호 6자리",
      "인증 번호",
      "일회용 비밀번호",
      "OTP",
      "카드번호",
      "카드 번호",
      "CVC",
      "cvv",
      "보안코드",
      "보안 코드",
    ]) {
      expect([label, isSecretLabel(label)]).toEqual([label, true]);
    }
    for (const label of [
      "아이디",
      "Customer name:",
      "검색",
      "주문번호",
      "우편번호",
    ]) {
      expect([label, isSecretLabel(label)]).toEqual([label, false]);
    }
  });
});
