import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactElement } from "react";
import {
  readScreenErrorReport,
  type ScreenErrorReport,
} from "../../shared/screen-errors";
import { mount, unmountAll } from "./support/mount";

/**
 * A PAGE FROM BEFORE A DEPLOY, AND A FAILURE THAT IS NOT THE SCREEN'S (P1: G6, G7).
 *
 * After `IMAGE_TAG` moves, a window left open asks for route chunks the new build does not have;
 * it must reload into the new build once, keep what was typed, and never loop. And a dropped
 * connection or such a chunk must be said calmly and not reported as the screen breaking — while
 * everything else is still reported as it always was, in facts and never in words.
 */

const PASSWORD = "hunter2-canary";

let consoleError: ReturnType<typeof spyOn> | undefined;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(async () => {
  await unmountAll();
  consoleError?.mockRestore();
  consoleError = undefined;
  const { configureBuildReload } = await import("../src/lib/build-reload");
  const { configureScreenErrorReports } = await import(
    "../src/lib/support/screen-errors"
  );
  configureBuildReload(null);
  configureScreenErrorReports(null);
});

/** React prints every error a boundary catches; these tests throw on purpose. */
function quietly() {
  consoleError = spyOn(console, "error").mockImplementation(() => {});
}

/** A tab's `sessionStorage`, which outlives the reload and nothing else. */
function tabStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, String(value));
    },
  };
}

/** The page's side of a reload: the server's build, a count of reloads, and the tab's storage. */
async function page(
  build: { version: string; revision?: string } | null = {
    version: "v0.5.6",
    revision: "abc1234",
  },
  storage: Storage | null = tabStorage(),
) {
  const reloader = await import("../src/lib/build-reload");
  const state = { build, reloads: 0 };
  reloader.configureBuildReload({
    readBuild: async () => state.build,
    reload: () => {
      state.reloads += 1;
    },
    storage: () => storage,
  });
  return { reloader, state, storage };
}

/** Reports as they would be posted, through the real reporter. */
async function reports() {
  const module = await import("../src/lib/support/screen-errors");
  const sent: ScreenErrorReport[] = [];
  module.configureScreenErrorReports({
    route: () => "/routines",
    build: async () => ({ version: "v0.5.6", revision: "abc1234" }),
    surface: () => "shell",
    isSignedIn: () => true,
    send: async (report) => {
      sent.push(report);
    },
  });
  return { module, sent };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a chunk that could not be loaded", () => {
  test("is recognised in each engine's words, and nothing else is taken for one", async () => {
    const { isChunkLoadError } = await import("../src/lib/build-reload");
    for (const error of [
      new TypeError(
        "Failed to fetch dynamically imported module: https://app.test/assets/routines-Bq1.js",
      ),
      new TypeError(
        "error loading dynamically imported module: https://app.test/assets/routines-Bq1.js",
      ),
      new TypeError("Importing a module script failed."),
      new Error("Unable to preload CSS for /assets/routines-Bq1.css"),
    ]) {
      expect(isChunkLoadError(error)).toBe(true);
    }
    for (const error of [
      new TypeError("Failed to fetch"),
      new Error("x"),
      null,
      "Importing a module script failed",
    ]) {
      expect(isChunkLoadError(error)).toBe(false);
    }
  });
});

describe("the reload into a new build", () => {
  test("happens once per build, keeps what was typed, and not again for the same build", async () => {
    const { reloader, state, storage } = await page();
    const release = reloader.holdDraft("channel-1", "내일 매출 정리해 줘");

    const decided = reloader.recoverFromStaleBuild();
    /*
     * The order measured in a real deploy: the route that failed is committed while the server is
     * asked for its build, and the conversation's composer unmounts and lets go of its text.
     */
    release();
    expect(await decided).toBe("reloading");
    expect(state.reloads).toBe(1);
    expect(reloader.staleBuildState()).toBe("reloading");

    // The page that loads next: same tab, same storage, nothing else.
    reloader.configureBuildReload({
      readBuild: async () => state.build,
      reload: () => {
        state.reloads += 1;
      },
      storage: () => storage,
    });
    expect(reloader.takeKeptDraft("channel-2")).toBeNull();
    expect(reloader.takeKeptDraft("channel-1")).toBe("내일 매출 정리해 줘");
    // Handed back once.
    expect(reloader.takeKeptDraft("channel-1")).toBeNull();

    // The new build's own chunk fails too: a broken build. It stops, and says so.
    expect(await reloader.recoverFromStaleBuild()).toBe("stale");
    expect(state.reloads).toBe(1);
    expect(reloader.staleBuildState()).toBe("stale");
  });

  test("a later deploy is a new build, and is reloaded for again", async () => {
    const { reloader, state, storage } = await page();
    expect(await reloader.recoverFromStaleBuild()).toBe("reloading");
    reloader.configureBuildReload({
      readBuild: async () => ({ version: "v0.5.7", revision: "def5678" }),
      reload: () => {
        state.reloads += 1;
      },
      storage: () => storage,
    });
    expect(await reloader.recoverFromStaleBuild()).toBe("reloading");
    expect(state.reloads).toBe(2);
  });

  test("never happens while the server cannot say which build it runs: that is a dropped connection", async () => {
    const { reloader, state } = await page(null);
    expect(await reloader.recoverFromStaleBuild()).toBe("unreachable");
    expect(state.reloads).toBe(0);
    expect(reloader.staleBuildState()).toBe("unreachable");

    // Back: asked again, and now it reloads.
    state.build = { version: "v0.5.6" };
    expect(await reloader.recoverFromStaleBuild()).toBe("reloading");
    expect(state.reloads).toBe(1);
  });

  test("asks again by itself while the server cannot answer, so one dropped moment does not hide every later crash", async () => {
    const { reloader, state } = await page(null);
    const asked: { work: () => void; ms: number }[] = [];
    reloader.configureBuildReload({
      readBuild: async () => state.build,
      reload: () => {
        state.reloads += 1;
      },
      storage: tabStorage,
      later: (work, ms) => {
        asked.push({ work, ms });
        return () => {};
      },
    });
    expect(await reloader.recoverFromStaleBuild()).toBe("unreachable");
    expect(asked.map((one) => one.ms)).toEqual([5_000]);

    // Still down: asked again, later each time.
    asked[0]?.work();
    await settle();
    expect(reloader.staleBuildState()).toBe("unreachable");
    expect(asked.map((one) => one.ms)).toEqual([5_000, 10_000]);

    // Back: nobody had to fail again for the page to come back.
    state.build = { version: "v0.5.6" };
    asked[1]?.work();
    await settle();
    expect(state.reloads).toBe(1);
    expect(reloader.staleBuildState()).toBe("reloading");
    expect(asked).toHaveLength(2);
  });

  test("never happens by itself where the tab cannot remember it did", async () => {
    // Without the guard, a broken build would reload forever.
    const { reloader, state } = await page(undefined, null);
    expect(await reloader.recoverFromStaleBuild()).toBe("stale");
    expect(state.reloads).toBe(0);
  });

  test("takes Vite's preload failure from it at once, before the build is known", async () => {
    const { reloader, state } = await page();
    const stop = reloader.listenForStaleChunks(window);
    const event = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(event);
    // Stopped from being thrown on, and every boundary already knows why.
    expect(event.defaultPrevented).toBe(true);
    expect(reloader.staleBuildState()).toBe("checking");
    await settle();
    expect(state.reloads).toBe(1);
    stop();
  });
});

describe("what was caught, by class", () => {
  test("a request that never reached the server is a dropped connection, in every engine's words", async () => {
    const { classifyError } = await import("../src/lib/support/screen-errors");
    const { RequestRefusedError } = await import("../src/lib/refusals");
    for (const error of [
      new TypeError("Failed to fetch"),
      new TypeError("Load failed"),
      new TypeError("NetworkError when attempting to fetch resource."),
      new RequestRefusedError("x", 503, "laf:api_unreachable"),
      new RequestRefusedError("x", 502, null),
      new RequestRefusedError("x", 504, null),
    ]) {
      expect(classifyError(error)).toBe("disconnect");
    }
    expect(classifyError(new RequestRefusedError("x", 500, null))).toBe(
      "failure",
    );
    expect(classifyError(new TypeError("x is not a function"))).toBe("failure");
    expect(
      classifyError(new TypeError("Importing a module script failed.")),
    ).toBe("chunk");
  });

  test("while a reload is being decided, whatever reaches a boundary is the stale page", async () => {
    // Vite's failure was stopped at the door; what arrives is the code that expected the module.
    const { reloader } = await page();
    const { classifyError } = await import("../src/lib/support/screen-errors");
    reloader.listenForStaleChunks(window)();
    const pending = reloader.recoverFromStaleBuild();
    expect(
      classifyError(
        new TypeError("Cannot read properties of undefined (reading 'x')"),
      ),
    ).toBe("chunk");
    await pending;
  });

  test("a dropped connection is not reported; a failure is, with its class, name and length and never its words", async () => {
    const { module, sent } = await reports();
    expect(
      await module.handleScreenError("main", new TypeError("Failed to fetch")),
    ).toBeNull();
    expect(sent).toEqual([]);

    const failure = new RangeError(`bad length for ${PASSWORD}`);
    await module.handleScreenError("main", failure);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      class: "failure",
      kind: "RangeError",
      name: "RangeError",
      length: failure.message.length,
    });
    expect(JSON.stringify(sent[0])).not.toContain(PASSWORD);
  });

  test("a chunk is reported only when the reload for its build was already spent", async () => {
    const { reloader, state } = await page();
    const { module, sent } = await reports();
    const chunk = new TypeError("Importing a module script failed.");

    await module.handleScreenError("main", chunk);
    expect(state.reloads).toBe(1);
    expect(sent).toEqual([]);

    // The page after the reload, whose own chunk fails as well.
    reloader.configureBuildReload({
      readBuild: async () => state.build,
      reload: () => {
        state.reloads += 1;
      },
      storage: () => null,
    });
    await module.handleScreenError("main", chunk);
    expect(state.reloads).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.class).toBe("chunk");
  });

  test("the server takes the three new facts only in their shapes", () => {
    const report = {
      section: "main",
      kind: "TypeError",
      class: "chunk",
      name: "TypeError",
      length: 42,
      fingerprint: "0123456789ab",
      surface: "shell",
    };
    expect(readScreenErrorReport(report)).toEqual(
      report as unknown as ScreenErrorReport,
    );
    for (const wrong of [
      { class: "disconnect" },
      { class: "Error" },
      { name: PASSWORD },
      { name: "a sentence Error" },
      { length: -1 },
      { length: 1.5 },
      { length: "42" },
      { length: 70_000 },
    ]) {
      expect(readScreenErrorReport({ ...report, ...wrong })).toBeNull();
    }
  });
});

describe("a part of the screen that fails for a reason that is not its own", () => {
  test("a dropped connection is said calmly, not reported, and the part comes back with the socket", async () => {
    quietly();
    const { sent } = await reports();
    const { SectionBoundary } = await import(
      "../src/components/layout/section-boundary"
    );
    const { SOCKET_RECONNECTED, socketState } = await import(
      "../src/lib/channels/use-channel-events"
    );
    let isDown = true;
    const Part = (): ReactElement => {
      if (isDown) throw new TypeError("Failed to fetch");
      return <p>back</p>;
    };
    const view = await mount(
      <SectionBoundary section="sidebar">
        <Part />
      </SectionBoundary>,
    );
    await view.settle(30);

    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe(
      "The server cannot be reached right now. This part comes back once the connection does.",
    );
    expect(
      view.host
        .querySelector("[data-failure-class]")
        ?.getAttribute("data-failure-class"),
    ).toBe("disconnect");
    expect(sent).toEqual([]);

    // The socket is back: the part draws again without anybody pressing anything.
    isDown = false;
    const { act } = await import("react");
    await act(async () => {
      socketState.dispatchEvent(new Event(SOCKET_RECONNECTED));
    });
    await view.settle(50);
    expect(view.host.textContent).toBe("back");
  });

  test("a stale chunk says the new version is loading, reloads, and is not reported", async () => {
    quietly();
    const { state } = await page();
    const { sent } = await reports();
    const { SectionBoundary } = await import(
      "../src/components/layout/section-boundary"
    );
    const Part = (): ReactElement => {
      throw new TypeError(
        "Failed to fetch dynamically imported module: https://app.test/assets/routines-Bq1.js",
      );
    };
    const view = await mount(
      <SectionBoundary section="main">
        <Part />
      </SectionBoundary>,
    );
    await view.settle(30);

    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    expect(view.host.textContent).toBe("Loading the new version…");
    expect(view.host.querySelector("button")).toBeNull();
    expect(state.reloads).toBe(1);
    expect(sent).toEqual([]);
  });

  test("a build that is still broken after its reload offers the reload to the person, and is reported", async () => {
    quietly();
    const { reloader, state } = await page(undefined, null);
    const { sent } = await reports();
    const { SectionBoundary } = await import(
      "../src/components/layout/section-boundary"
    );
    const Part = (): ReactElement => {
      throw new TypeError("Importing a module script failed.");
    };
    const view = await mount(
      <SectionBoundary section="main">
        <Part />
      </SectionBoundary>,
    );
    await view.settle(30);

    expect(reloader.staleBuildState()).toBe("stale");
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe(
      "This part could not be loaded. Reloading the page usually fixes it.",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.class).toBe("chunk");

    const button = view.host.querySelector("button");
    expect(button?.textContent).toBe("Reload page");
    if (!button) throw new Error("no way to reload");
    await view.press(button);
    // The person's own press is not the automatic reload, and has no guard.
    expect(state.reloads).toBe(1);
  });
});
