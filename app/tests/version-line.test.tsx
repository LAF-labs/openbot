import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { VersionLine } from "../src/components/settings/version-line";
import {
  browserOf,
  describeBuild,
  platformOf,
  readBuild,
  supportLine,
} from "../src/lib/version";

/**
 * The version line under Settings and the help page.
 *
 * Before it, nothing on any surface said what was running (audit A7, S3-11): a support thread had
 * no first question to ask. The line draws two numbers from two places — the server's build from
 * `/api/version`, the shell's own from the Tauri global — and the two failure shapes are pinned
 * here because both are silent: a footer that shows a made-up version, and a footer that shows
 * nothing when it could have.
 */

const APP = join(import.meta.dir, "../src");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Global = typeof globalThis & {
  fetch: typeof fetch;
  __TAURI__?: unknown;
};
const originalFetch = globalThis.fetch;

/** The server's answer, or a failure shape. */
function serverAnswers(
  answer: { status: number; body?: unknown } | "unreachable",
): void {
  (globalThis as Global).fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.endsWith("/api/version")) throw new Error(`unexpected ${url}`);
    if (answer === "unreachable") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  (globalThis as Global).fetch = originalFetch;
  (globalThis as Global).__TAURI__ = undefined;
  // What `runningOn` put on the instance; the DOM's own answers are on the prototype underneath.
  Reflect.deleteProperty(navigator, "userAgent");
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("describing a build", () => {
  test("is the version, the short commit, and the channel only when it adds something", () => {
    expect(
      describeBuild({
        version: "v0.4.5",
        revision: "dba36c3f0c4b6b1e6b2b8a4d1f1e9c7d5a3b2c1d",
        channel: "stable",
      }),
    ).toBe("v0.4.5 (dba36c3) · stable");
    // `edge (dba36c3) · edge` would say the channel twice.
    expect(
      describeBuild({
        version: "edge",
        revision: "dba36c3f0c",
        channel: "edge",
      }),
    ).toBe("edge (dba36c3)");
    expect(describeBuild({ version: "source" })).toBe("source");
  });
});

describe("reading the build", () => {
  test("keeps the three named fields and drops anything else", async () => {
    serverAnswers({
      status: 200,
      body: { version: "v0.4.5", revision: "abc", channel: "stable", x: 1 },
    });
    await expect(readBuild()).resolves.toEqual({
      version: "v0.4.5",
      revision: "abc",
      channel: "stable",
    });
  });

  test("is null when the server could not say, in either way it fails", async () => {
    serverAnswers({ status: 500 });
    await expect(readBuild()).resolves.toBeNull();
    serverAnswers("unreachable");
    await expect(readBuild()).resolves.toBeNull();
    // A body with no version is not a version.
    serverAnswers({ status: 200, body: { revision: "abc" } });
    await expect(readBuild()).resolves.toBeNull();
  });
});

async function mounted() {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(VersionLine, {}),
      ),
    );
  });
  // Both queries resolve on microtasks; one settle is enough for a stubbed fetch.
  const settle = async (ms = 20) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };
  await settle();
  const copyButton = () => host.querySelector("button");
  return {
    settle,
    /** The version line itself, without the copy control beside it. */
    text: () => host.querySelector("p")?.textContent ?? "",
    everything: () => host.textContent ?? "",
    copyButton,
    copy: async () => {
      await act(async () => {
        copyButton()?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
      await settle();
    },
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

/** What the page believes it is running on, and a clipboard that remembers what it was given. */
function runningOn(userAgent: string, clipboard: "works" | "refuses") {
  const written: string[] = [];
  Object.defineProperty(navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async (text: string) => {
        if (clipboard === "refuses")
          throw new Error("Document is not focused.");
        written.push(text);
      },
    },
    configurable: true,
  });
  return written;
}

const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
/** What the shell's webview on a Mac says: WebKit, and no browser of its own. */
const MAC_SHELL =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

describe("the line", () => {
  test("draws the server's build in a browser tab, and nothing about a shell", async () => {
    serverAnswers({
      status: 200,
      body: { version: "v0.4.5", revision: "dba36c3f0c", channel: "stable" },
    });
    const page = await mounted();
    expect(page.text()).toBe("Version v0.4.5 (dba36c3) · stable");
    expect(page.text()).not.toContain("app");
    await page.unmount();
  });

  test("adds the shell's own version when there is a shell to ask", async () => {
    serverAnswers({
      status: 200,
      body: { version: "v0.4.5", revision: "dba36c3f0c", channel: "stable" },
    });
    (globalThis as Global).__TAURI__ = {
      app: { getVersion: async () => "0.2.0" },
    };
    const page = await mounted();
    expect(page.text()).toBe("Version v0.4.5 (dba36c3) · stable · app 0.2.0");
    await page.unmount();
  });

  test("draws no guess when the server could not say — and says it could not, with a way to ask again", async () => {
    /*
     * It drew nothing at all until 2026-09-18, which kept the guess off the screen and also every
     * sign that the line was missing: the footer simply lost its first fact, on the one screen a
     * person opens when something is wrong. No version is drawn still, and nothing to copy.
     */
    serverAnswers("unreachable");
    const page = await mounted();
    expect(page.everything()).not.toMatch(/Version|v\d/);
    expect(page.everything()).toContain("The version could not be read.");
    expect(page.copyButton()?.textContent).toBe("Try again");
    await page.unmount();
  });

  test("a failed read asks again when pressed, and draws the build the answer brings", async () => {
    serverAnswers({ status: 500, body: { code: "laf:internal" } });
    const page = await mounted();
    expect(page.everything()).toContain("The version could not be read.");

    serverAnswers({
      status: 200,
      body: { version: "v0.5.1", revision: "dba36c3f0c", channel: "stable" },
    });
    // The line's one button is 다시 시도 while the read has failed.
    await page.copy();
    await page.settle();
    expect(page.text()).toBe("Version v0.5.1 (dba36c3) · stable");
    expect(page.copyButton()?.textContent).toBe("Copy");
    await page.unmount();
  });
});

/**
 * 복사: one line a person can paste to whoever runs the product, so the first reply to "it does not
 * work" is not "what are you running?". The product, the server's build, the shell's version when
 * there is a shell (and the browser when there is not), and the system — every part from the same
 * place the line on screen reads it, never typed by the person.
 */
describe("copying the version details", () => {
  test("puts the product, the build, the shell and the system on the clipboard, and says so", async () => {
    const written = runningOn(MAC_SHELL, "works");
    serverAnswers({
      status: 200,
      body: { version: "v0.5.1", revision: "dba36c3f0c", channel: "stable" },
    });
    (globalThis as Global).__TAURI__ = {
      app: { getVersion: async () => "0.2.0" },
    };
    const page = await mounted();
    expect(page.copyButton()?.textContent).toBe("Copy");
    expect(page.copyButton()?.getAttribute("aria-label")).toBe(
      "Copy version details",
    );

    await page.copy();
    expect(written).toEqual([
      "LAF Agent · server v0.5.1 (dba36c3) · stable · app 0.2.0 · macOS",
    ]);
    expect(page.copyButton()?.textContent).toBe("Copied to the clipboard");
    await page.unmount();
  });

  test("names the browser in a browser tab, where there is no shell to name", async () => {
    const written = runningOn(MAC_CHROME, "works");
    serverAnswers({ status: 200, body: { version: "edge" } });
    const page = await mounted();
    await page.copy();
    expect(written).toEqual([
      "LAF Agent · server edge · browser Chrome 128 · macOS",
    ]);
    await page.unmount();
  });

  test("a clipboard that refused says nothing was copied, because nothing was", async () => {
    const written = runningOn(MAC_CHROME, "refuses");
    serverAnswers({ status: 200, body: { version: "edge" } });
    const page = await mounted();
    await page.copy();
    expect(written).toEqual([]);
    expect(page.copyButton()?.textContent).toBe("Copy");
    await page.unmount();
  });
});

describe("what the page is running on", () => {
  test("the system, as a person names it", () => {
    for (const [agent, named] of [
      [MAC_CHROME, "macOS"],
      [MAC_SHELL, "macOS"],
      [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
        "Windows",
      ],
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
        "iOS",
      ],
      [
        "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
        "Android",
      ],
      [
        "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "ChromeOS",
      ],
      [
        "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
        "Linux",
      ],
      ["", null],
    ] as const) {
      expect({ agent, named: platformOf({ userAgent: agent }) }).toEqual({
        agent,
        named,
      });
    }
    // A browser that says outright is believed before its user-agent string is parsed.
    expect(
      platformOf({
        userAgent: MAC_CHROME,
        userAgentData: { platform: "Windows" },
      }),
    ).toBe("Windows");
  });

  test("the browser, by family and major version — the ones built on Chrome by their own names", () => {
    for (const [agent, named] of [
      [MAC_CHROME, "Chrome 128"],
      [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Whale/3.27.254.15 Safari/537.36",
        "Whale 3",
      ],
      [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
        "Edge 128",
      ],
      [
        "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
        "Samsung Internet 25",
      ],
      [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
        "Safari 17",
      ],
      [
        "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
        "Firefox 130",
      ],
      // The shell's webview names no browser, and none is guessed for it.
      [MAC_SHELL, null],
    ] as const) {
      expect({ agent, named: browserOf({ userAgent: agent }) }).toEqual({
        agent,
        named,
      });
    }
  });

  test("the line, when neither the browser nor the system can be told", () => {
    expect(
      supportLine({
        product: "LAF Agent",
        build: { version: "edge" },
        shell: null,
        browser: null,
        platform: null,
      }),
    ).toBe("LAF Agent · server edge · browser · unknown system");
  });
});

describe("the line's place", () => {
  /** Where a person who has run out of ideas looks: Settings, and the help page. */
  test("sits in both footers", () => {
    for (const path of [
      "routes/_authed/settings/index.tsx",
      "components/help/help-page.tsx",
    ]) {
      const source = readFileSync(join(APP, path), "utf8");
      expect(source).toContain("<VersionLine");
      // Under the legal links, inside the same footer, so the two read as one block.
      expect(source.indexOf("<VersionLine")).toBeGreaterThan(
        source.indexOf("<LegalLinks"),
      );
    }
  });
});
