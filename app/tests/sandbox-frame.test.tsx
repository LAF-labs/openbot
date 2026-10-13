import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SandboxedContent } from "../src/lib/copilot/sandbox-frame";
import { mount, unmountAll } from "./support/mount";

/**
 * THE FRAME A DEPLOYMENT'S OWN CARD IS DRAWN IN (`src/lib/copilot/sandbox-frame.tsx`).
 *
 * It runs HTML and JavaScript out of the database with a model's arguments, so what it is allowed
 * is the whole of its safety: one sandbox permission, no delegated feature, a document that is a
 * string and not an address, and no channel between it and the page. A browser enforces the
 * sandbox and happy-dom does not, so what is held here is that the frame ASKS for exactly that —
 * what the browser then refuses was measured on the running page, and the pull request that
 * brought this file says what was tried.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3114/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(unmountAll);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const frameModule = () => import("../src/lib/copilot/sandbox-frame");

const content = (over: {
  html?: string;
  css?: string;
  jsFunctions?: string;
}): SandboxedContent => ({
  html: [over.html ?? '<div id="t"></div>'],
  htmlComplete: true,
  css: over.css ?? "",
  cssComplete: true,
  jsFunctions: over.jsFunctions ?? "",
  jsFunctionsComplete: true,
  generating: false,
});

async function drawn(over: Parameters<typeof content>[0] = {}) {
  const { OpenGenerativeUIActivityRenderer } = await frameModule();
  const view = await mount(
    <OpenGenerativeUIActivityRenderer
      activityType="open-generative-ui"
      agent={null}
      content={content(over)}
      message={null}
    />,
  );
  return { view, frame: view.host.querySelector("iframe") };
}

describe("the frame's permissions", () => {
  test("it may run scripts and nothing else", async () => {
    const { frame } = await drawn();
    // Exactly this: `allow-same-origin` beside it would hand the card this page's cookies and
    // storage, `allow-top-navigation` the window, `allow-popups` a way out, `allow-forms` a post.
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
  });

  test("no browser feature is delegated to it", async () => {
    const { frame } = await drawn();
    expect(frame?.hasAttribute("allow")).toBe(true);
    expect(frame?.getAttribute("allow")).toBe("");
  });

  test("its document is a string of this page's writing, never an address", async () => {
    const { frame } = await drawn({ html: "<p>card</p>" });
    expect(frame?.hasAttribute("src")).toBe(false);
    expect(frame?.getAttribute("srcdoc")).toContain("<p>card</p>");
  });
});

describe("the page and the frame do not talk", () => {
  test("drawing a card adds no listener for messages, and posts none", async () => {
    const heard: string[] = [];
    const posted: unknown[] = [];
    const realListen = window.addEventListener.bind(window);
    const realPost = window.postMessage.bind(window);
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      heard.push(type);
      return (realListen as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof window.addEventListener;
    window.postMessage = ((...args: unknown[]) => {
      posted.push(args);
    }) as typeof window.postMessage;
    try {
      // The spy works: a listener added here is seen.
      window.addEventListener("message", () => {});
      expect(heard).toEqual(["message"]);
      heard.length = 0;

      const { view, frame } = await drawn({ jsFunctions: "window.x = 1;" });
      expect(frame).not.toBeNull();
      await view.settle(50);
      expect(heard.filter((type) => type === "message")).toEqual([]);
      expect(posted).toEqual([]);
    } finally {
      window.addEventListener = realListen;
      window.postMessage = realPost;
    }
  });

  test("a message that says it is the frame's changes nothing drawn", async () => {
    const { view, frame } = await drawn();
    const before = view.host.innerHTML;
    for (const data of [
      { type: "__ck_resize", height: 9000 },
      { type: "service-message", methodName: "iframeInitialized", callId: "1" },
      { type: "message", methodName: "anything", arguments: [], callId: "2" },
    ]) {
      window.dispatchEvent(
        new MessageEvent("message", {
          data,
          origin: "null",
          source: frame?.contentWindow ?? null,
        } as MessageEventInit),
      );
    }
    await view.settle(50);
    expect(view.host.innerHTML).toBe(before);
    expect((view.host.firstElementChild as HTMLElement).className).toContain(
      "h-[200px]",
    );
  });
});

describe("the document the frame is given", () => {
  test("the author's CSS goes at the end of the head, and the code is carried in a script at its start", async () => {
    const { sandboxDocument } = await frameModule();
    const page = sandboxDocument({
      html: ["<head><title>t</title></head><body><p>x</p></body>"],
      css: "p { color: red; }",
      jsFunctions: "window.__args = {};",
    });
    expect(page).toMatch(
      /^<head><script>\(function \(\) \{[\s\S]*\}\)\(\);<\/script><title>t<\/title><style>p \{ color: red; \}<\/style><\/head><body><p>x<\/p><\/body>$/,
    );
    expect(page).toContain('var code = "window.__args = {};";');
  });

  test("HTML with no head is given one, with the CSS in it", async () => {
    const { sandboxDocument } = await frameModule();
    expect(
      sandboxDocument({ html: ["<p>x</p>"], css: "p{}", jsFunctions: "" }),
    ).toMatch(
      /^<head><script>[\s\S]*<\/script><style>p\{\}<\/style><\/head><p>x<\/p>$/,
    );
    expect(
      sandboxDocument({ html: ["<p>", "x</p>"], css: "", jsFunctions: "" }),
    ).toMatch(/^<head><script>[\s\S]*<\/script><\/head><p>x<\/p>$/);
  });

  test("code that holds a closing script tag cannot end the script that carries it", async () => {
    const { sandboxDocument } = await frameModule();
    const code =
      'document.title = "</script><script>window.escaped = 1</script><!--";';
    const page = sandboxDocument({
      html: ["<p>x</p>"],
      css: "",
      jsFunctions: code,
    });
    if (page === null) throw new Error("no document");
    // One script opens and one closes: the carrier's.
    expect(page.match(/<script>/g)).toHaveLength(1);
    expect(page.match(/<\/script>/g)).toHaveLength(1);
    expect(page).not.toContain("<!--");
    // And what it carries is still the author's code, to the letter.
    const literal = /var code = (".*");\n/.exec(page)?.[1];
    expect(JSON.parse(literal ?? '""')).toBe(code);
  });

  test("a dollar sign in the code is carried as written", async () => {
    const { sandboxDocument } = await frameModule();
    const code = "var price = '$&' + `$1` + '$$';";
    const page = sandboxDocument({
      html: ["<p>x</p>"],
      css: "",
      jsFunctions: code,
    });
    const literal = /var code = (".*");\n/.exec(page ?? "")?.[1];
    expect(JSON.parse(literal ?? '""')).toBe(code);
  });

  test("the carrier hides overflow once the HTML is read, and runs the code once: at load, or soon after without it", async () => {
    const { sandboxDocument } = await frameModule();
    const page =
      sandboxDocument({
        html: ['<p id="p">x</p>'],
        css: "",
        jsFunctions:
          "window.ran = (window.ran || 0) + 1; window.stateAtRun = document.readyState;",
      }) ?? "";
    const carrier = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
    expect(carrier).toContain("var code =");

    // The carrier, run against a document that records what it is asked to do.
    const run = async (loadComes: boolean) => {
      const listeners: Record<string, () => void> = {};
      const appended: { tag: string; text: string }[] = [];
      const timers: { fn: () => void; ms: number }[] = [];
      const doc = {
        readyState: "loading",
        addEventListener: (type: string, fn: () => void) => {
          listeners[`document:${type}`] = fn;
        },
        createElement: (tag: string) => ({ tag, textContent: "" }),
        getElementsByTagName: () => [
          {
            appendChild: (el: { tag: string; textContent: string }) => {
              appended.push({ tag: el.tag, text: el.textContent });
            },
          },
        ],
      };
      const win = {
        addEventListener: (type: string, fn: () => void) => {
          listeners[`window:${type}`] = fn;
        },
      };
      new Function("document", "window", "setTimeout", carrier)(
        doc,
        win,
        (fn: () => void, ms: number) => timers.push({ fn, ms }),
      );
      // Nothing before the HTML is read.
      expect(appended).toEqual([]);
      listeners["document:DOMContentLoaded"]?.();
      expect(appended.map((el) => el.tag)).toEqual(["style"]);
      expect(appended[0]?.text).toBe(
        "html, body { overflow: hidden !important; }",
      );
      expect(timers.map((timer) => timer.ms)).toEqual([50]);
      // Whichever comes first runs it, there and then; the other finds it done.
      if (loadComes) listeners["window:load"]?.();
      else timers[0]?.fn();
      expect(appended.map((el) => el.tag)).toEqual(["style", "script"]);
      if (loadComes) timers[0]?.fn();
      else listeners["window:load"]?.();
      return appended;
    };
    for (const loadComes of [true, false]) {
      const appended = await run(loadComes);
      // The style first, then the code — once, whichever of the two called for it first.
      expect(appended.map((el) => el.tag)).toEqual(["style", "script"]);
      expect(appended[1]?.text).toBe(
        "window.ran = (window.ran || 0) + 1; window.stateAtRun = document.readyState;",
      );
    }
  });

  test("a card with no code of its own still hides its overflow, and runs nothing", async () => {
    const { sandboxDocument } = await frameModule();
    const page =
      sandboxDocument({ html: ["<p>x</p>"], css: "", jsFunctions: "" }) ?? "";
    const carrier = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
    const appended: string[] = [];
    let ready = () => {};
    const asked: string[] = [];
    new Function("document", "window", "setTimeout", carrier)(
      {
        addEventListener: (_type: string, fn: () => void) => {
          ready = fn;
        },
        createElement: (tag: string) => ({ tag, textContent: "" }),
        getElementsByTagName: () => [
          { appendChild: (el: { tag: string }) => appended.push(el.tag) },
        ],
      },
      { addEventListener: (type: string) => asked.push(type) },
      () => asked.push("timer"),
    );
    ready();
    expect(appended).toEqual(["style"]);
    expect(asked).toEqual([]);
  });
});

describe("what is not drawn", () => {
  test("no HTML is an empty box and no frame", async () => {
    const { view, frame } = await drawn({ html: "" });
    expect(frame).toBeNull();
    const { sandboxDocument } = await frameModule();
    expect(
      sandboxDocument({ html: [""], css: "p{}", jsFunctions: "1" }),
    ).toBeNull();
    expect((view.host.firstElementChild as HTMLElement).className).toContain(
      "bg-[#f5f5f5]",
    );
  });

  test("a head spelled another way is not drawn, as it was not", async () => {
    const { sandboxDocument } = await frameModule();
    expect(
      sandboxDocument({
        html: ['<head lang="ko"></head><p>x</p>'],
        css: "",
        jsFunctions: "",
      }),
    ).toBeNull();
    const { view, frame } = await drawn({ html: "<HEAD></HEAD><p>x</p>" });
    expect(frame).toBeNull();
    // The card's own space is kept: the box, with nothing in it.
    expect(view.host.firstElementChild?.children).toHaveLength(0);
    // And ordinary HTML beside it is drawn — the absence above is not everything's.
    expect((await drawn({ html: "<p>x</p>" })).frame).not.toBeNull();
  });
});
