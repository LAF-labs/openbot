import { afterEach, describe, expect, test } from "bun:test";
import {
  readScreenErrorReport,
  type ScreenErrorReport,
} from "../../shared/screen-errors";
import {
  configureScreenErrorReports,
  errorKind,
  fingerprintOf,
  listenForScreenErrors,
  reportScreenError,
  type ScreenErrorReporting,
  screenErrorReport,
  sendScreenErrorReport,
  stackLocations,
} from "../src/lib/support/screen-errors";
import { stubFetch } from "./support/fetch";

/**
 * WHAT THE APP TELLS ITS SERVER WHEN A PART OF THE SCREEN FAILS — AND WHAT IT NEVER DOES.
 *
 * An error's message quotes whatever the failing code was handed. So the error thrown here carries
 * a password and a Korean sentence somebody typed in every place an error can carry them — its
 * message, a stack whose header repeats the message and whose message has lines that look like
 * frames, a frame whose address has the password in its query, a `cause`, a property of its own —
 * and the body the app would post is taken from the real sender, byte for byte, and searched.
 */

const PASSWORD = "hunter2-canary";
const KOREAN = "사장님 리뷰에 답글 달아 줘 카나리아";
const CHANNEL_ID = "0f9c2d4e-7a1b-4c3d-9e8f-123456789abc";

/** A TypeError the way V8 (and Bun) prints one: the message first, then the frames. */
function poisoned(): TypeError {
  const message = `Invalid URL: 'https://shop.example/login?pw=${PASSWORD}' — ${KOREAN}\n    at fake (https://evil.example/${PASSWORD}.js:1:1)`;
  const error = new TypeError(message, { cause: { typed: PASSWORD } });
  error.stack = [
    `TypeError: ${message}`,
    `    at ChatTranscript (http://localhost:3610/src/components/channels/chat-transcript.tsx?t=1726:88:3)`,
    `    at renderWithHooks (http://localhost:3610/node_modules/.vite/deps/chunk-RPCDYKBN.js?v=5c1b:5580:22)`,
    `    at http://localhost:3610/channel/${CHANNEL_ID}?settings=true&pw=${PASSWORD}:10:5`,
    "    at async Promise.all (index 0)",
    "    at Array.map (<anonymous>)",
  ].join("\n");
  Object.assign(error, { input: `${PASSWORD} ${KOREAN}` });
  return error;
}

const CANARIES = [
  PASSWORD,
  "hunter2",
  KOREAN,
  "사장님",
  "카나리아",
  "Invalid URL",
  "shop.example",
  "evil.example",
  CHANNEL_ID,
  "settings=true",
  "chat-transcript",
  "localhost",
];

function reporting(
  overrides: Partial<ScreenErrorReporting> = {},
): ScreenErrorReporting & { bodies: string[] } {
  const bodies: string[] = [];
  return {
    bodies,
    route: () => "/channel/$channelId",
    build: async () => ({ version: "v0.5.1", revision: "eeea9853c2d1" }),
    surface: () => "shell",
    isSignedIn: () => true,
    // The real sender, over a fetch that keeps what it was handed: the body is the one that leaves.
    send: (report) =>
      sendScreenErrorReport(
        report,
        stubFetch(async (_url, init) => {
          bodies.push(String(init?.body));
          return new Response(null, { status: 204 });
        }),
      ),
    ...overrides,
  };
}

afterEach(() => {
  configureScreenErrorReports(null);
});

describe("the body the app would post", () => {
  test("holds neither the password nor the Korean sentence, wherever the error carried them", async () => {
    const setup = reporting();
    configureScreenErrorReports(setup);
    const error = poisoned();

    // Every canary is really in the error, or the search below proves nothing.
    const carried = JSON.stringify({
      message: error.message,
      stack: error.stack,
      cause: error.cause,
      input: (error as unknown as { input: string }).input,
    });
    expect(CANARIES.filter((canary) => !carried.includes(canary))).toEqual([]);

    const sent = await reportScreenError("transcript", error);
    expect(sent).not.toBeNull();
    expect(setup.bodies).toHaveLength(1);
    const body = setup.bodies[0] ?? "";

    expect(CANARIES.filter((canary) => body.includes(canary))).toEqual([]);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "build",
        "fingerprint",
        "kind",
        "revision",
        "route",
        "section",
        "surface",
      ].sort(),
    );
    expect(parsed).toMatchObject({
      section: "transcript",
      route: "/channel/$channelId",
      kind: "TypeError",
      build: "v0.5.1",
      revision: "eeea9853c2d1",
      surface: "shell",
    });
    expect(parsed.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    // And it is a report the server takes: the same file decides both.
    expect(readScreenErrorReport(parsed)).toEqual(
      parsed as unknown as ScreenErrorReport,
    );
  });

  test("an address, a build of the operator's own naming and a revision without a build are left out, not sent", () => {
    const report = screenErrorReport("main", new Error("x"), {
      route: `/channel/${CHANNEL_ID}`,
      build: { version: "my-own-tag", revision: "eeea9853c2d1" },
      surface: "browser",
    });
    expect(report).not.toHaveProperty("route");
    expect(report).not.toHaveProperty("build");
    expect(report).not.toHaveProperty("revision");
    expect(readScreenErrorReport(report)).not.toBeNull();

    // A query on a template is an address too.
    expect(
      screenErrorReport("main", new Error("x"), {
        route: "/settings/account?tab=delete",
        build: null,
        surface: "browser",
      }),
    ).not.toHaveProperty("route");
  });
});

describe("what is read from an error", () => {
  test("its constructor's name, or the nearest one that is a name and not a word", () => {
    class FeedbackRefusedError extends Error {}
    // What a production build makes of an app's own error class.
    class Qe extends Error {}
    // A class could be called anything. A password is not what a report calls an error.
    class Hunter2 extends TypeError {}
    expect(errorKind(new TypeError("x"))).toBe("TypeError");
    expect(errorKind(new FeedbackRefusedError("x"))).toBe(
      "FeedbackRefusedError",
    );
    expect(errorKind(new Qe("x"))).toBe("Error");
    expect(errorKind(new Hunter2("x"))).toBe("TypeError");
    expect(errorKind(new DOMException("x", "AbortError"))).toBe("DOMException");
    expect(errorKind("a string somebody threw")).toBe("string");
    expect(errorKind(null)).toBe("null");
    expect(errorKind(undefined)).toBe("undefined");
    expect(errorKind({ message: PASSWORD })).toBe("Object");
    expect(errorKind(Object.create(null))).toBe("Object");
  });

  test("where it was thrown: the file's name, line and column of the app's first frames, and nothing else", () => {
    // The dev server's dependency chunk is the framework's; the page's own address is no file.
    expect(stackLocations(poisoned())).toEqual(["chat-transcript.tsx:88:3"]);

    // JavaScriptCore — the Mac shell's webview — and Gecko name the frame before an `@`.
    const safari = new Error("x");
    safari.stack = [
      "BotSidebar@http://localhost:3610/assets/_app-Bq3kW9.js:3:14022",
      "renderWithHooks@http://localhost:3610/assets/vendor-react-Cx8a1.js:1:40991",
      "@http://localhost:3610/assets/index-D0e7.js:1:2345",
      "[native code]",
      `global code@blob:http://localhost:3610/${CHANNEL_ID}:1:1`,
    ].join("\n");
    expect(stackLocations(safari)).toEqual([
      "_app-Bq3kW9.js:3:14022",
      "index-D0e7.js:1:2345",
    ]);

    // Something React itself refused has no frame of the app's: its own first frames stand in.
    const refused = new Error("x");
    refused.stack = [
      "Error: x",
      "    at throwOnInvalidObjectType (http://h/assets/vendor-react-Cx8a1.js:1:900)",
      "    at reconcileChildFibers (http://h/assets/vendor-react-Cx8a1.js:1:1200)",
    ].join("\n");
    expect(stackLocations(refused)).toEqual([
      "vendor-react-Cx8a1.js:1:900",
      "vendor-react-Cx8a1.js:1:1200",
    ]);

    // Five frames, not the framework's thirty.
    const deep = new Error("x");
    deep.stack = [
      "Error: x",
      ...Array.from(
        { length: 30 },
        (_, index) => `    at f${index} (http://h/a.js:${index + 1}:1)`,
      ),
    ].join("\n");
    expect(stackLocations(deep)).toHaveLength(5);

    expect(stackLocations("a string has no stack")).toEqual([]);
  });

  test("a message that is not what the stack was made with does not reach the frames' digest as words", () => {
    const error = poisoned();
    // Changed after it was made: the header no longer matches, and its fake frame is read as one.
    error.message = "changed";
    const locations = stackLocations(error);
    expect(locations).toContain(`${PASSWORD}.js:1:1`);
    // Which is why only a digest leaves: twelve hex digits hold no word.
    const report = screenErrorReport("main", error, {
      route: "/",
      build: null,
      surface: "browser",
    });
    expect(JSON.stringify(report)).not.toContain(PASSWORD);
  });

  test("the fingerprint is the same for the same place and differs for another; the message never moves it", () => {
    const one = fingerprintOf("TypeError", ["a.tsx:1:2", "b.js:3:4"]);
    expect(one).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprintOf("TypeError", ["a.tsx:1:2", "b.js:3:4"])).toBe(one);
    expect(fingerprintOf("TypeError", ["a.tsx:1:3", "b.js:3:4"])).not.toBe(one);
    expect(fingerprintOf("RangeError", ["a.tsx:1:2", "b.js:3:4"])).not.toBe(
      one,
    );

    const first = poisoned();
    const second = poisoned();
    second.message = "something else entirely";
    second.stack = first.stack?.replace(first.message, second.message);
    const facts = { route: "/", build: null, surface: "browser" } as const;
    expect(screenErrorReport("main", second, facts).fingerprint).toBe(
      screenErrorReport("main", first, facts).fingerprint,
    );
  });

  test("one failure is one fingerprint whether React was drawing the part afresh or updating it", () => {
    // The two stacks the roster threw on 2026-09-18, the one line apart that React's own path makes.
    const at = (react: string) => {
      const error = new TypeError("x");
      error.stack = [
        "TypeError: x",
        "    at http://localhost:3610/src/components/app-sidebar/bot-sidebar.tsx:457:19",
        `    at ${react} (http://localhost:3610/node_modules/.vite/deps/react-dom_client.js?v=1:8795:19)`,
        "    at renderWithHooks (http://localhost:3610/node_modules/.vite/deps/react-dom_client.js?v=1:26484:18)",
        "    at BotSidebar (http://localhost:3610/src/components/app-sidebar/bot-sidebar.tsx:435:22)",
      ].join("\n");
      if (react === "mountMemo") {
        error.stack = error.stack.replace(":8795:19", ":8777:23");
      }
      return error;
    };
    expect(stackLocations(at("mountMemo"))).toEqual([
      "bot-sidebar.tsx:457:19",
      "bot-sidebar.tsx:435:22",
    ]);
    const facts = { route: "/", build: null, surface: "browser" } as const;
    expect(
      screenErrorReport("sidebar", at("mountMemo"), facts).fingerprint,
    ).toBe(screenErrorReport("sidebar", at("updateMemo"), facts).fingerprint);
  });
});

describe("how often, and when not at all", () => {
  test("one report per fingerprint per page load", async () => {
    const setup = reporting();
    configureScreenErrorReports(setup);
    const error = poisoned();
    expect(await reportScreenError("transcript", error)).not.toBeNull();
    expect(await reportScreenError("conversation", error)).toBeNull();
    expect(await reportScreenError("transcript", poisoned())).toBeNull();
    expect(await reportScreenError("sidebar", new RangeError("x"))).not.toBe(
      null,
    );
    expect(setup.bodies).toHaveLength(2);

    // A new page load — a new configuration — forgets what was sent.
    configureScreenErrorReports(setup);
    expect(await reportScreenError("transcript", error)).not.toBeNull();
    expect(setup.bodies).toHaveLength(3);
  });

  test("nothing is sent while nobody is signed in, and nothing breaks when the send does", async () => {
    const signedOut = reporting({ isSignedIn: () => false });
    configureScreenErrorReports(signedOut);
    expect(await reportScreenError("main", new Error("x"))).toBeNull();
    expect(signedOut.bodies).toEqual([]);

    configureScreenErrorReports(
      reporting({
        send: async () => {
          throw new Error("offline");
        },
        build: async () => {
          throw new Error("offline");
        },
      }),
    );
    expect(await reportScreenError("main", new Error("x"))).toBeNull();
  });

  test("the window's two events report what nothing on screen caught, and pass over what cannot be reported", async () => {
    const setup = reporting();
    configureScreenErrorReports(setup);
    const target = new EventTarget();
    const stop = listenForScreenErrors(target as unknown as Window);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

    // A cross-origin script or a ResizeObserver: an error event with no error in it.
    target.dispatchEvent(Object.assign(new Event("error"), { error: null }));
    // A deliberate cancel.
    target.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), {
        reason: new DOMException("aborted", "AbortError"),
      }),
    );
    await settle();
    expect(setup.bodies).toEqual([]);

    target.dispatchEvent(
      Object.assign(new Event("error"), { error: poisoned() }),
    );
    target.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), {
        reason: new RangeError(KOREAN),
      }),
    );
    await settle();
    const sections = setup.bodies.map(
      (body) => (JSON.parse(body) as { section: string }).section,
    );
    expect(sections.sort()).toEqual(["unhandled_rejection", "window_error"]);
    expect(setup.bodies.join("\n")).not.toContain("사장님");

    stop();
    target.dispatchEvent(
      Object.assign(new Event("error"), { error: new SyntaxError("x") }),
    );
    await settle();
    expect(setup.bodies).toHaveLength(2);
  });
});
