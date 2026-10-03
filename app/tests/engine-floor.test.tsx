/**
 * AN ENGINE TOO OLD TO RUN THE APP IS TOLD SO, IN PLACE OF THE APP.
 *
 * Measured 2026-10-03 on a production build whose `RegExp` threw for a look-behind, as a WebKit
 * older than Safari 16.4 does: a conversation that held a Bot's reply fell to "화면의 이 부분에
 * 예상하지 못한 문제가 생겼어요" as it opened, because the markdown reader builds such a pattern
 * for every reply. The page now asks the engine for that one thing before it starts, and where the
 * engine has not got it draws a sentence that says what to update (`lib/engine-floor.ts`).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { OldEngineScreen } from "../src/components/layout/old-engine-screen";
import { isEngineTooOld } from "../src/lib/engine-floor";
import { ko } from "../src/lib/i18n-ko";

const SOURCE = join(import.meta.dir, "..", "src");
const read = (relative: string) => readFileSync(join(SOURCE, relative), "utf8");

/** The engine's own `RegExp`, put back whatever a test does with it. */
const Engine = globalThis.RegExp;

/** Runs `work` on an engine with no look-behind: building one throws, as WebKit before 16.4 does. */
function withoutLookBehind<T>(work: () => T): T {
  function Old(pattern: string | RegExp, flags?: string): RegExp {
    const source = typeof pattern === "string" ? pattern : pattern.source;
    if (source.includes("(?<=") || source.includes("(?<!")) {
      throw new SyntaxError(
        "Invalid regular expression: invalid group specifier name",
      );
    }
    return flags === undefined
      ? new Engine(pattern)
      : new Engine(pattern, flags);
  }
  Old.prototype = Engine.prototype;
  globalThis.RegExp = Old as unknown as RegExpConstructor;
  try {
    return work();
  } finally {
    globalThis.RegExp = Engine;
  }
}

describe("whether the engine can run the app", () => {
  test("an engine that builds a look-behind runs it", () => {
    expect(isEngineTooOld()).toBe(false);
  });

  test("an engine that cannot is too old, and the question itself does not throw", () => {
    expect(withoutLookBehind(() => isEngineTooOld())).toBe(true);
    // The stand-in is such an engine and nothing more: every other pattern still builds.
    const ahead = "a(?=b)";
    expect(withoutLookBehind(() => new RegExp(ahead).test("ab"))).toBe(true);
    expect(isEngineTooOld()).toBe(false);
  });

  test("the question is built from a string: an old engine can read the file that asks it", () => {
    const code = read("lib/engine-floor.ts")
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    expect(code).toContain('new RegExp("(?<=a)b")');
    // As a literal it would be a syntax error for the whole file, on the engines this is for.
    expect(code).not.toMatch(/\/\(\?<[=!]/);
  });
});

describe("what is drawn in place of the app", () => {
  const sentences = [
    "An update is needed.",
    "This device's system is too old to show the app.",
    "On a Mac, update macOS and Safari in Software Update.",
    "On an iPhone or iPad, update iOS in Settings.",
    "Then open the app again.",
    "It needs Safari 16.4 or later (macOS 13.3, iOS 16.4).",
  ];

  test("says an update is needed, what to update, and what the app needs", () => {
    const drawn = renderToStaticMarkup(<OldEngineScreen />);
    for (const sentence of sentences) {
      expect(drawn).toContain(sentence.replaceAll("'", "&#x27;"));
    }
    expect(drawn).toContain('role="alert"');
    // Nothing to press: what brings the app back is done outside this window.
    expect(drawn).not.toContain("<button");
    expect(drawn).not.toContain("<a ");
  });

  test("in Korean: a Mac's update and a phone's, and the versions that have what is needed", () => {
    const [title, why, mac, phone, then, needs] = sentences.map(
      (key) => ko[key] ?? "",
    );
    expect(title).toBe("업데이트가 필요해요.");
    expect(why).toContain("오래돼서");
    for (const word of ["Mac", "소프트웨어 업데이트", "macOS", "Safari"]) {
      expect(mac).toContain(word);
    }
    for (const word of ["아이폰", "아이패드", "설정", "iOS"]) {
      expect(phone).toContain(word);
    }
    expect(then).toContain("다시 열어");
    for (const version of ["Safari 16.4", "macOS 13.3", "iOS 16.4"]) {
      expect(needs).toContain(version);
    }
  });

  test("uses only solid colours: an engine this old draws an opacity as the full colour", () => {
    const classes = [
      ...read("components/layout/old-engine-screen.tsx").matchAll(
        /className="([^"]+)"/g,
      ),
    ].flatMap((match) => (match[1] ?? "").split(/\s+/));
    expect(classes.length).toBeGreaterThan(8);
    expect(classes.filter((name) => name.includes("/"))).toEqual([]);
  });
});

describe("the page's entry", () => {
  const entry = read("main.tsx");
  const at = (text: string) => {
    const index = entry.indexOf(text);
    expect(index).toBeGreaterThan(-1);
    return index;
  };

  test("asks before anything of the app starts, and starts the app only where it runs", () => {
    const asked = at("if (isEngineTooOld()) {");
    const told = at("<OldEngineScreen />");
    const started = at("startApp(rootElement);");
    const app = at("function startApp(");
    expect(asked).toBeLessThan(told);
    expect(told).toBeLessThan(started);
    expect(started).toBeLessThan(app);
    // Everything that watches, listens or asks the server is the app's, and inside its start.
    for (const call of [
      "watchSession();",
      "configureScreenErrorReports({",
      "listenForScreenErrors();",
      "listenForStaleChunks();",
      "ignoreStrayDrops();",
      "<RouterProvider",
    ]) {
      expect(at(call)).toBeGreaterThan(app);
    }
  });
});
