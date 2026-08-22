import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { handleShellLinks } from "../src/lib/notifications/shell-links";

/**
 * Which clicks the shell takes and which it leaves alone.
 *
 * The failure this prevents is silent in both directions: a link that opens nothing (what shipped
 * before the handler existed) and a link the handler swallows that the webview should have kept.
 */

type WindowWithTauri = typeof globalThis & { __TAURI__?: unknown };

const opened: string[] = [];
let stop: (() => void) | null = null;

function inShellWith(): void {
  (globalThis as WindowWithTauri).__TAURI__ = {
    core: {
      invoke: async (command: string, args: { url?: string }) => {
        if (command === "open_external" && args?.url) opened.push(args.url);
      },
    },
  };
}

/** A click the handler will see, with a real anchor as its target. */
function clickOn(
  anchor: { href: string; target?: string },
  over: Partial<MouseEvent> = {},
): boolean {
  const element = document.createElement("a");
  element.href = anchor.href;
  if (anchor.target) element.target = anchor.target;
  document.body.append(element);
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...over,
  });
  element.dispatchEvent(event);
  element.remove();
  return event.defaultPrevented;
}

/*
 * A real DOM, because the thing under test is a listener on `document` and the question it answers
 * is about a real click on a real anchor. happy-dom is registered here rather than globally: this
 * is the only suite that needs one, and a DOM installed for every test file would change what
 * `globalThis` means for the pure ones.
 */
beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(() => {
  stop?.();
  stop = null;
  opened.length = 0;
  (globalThis as WindowWithTauri).__TAURI__ = undefined;
});

describe("links inside the shell", () => {
  test("a _blank link goes to the browser instead of nowhere", () => {
    inShellWith();
    stop = handleShellLinks();
    expect(clickOn({ href: "https://wttr.in/Seoul", target: "_blank" })).toBe(
      true,
    );
    expect(opened).toEqual(["https://wttr.in/Seoul"]);
  });

  test("an ordinary in-app link is left to the router", () => {
    inShellWith();
    stop = handleShellLinks();
    expect(clickOn({ href: "https://laf.example/channel/a" })).toBe(false);
    expect(opened).toEqual([]);
  });

  test("a modified click is the person asking their platform for something", () => {
    inShellWith();
    stop = handleShellLinks();
    expect(
      clickOn(
        { href: "https://a.example", target: "_blank" },
        { metaKey: true },
      ),
    ).toBe(false);
    expect(opened).toEqual([]);
  });

  test("a non-web scheme is not handed out", () => {
    inShellWith();
    stop = handleShellLinks();
    expect(
      clickOn({ href: "mailto:someone@example.com", target: "_blank" }),
    ).toBe(false);
    expect(opened).toEqual([]);
  });

  test("in a browser tab nothing is installed and nothing changes", () => {
    stop = handleShellLinks();
    expect(clickOn({ href: "https://a.example", target: "_blank" })).toBe(
      false,
    );
    expect(opened).toEqual([]);
  });

  test("stopping removes the listener", () => {
    inShellWith();
    handleShellLinks()();
    expect(clickOn({ href: "https://a.example", target: "_blank" })).toBe(
      false,
    );
    expect(opened).toEqual([]);
  });
});
