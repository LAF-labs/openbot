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
import { describeBuild, readBuild } from "../src/lib/version";

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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return {
    text: () => host.textContent ?? "",
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

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

  test("draws nothing rather than a guess when the server could not say", async () => {
    serverAnswers("unreachable");
    const page = await mounted();
    expect(page.text()).toBe("");
    await page.unmount();
  });

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
