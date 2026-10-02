import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Browser, chromium, type Page } from "playwright";
import {
  type InputMessage,
  keyEventOf,
  startScreencast,
} from "../src/screencast";

/**
 * WHAT A PERSON TYPES ON THE BOT'S PAGE IS WHAT ARRIVES THERE.
 *
 * Three defects in the take-over keyboard, found 2026-10-02 by reading what upstream OpenBot had
 * fixed since this fork left it (#422, #477) and then measuring ours against Chromium 151:
 *
 *   1. Seven written characters were other keys. A one-character key was sent as its code point,
 *      and `.` is Delete's, `'` the right arrow's, `# $ % & (` End's, Home's and the arrows' — with
 *      Shift held, which selects. `kim.lee@naver.com` arrived as `kimlee@navercom` and `Pa$$w0rd!`
 *      as `w0rd!`, in a box that shows dots.
 *   2. `!` and `"` were Page Up and Page Down, and looked right only because a one-line box does
 *      not page.
 *   3. Enter was heard and not acted on: no form was sent by it and no line broken.
 *
 * The first half of this file is the mapping itself, which runs anywhere. The second is the
 * measurement, against Chrome, through the same door a person's keystroke comes in by — with
 * Playwright's own keyboard as the witness for which code a key has, so that the table here is
 * checked against something that is not a copy of it. Skipped where Playwright has no browser.
 */

const SHIFT = 8;

/** Where each written symbol is on the keyboard, and whether Shift is what makes it. */
const PLAIN: Record<string, string> = {
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  " ": "Space",
};
const SHIFTED: Record<string, string> = {
  "~": "Backquote",
  "!": "Digit1",
  "@": "Digit2",
  "#": "Digit3",
  $: "Digit4",
  "%": "Digit5",
  "^": "Digit6",
  "&": "Digit7",
  "*": "Digit8",
  "(": "Digit9",
  ")": "Digit0",
  _: "Minus",
  "+": "Equal",
  "{": "BracketLeft",
  "}": "BracketRight",
  "|": "Backslash",
  ":": "Semicolon",
  '"': "Quote",
  "<": "Comma",
  ">": "Period",
  "?": "Slash",
};

/** Every character a keyboard writes without an input method: `!` to `~`. */
const WRITTEN = Array.from({ length: 94 }, (_, index) =>
  String.fromCharCode(33 + index),
);

/** The keys that edit or move rather than write: no written character may arrive as one. */
const EDITING_CODES = [8, 9, 13, 27, 33, 34, 35, 36, 37, 38, 39, 40, 45, 46];

function placeOf(char: string): { code: string; shift: boolean } {
  if (/[a-z]/.test(char)) {
    return { code: `Key${char.toUpperCase()}`, shift: false };
  }
  if (/[A-Z]/.test(char)) return { code: `Key${char}`, shift: true };
  if (/[0-9]/.test(char)) return { code: `Digit${char}`, shift: false };
  const plain = PLAIN[char];
  if (plain) return { code: plain, shift: false };
  return { code: SHIFTED[char] ?? "", shift: true };
}

/**
 * One character as the surface sends it: the key down with its text, then up. `offered` is the
 * code a surface that has learned to say it sends along; without it, the message is the one every
 * surface sent until 2026-10-02.
 */
function strokes(char: string, offered?: number): InputMessage[] {
  const { code, shift } = placeOf(char);
  const modifiers = shift ? SHIFT : 0;
  const said = offered === undefined ? {} : { windowsVirtualKeyCode: offered };
  return [
    {
      type: "key",
      event: "down",
      key: char,
      code,
      text: char,
      modifiers,
      ...said,
    },
    { type: "key", event: "up", key: char, code, modifiers, ...said },
  ];
}

const press = (key: string, modifiers = 0): InputMessage[] => [
  { type: "key", event: "down", key, code: key, modifiers },
  { type: "key", event: "up", key, code: key, modifiers },
];

const down = (
  key: string,
  more: Partial<Extract<InputMessage, { type: "key" }>> = {},
) => keyEventOf({ type: "key", event: "down", key, code: "", ...more });

const CONTROL = 2;
const META = 4;
const ALT = 1;

/** A letter pressed under ⌘ or Control, as the surface sends it: with the letter as its text. */
const under = (bit: number, letter: string, more = 0): InputMessage => ({
  type: "key",
  event: "down",
  key: letter,
  code: `Key${letter.toUpperCase()}`,
  text: letter,
  windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0),
  modifiers: bit | more,
});

describe("a key message, as Chrome is handed it", () => {
  test("no written character is sent as a key that edits or moves", () => {
    const sent = WRITTEN.map((char) => ({
      char,
      code: down(char, { text: char }).windowsVirtualKeyCode,
    }));
    expect(sent.filter(({ code }) => EDITING_CODES.includes(code))).toEqual([]);
    // And every one of them has a key: none is sent as nothing.
    expect(sent.filter(({ code }) => code === 0)).toEqual([]);
  });

  test("a symbol is the key it sits on, and so is the one Shift makes of it", () => {
    const codeOf = (char: string) =>
      down(char, { text: char }).windowsVirtualKeyCode;
    // The seven that were other keys: Delete, the right arrow, End, Home, left, up and down.
    expect([".", "'", "#", "$", "%", "&", "("].map(codeOf)).toEqual([
      190, 222, 51, 52, 53, 55, 57,
    ]);
    // The two that were Page Up and Page Down.
    expect(["!", '"'].map(codeOf)).toEqual([49, 222]);
    // A pair shares its key.
    expect(codeOf("/")).toBe(codeOf("?"));
    expect(codeOf("[")).toBe(codeOf("{"));
    // Letters and digits were always their own, upper-cased.
    expect(["a", "A", "z", "0", "9", " "].map(codeOf)).toEqual([
      65, 65, 90, 48, 57, 32,
    ]);
  });

  test("the code the person's own browser gave the key is the one sent", () => {
    // A keyboard this table does not describe: the surface knows, and says.
    expect(
      down("é", { text: "é", windowsVirtualKeyCode: 50 }).windowsVirtualKeyCode,
    ).toBe(50);
    const sent = down(".", { text: ".", windowsVirtualKeyCode: 110 });
    expect(sent.windowsVirtualKeyCode).toBe(110);
    expect(sent.nativeVirtualKeyCode).toBe(110);
  });

  test("a number that is no key's is not believed", () => {
    // 229 is an input method's; Chrome's codes end at 255; the rest are not numbers of keys at all.
    for (const offered of [0, -1, 229, 256, 1052, 1.5, Number.NaN]) {
      expect(
        down(".", { text: ".", windowsVirtualKeyCode: offered })
          .windowsVirtualKeyCode,
      ).toBe(190);
    }
    // What arrives is whatever a socket carried: a string that reads like a number is not one.
    expect(
      down(".", {
        text: ".",
        windowsVirtualKeyCode: "46" as unknown as number,
      }).windowsVirtualKeyCode,
    ).toBe(190);
  });

  test("a character that is on no key of this keyboard is sent as no key, with its text", () => {
    // Its code point would be another key's, or none: `м` is 1052 and `é` is 201.
    for (const char of ["é", "м", "한"]) {
      expect(down(char, { text: char })).toMatchObject({
        type: "keyDown",
        text: char,
        windowsVirtualKeyCode: 0,
      });
    }
  });

  test("Enter going down carries a carriage return, so that a page acts on it", () => {
    expect(down("Enter", { code: "Enter" })).toEqual({
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      text: "\r",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: 0,
    });
  });

  test("Enter going up carries nothing it was not given", () => {
    const up = keyEventOf({
      type: "key",
      event: "up",
      key: "Enter",
      code: "Enter",
    });
    expect(up.type).toBe("keyUp");
    expect("text" in up).toBe(false);
  });

  test("a key that writes nothing is still a raw key down, with its code", () => {
    for (const [key, code] of [
      ["Backspace", 8],
      ["ArrowLeft", 37],
      ["Delete", 46],
      ["Shift", 16],
    ] as const) {
      const sent = down(key, { code: key });
      expect(sent.type).toBe("rawKeyDown");
      expect("text" in sent).toBe(false);
      expect(sent.windowsVirtualKeyCode).toBe(code);
    }
    // A key nobody listed is sent as itself and as no code, not refused.
    expect(down("F5", { code: "F5" })).toMatchObject({
      type: "rawKeyDown",
      windowsVirtualKeyCode: 0,
    });
  });

  test("a name that every object answers to is still no key", () => {
    // What names the key came over a socket. Looked up carelessly, `constructor` is a function and
    // `__proto__` an object, and either would have gone to Chrome as the key's number or its text.
    for (const name of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ]) {
      const sent = down(name, { code: name });
      expect(sent.type).toBe("rawKeyDown");
      expect(sent.windowsVirtualKeyCode).toBe(0);
      expect("text" in sent).toBe(false);
    }
  });
});

/*
 * A fourth defect, measured the same day in the image's own Chromium: a letter pressed under ⌘ was
 * typed. ⌘A on a box holding `abcd` left `abcda`.
 */
describe("a shortcut, as Chrome is handed it", () => {
  const key = (message: InputMessage, metaIsControl: boolean) =>
    keyEventOf(
      message as Extract<InputMessage, { type: "key" }>,
      metaIsControl,
    );

  test("⌘ is Control to a browser whose shortcut key is Control", () => {
    expect(
      key(
        {
          type: "key",
          event: "down",
          key: "Meta",
          code: "MetaLeft",
          windowsVirtualKeyCode: 91,
          modifiers: META,
        },
        true,
      ),
    ).toEqual({
      type: "rawKeyDown",
      key: "Control",
      code: "ControlLeft",
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
      modifiers: CONTROL,
    });
    // The letter under it: the same key, under Control, and writing nothing.
    expect(key(under(META, "a"), true)).toEqual({
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: CONTROL,
    });
    // ⌘⇧Z keeps its Shift.
    expect(key(under(META, "Z", 8), true).modifiers).toBe(CONTROL | 8);
    // And coming up, on the right-hand ⌘ as well, with nothing held any more.
    expect(
      key(
        {
          type: "key",
          event: "up",
          key: "Meta",
          code: "MetaRight",
          modifiers: 0,
        },
        true,
      ),
    ).toMatchObject({
      type: "keyUp",
      key: "Control",
      code: "ControlRight",
      windowsVirtualKeyCode: 17,
      modifiers: 0,
    });
  });

  test("and stays ⌘ where the browser's own shortcut key is ⌘", () => {
    const sent = key(under(META, "a"), false);
    expect(sent.modifiers).toBe(META);
    expect(
      key(
        {
          type: "key",
          event: "down",
          key: "Meta",
          code: "MetaLeft",
          modifiers: META,
        },
        false,
      ),
    ).toMatchObject({ key: "Meta", code: "MetaLeft", modifiers: META });
    // Either way the letter is not written.
    expect(sent.type).toBe("rawKeyDown");
    expect("text" in sent).toBe(false);
  });

  test("a letter under Control writes nothing; under AltGr, Alt or Shift it writes", () => {
    for (const metaIsControl of [true, false]) {
      const shortcut = key(under(CONTROL, "a"), metaIsControl);
      expect(shortcut.type).toBe("rawKeyDown");
      expect("text" in shortcut).toBe(false);
      expect(shortcut.modifiers).toBe(CONTROL);
      // Control and Alt together are AltGr on a Windows keyboard: `@` on a German one.
      expect(key(under(CONTROL | ALT, "@"), metaIsControl)).toMatchObject({
        type: "keyDown",
        text: "@",
      });
      // Option on a Mac writes too.
      expect(key(under(ALT, "å"), metaIsControl)).toMatchObject({
        type: "keyDown",
        text: "å",
      });
      expect(key(under(8, "A"), metaIsControl)).toMatchObject({
        type: "keyDown",
        text: "A",
      });
    }
  });

  test("Enter under Control still carries what a page acts on", () => {
    expect(
      key(
        {
          type: "key",
          event: "down",
          key: "Enter",
          code: "Enter",
          modifiers: CONTROL,
        },
        true,
      ),
    ).toMatchObject({ type: "keyDown", text: "\r", modifiers: CONTROL });
  });
});

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

let browser: Browser | null = null;

beforeAll(async () => {
  if (HAS_BROWSER) browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

type Heard = { key: string; keyCode: number };

/**
 * A page with a form's text box, a password box and two multi-line ones, that writes down every key.
 *
 * The form has a button, as a sign-in or a search has: with two boxes and none, Enter sends nothing
 * in any browser, and a test of Enter would be measuring that rule.
 */
async function writingPage(): Promise<Page> {
  const page = await (browser as Browser).newPage({
    viewport: { width: 800, height: 600 },
  });
  await page.setContent(
    `<body>
      <form onsubmit="window.sent += 1; return false">
        <input id="line"><input id="secret" type="password"><button>확인</button>
      </form>
      <textarea id="lines" rows="4"></textarea>
      <textarea id="chat" rows="4"></textarea>
      <script>
        window.sent = 0; window.heard = []; window.decided = 0;
        addEventListener("keydown", (e) => heard.push({ key: e.key, keyCode: e.keyCode }));
        // A message box that decides Enter for itself, as a chat page does.
        document.getElementById("chat").addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); window.decided += 1; }
        });
      </script>
    </body>`,
  );
  return page;
}

type Box = "line" | "secret" | "lines" | "chat";

/** Focus a box holding `value`, the caret at its end, and forget the keys heard so far. */
const startIn = (page: Page, box: Box, value = "") =>
  page.evaluate(
    ([id, text]) => {
      const el = document.getElementById(id as string) as HTMLInputElement;
      el.value = text as string;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      (window as unknown as { heard: Heard[] }).heard = [];
    },
    [box, value],
  );

const textIn = (page: Page, box: Box) =>
  page.evaluate(
    (id) => (document.getElementById(id) as HTMLInputElement).value,
    box,
  );

const heardBy = (page: Page) =>
  page.evaluate(() => (window as unknown as { heard: Heard[] }).heard);

const countOf = (page: Page, name: "sent" | "decided") =>
  page.evaluate(
    (key) => (window as unknown as Record<string, number>)[key],
    name,
  );

/** The addresses and passwords people type, each with characters that were other keys. */
const SAMPLES: [Box, string][] = [
  ["line", "kim.lee@naver.com"],
  ["line", "https://www.hometax.go.kr/"],
  ["line", `it's 50% (really) & "quoted" #1!`],
  ["secret", "Pa$$w0rd!"],
];

describe.skipIf(!HAS_BROWSER)("against Chrome itself", () => {
  test("a full stop sent as its code point is Delete to the page: what it used to be sent as", async () => {
    const page = await writingPage();
    const cast = await startScreencast(page, (_frame, ack) => ack());
    await startIn(page, "line");
    // 46 is `.`'s code point and Delete's code. Offered here because the table no longer says it.
    for (const message of [
      ...strokes("a"),
      ...strokes(".", 46),
      ...strokes("b"),
    ]) {
      await cast.send(message);
    }
    expect(await textIn(page, "line")).toBe("ab");
    await cast.stop();
    await page.close();
  }, 30_000);

  test("every written character arrives, as its own key, from a surface that names no code", async () => {
    const page = await writingPage();
    const cast = await startScreencast(page, (_frame, ack) => ack());

    // The witness: the code Chrome gives each character's key when Playwright's own keyboard presses it.
    const witnessed = new Map<string, number>();
    for (const char of WRITTEN) {
      await startIn(page, "line");
      await page.keyboard.press(char);
      const heard = (await heardBy(page)).filter((key) => key.key === char);
      witnessed.set(char, heard[0]?.keyCode ?? -1);
    }

    const wrong: string[] = [];
    for (const char of WRITTEN) {
      await startIn(page, "line");
      for (const message of [
        ...strokes("a"),
        ...strokes("b"),
        ...strokes(char),
        ...strokes("c"),
      ]) {
        await cast.send(message);
      }
      const value = await textIn(page, "line");
      const code = (await heardBy(page)).find(
        (key) => key.key === char,
      )?.keyCode;
      // Between two letters, so a key that moved, selected or deleted shows in what is left.
      if (value !== `ab${char}c` || code !== witnessed.get(char)) {
        wrong.push(
          `${char} -> ${value} as key ${code}, not ${witnessed.get(char)}`,
        );
      }
    }
    expect(wrong).toEqual([]);
    await cast.stop();
    await page.close();
  }, 120_000);

  test("an address and a password arrive as they were typed, with or without the code offered", async () => {
    const page = await writingPage();
    const cast = await startScreencast(page, (_frame, ack) => ack());
    for (const [box, sample] of SAMPLES) {
      await startIn(page, box);
      for (const char of sample) {
        for (const message of strokes(char)) await cast.send(message);
      }
      expect(await textIn(page, box)).toBe(sample);

      // And from a surface that says which key it was: the code a page on the person's own
      // computer would have been told, which Playwright's keyboard gives the same way.
      await startIn(page, box);
      for (const char of sample) {
        const offered = keyEventOf(
          strokes(char)[0] as never,
        ).windowsVirtualKeyCode;
        for (const message of strokes(char, offered)) await cast.send(message);
      }
      expect(await textIn(page, box)).toBe(sample);
    }
    await cast.stop();
    await page.close();
  }, 60_000);

  test("Enter sends the form a text box is in, once", async () => {
    const page = await writingPage();
    const cast = await startScreencast(page, (_frame, ack) => ack());
    await startIn(page, "line", "오늘 날씨");
    for (const message of press("Enter")) await cast.send(message);
    expect(await countOf(page, "sent")).toBe(1);
    // Sent, not written into: a one-line box holds no line break.
    expect(await textIn(page, "line")).toBe("오늘 날씨");
    await cast.stop();
    await page.close();
  }, 30_000);

  test("Enter breaks a line where lines are written, and Shift+Enter does too", async () => {
    const page = await writingPage();
    const cast = await startScreencast(page, (_frame, ack) => ack());
    await startIn(page, "lines", "first");
    for (const message of [
      ...press("Enter"),
      ...strokes("x"),
      ...press("Enter", SHIFT),
      ...strokes("y"),
    ]) {
      await cast.send(message);
    }
    expect(await textIn(page, "lines")).toBe("first\nx\ny");
    expect(await countOf(page, "sent")).toBe(0);
    await cast.stop();
    await page.close();
  }, 30_000);

  test("a page that decides Enter for itself still does: nothing is written under it", async () => {
    const page = await writingPage();
    const cast = await startScreencast(page, (_frame, ack) => ack());
    await startIn(page, "chat", "보낼 말");
    for (const message of press("Enter")) await cast.send(message);
    expect(await countOf(page, "decided")).toBe(1);
    expect(await textIn(page, "chat")).toBe("보낼 말");
    // Its own Shift+Enter is a line, as the page meant.
    for (const message of press("Enter", SHIFT)) await cast.send(message);
    expect(await textIn(page, "chat")).toBe("보낼 말\n");
    expect(await countOf(page, "decided")).toBe(1);
    await cast.stop();
    await page.close();
  }, 30_000);

  test("the keys that edit still edit", async () => {
    const page = await writingPage();
    const cast = await startScreencast(page, (_frame, ack) => ack());
    await startIn(page, "line", "abcdef");
    for (const message of [
      ...press("Backspace"),
      ...press("ArrowLeft"),
      ...strokes("X"),
      ...press("Delete"),
    ]) {
      await cast.send(message);
    }
    expect(await textIn(page, "line")).toBe("abcdX");
    await cast.stop();
    await page.close();
  }, 30_000);
});

/*
 * Only where the browser is the one the Bot has: Chromium on Linux. On a Mac, Chrome takes no
 * shortcut by key event, under either key.
 */
describe.skipIf(!HAS_BROWSER || process.platform !== "linux")(
  "a Mac's shortcuts, against the Bot's own Chrome",
  () => {
    /** ⌘ and a letter, as the surface sends them from a Mac: no keyup for the letter. */
    const command = (letter: string, more = 0): InputMessage[] => [
      {
        type: "key",
        event: "down",
        key: "Meta",
        code: "MetaLeft",
        windowsVirtualKeyCode: 91,
        modifiers: META,
      },
      under(META, letter, more),
      { type: "key", event: "up", key: "Meta", code: "MetaLeft", modifiers: 0 },
      {
        type: "key",
        event: "up",
        key: letter,
        code: `Key${letter.toUpperCase()}`,
      },
    ];

    test("⌘A selects everything, ⌘Z takes the last change back and ⌘⇧Z puts it back", async () => {
      const page = await writingPage();
      const cast = await startScreencast(page, (_frame, ack) => ack());
      await startIn(page, "line", "abc");
      for (const message of [...strokes("d"), ...command("z")]) {
        await cast.send(message);
      }
      expect(await textIn(page, "line")).toBe("abc");
      for (const message of command("Z", 8)) await cast.send(message);
      expect(await textIn(page, "line")).toBe("abcd");
      // Everything selected, so the next letter replaces it — and no `a` was written on the way.
      for (const message of [...command("a"), ...strokes("Z")]) {
        await cast.send(message);
      }
      expect(await textIn(page, "line")).toBe("Z");
      await cast.stop();
      await page.close();
    }, 30_000);

    test("⌘X cuts what ⌘A selected — and not out of a password box, which Chrome will not have", async () => {
      const page = await writingPage();
      const cast = await startScreencast(page, (_frame, ack) => ack());
      for (const box of ["line", "secret"] as const) {
        await startIn(page, box, "abcd");
        for (const message of [...command("a"), ...command("x")]) {
          await cast.send(message);
        }
        // Chrome's own rule, kept: what is in a password box cannot be cut or copied out of it.
        expect(await textIn(page, box)).toBe(box === "secret" ? "abcd" : "");
      }
      await cast.stop();
      await page.close();
    }, 30_000);
  },
);
