import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { BUILD_REVISION_META } from "../src/lib/build/revision-tag";

/**
 * WHETHER THE SERVER HAS MOVED PAST THE PAGE: the decision as a table, and when the page looks.
 *
 * The problem this holds was measured in review on 2026-10-06: nothing compared the page's build
 * with the server's, so a window open before an upgrade kept the old bundle — in the installed app,
 * for days. `lib/build-watch.ts` compares the commit baked into the page with the commit the server
 * says it runs now, and this file is every row of that comparison and every moment it is made.
 *
 * The watch is driven here by the events a real window gets — `visibilitychange`, `focus`, the
 * socket's own "back" — against a server that is a function and a clock that is a number, so
 * "never while hidden" and "at most once in half a minute" are things that happened or did not,
 * not sentences in a comment.
 */

const PAGE = "1bf325e4aaaa";
const NEWER = "e9be7221bbbb";
const NEWEST = "f6992661cccc";

type WindowWithTauri = typeof globalThis & { __TAURI__?: unknown };

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** Imported after the DOM exists: the modules under it reach for `document` and the socket. */
async function modules() {
  const watch = await import("../src/lib/build-watch");
  const reload = await import("../src/lib/build-reload");
  const events = await import("../src/lib/channels/use-channel-events");
  return { ...watch, reload, events };
}

let stop: (() => void) | null = null;
afterEach(async () => {
  stop?.();
  stop = null;
  const { configureBuildWatch, reload } = await modules();
  configureBuildWatch(null);
  reload.configureBuildReload(null);
  (globalThis as WindowWithTauri).__TAURI__ = undefined;
  for (const tag of document.querySelectorAll("meta")) tag.remove();
});

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function memory(): Storage {
  const held = new Map<string, string>();
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
    clear: () => held.clear(),
    key: () => null,
    get length() {
      return held.size;
    },
  } as Storage;
}

/** A page built from `PAGE`, in front of a server whose answer the test sets as it goes. */
async function watching(
  options: {
    bundle?: string | null;
    isVisible?: boolean;
    lookEveryMs?: number;
    storage?: Storage;
  } = {},
) {
  const all = await modules();
  const world = {
    answer: { revision: PAGE } as { revision?: string } | null,
    isVisible: options.isVisible ?? true,
    clock: 1_000_000,
    reads: 0,
    storage: options.storage ?? memory(),
  };
  all.configureBuildWatch({
    bundleRevision: () =>
      options.bundle === undefined ? PAGE : options.bundle,
    readBuild: async () => {
      world.reads += 1;
      return world.answer;
    },
    isVisible: () => world.isVisible,
    now: () => world.clock,
    storage: () => world.storage,
    // Far beyond any test, unless the test is about the timer.
    lookEveryMs: options.lookEveryMs ?? 3_600_000,
  });
  stop = all.watchBuild();
  await tick();
  const seen = async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await tick();
  };
  const offer = () =>
    all.updateOffer({ ...all.buildFacts(), isBotBusy: false });
  return { ...all, world, seen, offer };
}

describe("what is offered", () => {
  const known = {
    bundleRevision: PAGE,
    serverRevision: PAGE,
    reloadedFor: null,
    shellUpdate: null,
    isBotBusy: false,
  };

  test("the same build on both sides: nothing", async () => {
    const { updateOffer } = await modules();
    expect(updateOffer(known)).toEqual({ kind: "none" });
  });

  test("the server runs another build: the page offers to reload into it", async () => {
    const { updateOffer } = await modules();
    expect(updateOffer({ ...known, serverRevision: NEWER })).toEqual({
      kind: "reload",
      isHeld: false,
    });
  });

  test("the server has not said, or could not: nothing", async () => {
    const { updateOffer } = await modules();
    expect(updateOffer({ ...known, serverRevision: null })).toEqual({
      kind: "none",
    });
  });

  test("development, where no commit is baked into the page: nothing, whatever the server says", async () => {
    const { updateOffer } = await modules();
    expect(
      updateOffer({ ...known, bundleRevision: null, serverRevision: NEWER }),
    ).toEqual({ kind: "none" });
  });

  test("mid-turn the offer stands and is held", async () => {
    const { updateOffer } = await modules();
    expect(
      updateOffer({ ...known, serverRevision: NEWER, isBotBusy: true }),
    ).toEqual({ kind: "reload", isHeld: true });
  });

  test("a newer shell in hand is a restart, with or without a newer page, and is held mid-turn too", async () => {
    const { updateOffer } = await modules();
    expect(updateOffer({ ...known, shellUpdate: "0.6.1" })).toEqual({
      kind: "restart",
      version: "0.6.1",
      isHeld: false,
    });
    // The app that comes back loads the page afresh, so one press does for both.
    expect(
      updateOffer({
        ...known,
        serverRevision: NEWER,
        shellUpdate: "0.6.1",
        isBotBusy: true,
      }),
    ).toEqual({ kind: "restart", version: "0.6.1", isHeld: true });
    // And in development, where the page has no commit, a pretend update is still said.
    expect(
      updateOffer({ ...known, bundleRevision: null, shellUpdate: "0.6.1" }),
    ).toMatchObject({ kind: "restart" });
  });

  test("reloaded for that build once and still not it: no longer offered, until the server names another", async () => {
    const { updateOffer } = await modules();
    const reloaded = { ...known, serverRevision: NEWER, reloadedFor: NEWER };
    expect(updateOffer(reloaded)).toEqual({ kind: "none" });
    expect(updateOffer({ ...reloaded, serverRevision: NEWEST })).toEqual({
      kind: "reload",
      isHeld: false,
    });
  });
});

describe("the commit a page carries", () => {
  test("is read from its own document, and is nothing where the build wrote none", async () => {
    const { readBundleRevision } = await modules();
    expect(readBundleRevision()).toBeNull();
    const tag = document.createElement("meta");
    tag.setAttribute("name", BUILD_REVISION_META);
    tag.setAttribute("content", ` ${PAGE} `);
    document.head.append(tag);
    expect(readBundleRevision()).toBe(PAGE);
    tag.setAttribute("content", "  ");
    expect(readBundleRevision()).toBeNull();
  });
});

describe("when the page looks", () => {
  test("not as it begins: a page that has just loaded is not asked about itself", async () => {
    const { world, offer } = await watching();
    expect(world.reads).toBe(0);
    expect(offer()).toEqual({ kind: "none" });
  });

  test("when the window comes into sight or takes the focus, and it says so once the server has moved", async () => {
    const { world, seen, offer } = await watching();
    await seen();
    expect(world.reads).toBe(1);
    expect(offer()).toEqual({ kind: "none" });

    world.answer = { revision: NEWER };
    world.clock += 60_000;
    window.dispatchEvent(new Event("focus"));
    await tick();
    expect(world.reads).toBe(2);
    expect(offer()).toEqual({ kind: "reload", isHeld: false });
  });

  test("never while hidden, and then the moment it is brought back", async () => {
    const { world, seen, offer } = await watching({
      isVisible: false,
      lookEveryMs: 10,
    });
    world.answer = { revision: NEWER };
    await seen();
    window.dispatchEvent(new Event("focus"));
    // Several of the timer's turns, with the clock moved on so only "hidden" is holding it back.
    world.clock += 600_000;
    await tick(45);
    expect(world.reads).toBe(0);
    expect(offer()).toEqual({ kind: "none" });

    world.isVisible = true;
    await seen();
    expect(world.reads).toBe(1);
    expect(offer()).toEqual({ kind: "reload", isHeld: false });
  });

  test("at most once in half a minute, however often the window is flicked to", async () => {
    const { world, seen } = await watching();
    await seen();
    await seen();
    window.dispatchEvent(new Event("focus"));
    await tick();
    world.clock += 29_000;
    await seen();
    expect(world.reads).toBe(1);
    world.clock += 2_000;
    await seen();
    expect(world.reads).toBe(2);
  });

  test("every few minutes while it stays in sight", async () => {
    const { world, offer } = await watching({ lookEveryMs: 10 });
    world.answer = { revision: NEWER };
    await tick(25);
    // The first turn of the timer looked; the next ones are inside the half-minute.
    expect(world.reads).toBe(1);
    expect(offer()).toEqual({ kind: "reload", isHeld: false });
    world.clock += 300_000;
    await tick(25);
    expect(world.reads).toBe(2);
  });

  test("when the connection to the server comes back, however recently it looked", async () => {
    const { world, seen, offer, events } = await watching();
    await seen();
    expect(world.reads).toBe(1);
    // Seconds later the server is replaced under the page: the socket drops and returns.
    world.answer = { revision: NEWER };
    world.clock += 13_000;
    events.socketState.dispatchEvent(new Event(events.SOCKET_RECONNECTED));
    await tick();
    expect(world.reads).toBe(2);
    expect(offer()).toEqual({ kind: "reload", isHeld: false });

    // Hidden, it still asks nothing: the look waits for the window.
    world.isVisible = false;
    events.socketState.dispatchEvent(new Event(events.SOCKET_RECONNECTED));
    await tick();
    expect(world.reads).toBe(2);
  });

  test("a read that fails is silence: it raises nothing, and lowers nothing already known", async () => {
    const { world, seen, offer } = await watching();
    // The server is restarting: no answer at all.
    world.answer = null;
    await seen();
    expect(world.reads).toBe(1);
    expect(offer()).toEqual({ kind: "none" });

    world.answer = { revision: NEWER };
    world.clock += 60_000;
    await seen();
    expect(offer()).toEqual({ kind: "reload", isHeld: false });

    // It goes away again, and then answers as a source checkout does, with no commit: still known.
    world.answer = null;
    world.clock += 60_000;
    await seen();
    world.answer = {};
    world.clock += 60_000;
    await seen();
    expect(world.reads).toBe(4);
    expect(offer()).toEqual({ kind: "reload", isHeld: false });
  });

  test("a server that goes back to the page's build takes the offer away", async () => {
    const { world, seen, offer } = await watching();
    world.answer = { revision: NEWER };
    await seen();
    expect(offer().kind).toBe("reload");
    world.answer = { revision: PAGE };
    world.clock += 60_000;
    await seen();
    expect(offer()).toEqual({ kind: "none" });
  });

  test("a page with no commit baked never asks at all", async () => {
    const { world, seen, offer, events } = await watching({
      bundle: null,
      lookEveryMs: 10,
    });
    world.answer = { revision: NEWER };
    await seen();
    window.dispatchEvent(new Event("focus"));
    events.socketState.dispatchEvent(new Event(events.SOCKET_RECONNECTED));
    world.clock += 600_000;
    await tick(35);
    expect(world.reads).toBe(0);
    expect(offer()).toEqual({ kind: "none" });
  });

  test("nothing after it is stopped", async () => {
    const { world, seen, events } = await watching({ lookEveryMs: 10 });
    stop?.();
    stop = null;
    world.clock += 600_000;
    await seen();
    window.dispatchEvent(new Event("focus"));
    events.socketState.dispatchEvent(new Event(events.SOCKET_RECONNECTED));
    await tick(35);
    expect(world.reads).toBe(0);
  });
});

describe("the press", () => {
  test("reloads through the one reload there is, keeping what was typed, and remembers the build it reloaded for", async () => {
    const storage = memory();
    const { world, seen, reload, reloadIntoNewBuild } = await watching({
      storage,
    });
    let reloads = 0;
    reload.configureBuildReload({
      reload: () => {
        reloads += 1;
      },
      storage: () => storage,
    });
    world.answer = { revision: NEWER };
    await seen();
    const release = reload.holdDraft("ch-1", "내일 오전 10시로 예약");

    reloadIntoNewBuild();
    expect(reloads).toBe(1);
    expect(storage.getItem("laf:reloaded-for-revision")).toBe(NEWER);
    release();
    // What the composer of that conversation is handed when the new page draws it.
    expect(reload.takeKeptDraft("ch-1")).toBe("내일 오전 10시로 예약");
    expect(reload.staleBuildState()).toBe("reloading");
  });

  test("a reload that did not bring the server's build is not offered a second time", async () => {
    const storage = memory();
    const first = await watching({ storage });
    first.reload.configureBuildReload({
      reload: () => {},
      storage: () => storage,
    });
    first.world.answer = { revision: NEWER };
    await first.seen();
    expect(first.offer().kind).toBe("reload");
    first.reloadIntoNewBuild();
    stop?.();

    // The page that came back is the same bundle: the web image was not replaced with the server's.
    const again = await watching({ storage });
    again.world.answer = { revision: NEWER };
    await again.seen();
    expect(again.world.reads).toBe(1);
    expect(again.offer()).toEqual({ kind: "none" });

    // The next build the server names is offered.
    again.world.answer = { revision: NEWEST };
    again.world.clock += 60_000;
    await again.seen();
    expect(again.offer()).toEqual({ kind: "reload", isHeld: false });
  });

  test("…but it is offered again when the connection returns: the front door was replaced after the server", async () => {
    /*
     * The fleet's upgrade order. The server is replaced first, so the page reconnects through the
     * OLD front door and offers the reload; a press there brings the old page back. Seconds later
     * the front door is replaced, which drops this page's socket — and a mark that outlived that
     * kept the control silent for the whole release (review of pull request 112).
     */
    const storage = memory();
    const first = await watching({ storage });
    first.reload.configureBuildReload({
      reload: () => {},
      storage: () => storage,
    });
    first.world.answer = { revision: NEWER };
    await first.seen();
    first.reloadIntoNewBuild();
    stop?.();

    // The old front door served the old page: the same bundle, the mark kept, nothing offered.
    const again = await watching({ storage });
    again.world.answer = { revision: NEWER };
    await again.seen();
    expect(again.offer()).toEqual({ kind: "none" });
    expect(storage.getItem("laf:reloaded-for-revision")).toBe(NEWER);

    // The front door is replaced: the socket drops and comes back.
    again.events.socketState.dispatchEvent(
      new Event(again.events.SOCKET_RECONNECTED),
    );
    await tick();
    expect(storage.getItem("laf:reloaded-for-revision")).toBeNull();
    expect(again.offer()).toEqual({ kind: "reload", isHeld: false });
  });
});

describe("the shell's half", () => {
  /** A shell that holds `held()` and can say that one has arrived. */
  function shell(held: () => string | null) {
    const calls: string[] = [];
    let say: (() => void) | null = null;
    (globalThis as WindowWithTauri).__TAURI__ = {
      core: {
        invoke: async (command: string) => {
          calls.push(command);
          return command === "update_ready" ? held() : null;
        },
      },
      event: {
        listen: async (
          _name: string,
          handler: (event: { payload: unknown }) => void,
        ) => {
          say = () => handler({ payload: "anything a page could forge" });
          return () => {
            say = null;
          };
        },
      },
    };
    return { calls, arrives: () => say?.() };
  }

  test("the update it holds is read as the watch begins, and again when the shell says one arrived", async () => {
    let held: string | null = null;
    const { calls, arrives } = shell(() => held);
    const { offer } = await watching();
    expect(calls).toEqual(["update_ready"]);
    expect(offer()).toEqual({ kind: "none" });

    // The event is a nudge and its payload is not believed: the version is read back.
    held = "0.6.1";
    arrives();
    await tick();
    expect(calls).toEqual(["update_ready", "update_ready"]);
    expect(offer()).toEqual({
      kind: "restart",
      version: "0.6.1",
      isHeld: false,
    });
  });

  test("in a browser tab there is no shell, and nothing is learned", async () => {
    const { offer, buildFacts } = await watching();
    expect(buildFacts().shellUpdate).toBeNull();
    expect(offer()).toEqual({ kind: "none" });
  });
});
