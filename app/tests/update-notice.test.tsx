import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ko } from "../src/lib/i18n-ko";
import { stubFetch } from "./support/fetch";
import { json, mount, unmountAll } from "./support/mount";

/**
 * 새 버전이 있어요 — THE ONE CONTROL, MOUNTED AND PRESSED.
 *
 * `build-watch.test.ts` holds the decision as a table and the moments the page looks. This holds
 * what a person meets: nothing on an ordinary day; one row when the server has moved past the
 * page, and a press that reloads with what was typed still there; the same row unpressable while
 * the Bot is mid-turn, saying why; and in the installed app with a newer shell in hand, the same
 * row saying 다시 시작해서 업데이트 and restarting through the shell.
 *
 * The page's build, the server's answer and the reload are handed in through the two modules' own
 * seams (`configureBuildWatch`, `configureBuildReload`); the Bot's state is the real presence, told
 * a turn began the way the conversation tells it (`publishTurn`); the shell is the bridge's global.
 */

const PAGE = "1bf325e4aaaa";
const NEWER = "e9be7221bbbb";
const BOT = "bot-1";

/*
 * The sentences, by their keys: the test runtime draws the English, and the first test holds each
 * key to the Korean a person reads.
 */
const NEW_VERSION = "A new version is here";
const REFRESH = "Refresh";
const RESTART = "Restart to update";
const HELD_REFRESH = "Your Bot is working. Refresh once it is done.";
const HELD_RESTART = "Your Bot is working. Restart once it is done.";
const NOT_RESTARTED = "Could not restart. Quit the app and open it again.";

type WindowWithTauri = typeof globalThis & { __TAURI__?: unknown };

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const realFetch = globalThis.fetch;
/** Every address asked of the server while a test ran. */
const asked: string[] = [];
let stopWatch: (() => void) | null = null;

afterEach(async () => {
  await unmountAll();
  stopWatch?.();
  stopWatch = null;
  const { configureBuildWatch } = await import("../src/lib/build-watch");
  const { configureBuildReload } = await import("../src/lib/build-reload");
  const { publishTurn } = await import("../src/lib/agents/presence");
  configureBuildWatch(null);
  configureBuildReload(null);
  publishTurn(BOT, "idle");
  (globalThis as WindowWithTauri).__TAURI__ = undefined;
  globalThis.fetch = realFetch;
  asked.length = 0;
});

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

/** The person's one Bot, at rest: what the control reads to know whether a turn is in flight. */
function server() {
  globalThis.fetch = stubFetch(async (input) => {
    const url = String(input);
    asked.push(url);
    if (url === "/api/agents") {
      return json({
        agents: [
          {
            id: BOT,
            name: "초롱",
            roleDescription: "",
            avatarSeed: BOT,
            autoReview: "",
            endpoint: null,
            hasAuth: false,
            hidden: false,
            notify: true,
            systemOwned: false,
            canManage: true,
            mine: true,
          },
        ],
      });
    }
    if (url === "/api/agents?hidden=true") return json({ agents: [] });
    if (url === "/api/agents/working") return json({ working: [] });
    // The Bot's computer, asked a few times as the presence mounts: nobody at the wheel.
    return json({}, 404);
  });
}

/** A shell holding `held`, answering the restart with `restarts`. */
function shell(held: string | null, restarts: "restarts" | "refuses") {
  const calls: string[] = [];
  (globalThis as WindowWithTauri).__TAURI__ = {
    core: {
      invoke: async (command: string) => {
        calls.push(command);
        if (command === "update_ready") return held;
        if (command === "restart_to_update" && restarts === "refuses") {
          throw new Error("no update is waiting");
        }
        return null;
      },
    },
    event: { listen: async () => () => {} },
  };
  return calls;
}

/**
 * The control, mounted in front of a server that runs `serverRevision`, after the window has been
 * looked at once — the moment a page learns anything.
 */
async function notice(
  options: {
    serverRevision?: string;
    shape?: "row" | "icon";
    storage?: Storage;
  } = {},
) {
  server();
  const storage = options.storage ?? memory();
  const watch = await import("../src/lib/build-watch");
  const reload = await import("../src/lib/build-reload");
  const reloads = { count: 0 };
  reload.configureBuildReload({
    reload: () => {
      reloads.count += 1;
    },
    storage: () => storage,
  });
  watch.configureBuildWatch({
    bundleRevision: () => PAGE,
    readBuild: async () => ({ revision: options.serverRevision ?? PAGE }),
    isVisible: () => true,
    storage: () => storage,
    lookEveryMs: 3_600_000,
  });
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { UpdateNotice } = await import(
    "../src/components/layout/update-notice"
  );
  const { act } = await import("react");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = await mount(
    <QueryClientProvider client={client}>
      <UpdateNotice shape={options.shape ?? "row"} />
    </QueryClientProvider>,
  );
  await act(async () => {
    stopWatch = watch.watchBuild();
  });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await view.settle(40);
  return {
    ...view,
    reload,
    reloads,
    storage,
    box: () => view.host.querySelector("[data-update-notice]"),
    button: () => view.host.querySelector("button") as HTMLButtonElement | null,
    text: () => view.host.textContent ?? "",
  };
}

test("the words a person reads: few, and the two the owner asked for", () => {
  expect(ko[NEW_VERSION]).toBe("새 버전이 있어요");
  expect(ko[REFRESH]).toBe("새로고침");
  expect(ko[RESTART]).toBe("다시 시작해서 업데이트");
  expect(ko[HELD_REFRESH]).toBe(
    "봇이 일하는 중이에요. 일이 끝나면 새로고침해 주세요.",
  );
  expect(ko[HELD_RESTART]).toBe(
    "봇이 일하는 중이에요. 일이 끝나면 다시 시작해 주세요.",
  );
  expect(ko[NOT_RESTARTED]).toBe(
    "다시 시작하지 못했어요. 앱을 종료했다가 다시 열어 주세요.",
  );
  // The card this replaced had three more: its title, its sentence and 나중에. Gone with it.
  expect(ko["A new version is ready"]).toBeUndefined();
  expect(ko["Restart now"]).toBeUndefined();
  expect(ko.Later).toBeUndefined();
});

test("an ordinary day: nothing is drawn, and nothing is asked about the Bot", async () => {
  const view = await notice();
  expect(view.box()).toBeNull();
  expect(view.text()).toBe("");
  // Mounted twice in the app — the column and the phone's bar — so the idle cost is what matters.
  expect(asked).toEqual([]);
});

test("the server has moved past the page: one row that says so, and the press reloads with what was typed kept", async () => {
  const view = await notice({ serverRevision: NEWER });
  expect(view.box()?.getAttribute("data-update-notice")).toBe("reload");
  expect(view.host.querySelectorAll("button")).toHaveLength(1);
  expect(view.text()).toBe(`${NEW_VERSION}${REFRESH}`);
  expect(view.button()?.disabled).toBe(false);

  // Somebody was in the middle of a message when they pressed.
  const release = view.reload.holdDraft("ch-1", "사진은 내일 보낼게요");
  const button = view.button();
  if (!button) throw new Error("no button to press");
  await view.press(button);
  expect(view.reloads.count).toBe(1);
  release();
  expect(view.reload.takeKeptDraft("ch-1")).toBe("사진은 내일 보낼게요");
});

test("mid-turn it is drawn and cannot be pressed, and says why — and can be once the turn ends", async () => {
  const { publishTurn } = await import("../src/lib/agents/presence");
  const { act } = await import("react");
  const view = await notice({ serverRevision: NEWER });
  await act(async () => {
    publishTurn(BOT, "working");
  });
  await view.settle();
  expect(view.box()).not.toBeNull();
  expect(view.button()?.disabled).toBe(true);
  expect(view.text()).toBe(`${NEW_VERSION}${REFRESH}${HELD_REFRESH}`);
  const held = view.button();
  if (!held) throw new Error("no button");
  await view.press(held);
  expect(view.reloads.count).toBe(0);

  await act(async () => {
    publishTurn(BOT, "idle");
  });
  await view.settle();
  expect(view.button()?.disabled).toBe(false);
  expect(view.text()).toBe(`${NEW_VERSION}${REFRESH}`);
  const free = view.button();
  if (!free) throw new Error("no button");
  await view.press(free);
  expect(view.reloads.count).toBe(1);
});

test("a Bot waiting on the person is not a Bot at work: the control can be pressed and says nothing about waiting", async () => {
  /*
   * Held only while the Bot WORKS. With a question open the control used to be disabled under
   * "your Bot is working, refresh once it is done" — telling somebody to wait for a Bot that was
   * waiting for them, for as long as the question stood (review of pull request 112). The question
   * is the server's; the page a reload brings draws it again.
   */
  const approvals = await import("../src/lib/approvals");
  const { act } = await import("react");
  const view = await notice({ serverRevision: NEWER });
  await act(async () => {
    approvals.openQuestion("call-waiting", {
      approvalId: "approval-waiting",
      botId: BOT,
      subject: undefined,
      rule: null,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
  });
  await view.settle();
  try {
    expect(view.button()?.disabled).toBe(false);
    expect(view.text()).toBe(`${NEW_VERSION}${REFRESH}`);
    const free = view.button();
    if (!free) throw new Error("no button");
    await view.press(free);
    expect(view.reloads.count).toBe(1);
  } finally {
    approvals.closeQuestion("call-waiting");
  }
});

test("in the installed app with a newer shell in hand, the same row says 다시 시작해서 업데이트 and the press restarts through the shell", async () => {
  const calls = shell("0.6.1", "restarts");
  // The page is behind as well: one press does for both, and it is the restart.
  const view = await notice({ serverRevision: NEWER });
  expect(view.box()?.getAttribute("data-update-notice")).toBe("restart");
  expect(view.host.querySelectorAll("button")).toHaveLength(1);
  expect(view.text()).toBe(RESTART);

  const button = view.button();
  if (!button) throw new Error("no button to press");
  await view.press(button);
  expect(calls.filter((command) => command !== "update_ready")).toEqual([
    "restart_to_update",
  ]);
  // Not the page's reload: the shell brings the page back.
  expect(view.reloads.count).toBe(0);
});

test("a restart the shell refuses is said, and the control stays to be pressed again", async () => {
  const calls = shell("0.6.1", "refuses");
  const view = await notice();
  const button = view.button();
  if (!button) throw new Error("no button to press");
  await view.press(button);
  expect(calls).toContain("restart_to_update");
  expect(view.text()).toBe(`${RESTART}${NOT_RESTARTED}`);
  expect(view.button()?.disabled).toBe(false);
});

test("mid-turn a restart is withheld the same way", async () => {
  const { publishTurn } = await import("../src/lib/agents/presence");
  const { act } = await import("react");
  const calls = shell("0.6.1", "restarts");
  const view = await notice();
  await act(async () => {
    publishTurn(BOT, "answering");
  });
  await view.settle();
  expect(view.button()?.disabled).toBe(true);
  expect(view.text()).toBe(`${RESTART}${HELD_RESTART}`);
  const held = view.button();
  if (!held) throw new Error("no button");
  await view.press(held);
  expect(calls).not.toContain("restart_to_update");
});

test("in the 64px rail it is the icon alone, named by its sentence — and by the reason while it is withheld", async () => {
  const { publishTurn } = await import("../src/lib/agents/presence");
  const { act } = await import("react");
  const view = await notice({ serverRevision: NEWER, shape: "icon" });
  expect(view.text()).toBe("");
  expect(view.button()?.getAttribute("aria-label")).toBe(
    `${NEW_VERSION} · ${REFRESH}`,
  );
  expect(view.button()?.getAttribute("aria-disabled")).toBeNull();

  await act(async () => {
    publishTurn(BOT, "working");
  });
  await view.settle();
  // Not `disabled`: a disabled button takes no hover, and its reason would be out of reach.
  expect(view.button()?.disabled).toBe(false);
  expect(view.button()?.getAttribute("aria-disabled")).toBe("true");
  expect(view.button()?.getAttribute("aria-label")).toBe(HELD_REFRESH);
  const held = view.button();
  if (!held) throw new Error("no button");
  await view.press(held);
  expect(view.reloads.count).toBe(0);
});
