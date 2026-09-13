import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  agentFixture,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * The page a notification lands on: where it sits, and the error it used to log on every load.
 *
 * TWO THINGS WERE MEASURED IN A BROWSER AND NEITHER WAS VISIBLE FROM A GREEN GATE.
 *
 * It was built on `PageShell`, the configuration frame — a prose column pinned to the top under
 * `py-12`. At 1280x900 the whole page was one sentence and one button between y=48 and y=109, with
 * 791 empty pixels below it, while every other "there is nothing here" state in the product is
 * centred. Now: 391px above, 391px below.
 *
 * And both of its Link buttons logged "Base UI: A component that acts as a button expected a native
 * <button>..." on every single load, because Base UI's `Button` assumes it renders a real button and
 * these render an anchor. `nativeButton={false}` is how you say so, and `router.tsx` had been
 * saying it since `NotFoundScreen` was written.
 *
 * RENDERED, with the console listened to. The earlier file walked the source with the comments
 * stripped, because the comments name `PageShell` and the Base UI sentence and a walk would have
 * passed on its own documentation. A render has no such problem: the frame is the element on
 * screen, the anchors are anchors, and the error is either logged during the mount or it is not.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
// A test that timed out never reached its own unmount; nothing it mounted outlives it.
afterEach(unmountApps);
afterAll(async () => {
  await removeAppDom();
});

const visible = [agentFixture({ id: "bot-1", name: "초롱" })];
const hidden = [agentFixture({ id: "bot-hidden", name: "단풍", hidden: true })];

const question = {
  id: "ap-1",
  botId: "bot-1",
  rule: "true",
  subject: {
    kind: "browser",
    intent: "navigate",
    reason: "policy",
    host: "example.com",
  },
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

const room = {
  id: "ch-1",
  name: "초롱",
  agentIds: ["bot-1"],
  threadId: "thread-1",
  active: true,
  lastMessage: null,
  lastMessageAt: null,
  lastMessageAgentId: null,
  unread: false,
  createdAt: new Date().toISOString(),
};

/**
 * The page, with the console watched for the whole mount.
 *
 * Base UI's complaint is a `console.error` during render — it is the one symptom the bug had, so
 * it is the one thing to listen for.
 */
async function approvePage(
  approvalId: string,
  waiting: typeof question | null,
) {
  const logged: string[] = [];
  const realError = console.error;
  const realWarn = console.warn;
  const capture = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  console.error = capture;
  console.warn = capture;
  let view: Awaited<ReturnType<typeof mountApp>>;
  try {
    view = await mountApp({
      path: `/approve/${approvalId}`,
      api: ({ pathname, path }) => {
        if (path === "/api/agents") return json({ agents: visible });
        if (path === "/api/agents?hidden=true") return json({ agents: hidden });
        if (pathname === "/api/channels") return json({ channels: [room] });
        if (pathname === "/api/approvals/bot-1") {
          return json({ approvals: waiting ? [waiting] : [] });
        }
        return undefined;
      },
    });
    // The card reads the question out of the module store one effect after the query lands.
    await view.settle(50);
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
  const main = view.main();
  if (!main) throw new Error("the app shell did not draw its main pane");
  const h1 = main.querySelector("h1");
  if (!h1?.parentElement?.parentElement) {
    throw new Error("the page has no heading to centre");
  }
  return {
    ...view,
    main,
    logged,
    /** The centred column is the heading's parent; the scroller is the column's. */
    column: h1.parentElement,
    scroller: h1.parentElement.parentElement,
    anchors: () => [...main.querySelectorAll<HTMLAnchorElement>("a[href]")],
  };
}

describe("the approval page's frame", () => {
  test("is not the configuration shell", async () => {
    // `PageShell` opens with a `<header>`; a destination has a heading and nothing above it.
    const view = await approvePage("nothing-here", null);
    expect(view.main.querySelector("header")).toBeNull();
    expect(view.main.querySelector("h1")).not.toBeNull();
    await view.unmount();
  });

  test("centres its column, and scrolls when the question is taller than the window", async () => {
    const view = await approvePage("nothing-here", null);
    expect(view.column.className).toContain("items-center");
    expect(view.column.className).toContain("justify-center");
    // Centring without `min-h-full` inside the scroller centres against the CONTENT, not the
    // window, which is a no-op on a short page and a clipped question on a tall one.
    expect(view.column.className).toContain("min-h-full");
    expect(view.scroller.className).toContain("overflow-y-auto");
    await view.unmount();
  });

  test("nothing is pushed to the left edge of a centred column any more", async () => {
    const view = await approvePage("ap-1", question);
    expect(view.column.querySelector(".self-start")).toBeNull();
    await view.unmount();
  });
});

describe("every Button that renders a Link", () => {
  test("is an anchor, and Base UI has nothing to say about it", async () => {
    const view = await approvePage("nothing-here", null);
    const back = view
      .anchors()
      .find((a) => a.textContent === "Go to your Bots");
    expect(back?.getAttribute("href")).toBe("/");
    expect(view.logged.filter((line) => line.includes("Base UI"))).toEqual([]);
    await view.unmount();
  });

  test("the way to the room is one too", async () => {
    const view = await approvePage("ap-1", question);
    const open = view
      .anchors()
      .find((a) => a.textContent === "Open the conversation");
    expect(open?.getAttribute("href")).toBe("/channel/ch-1");
    expect(view.logged.filter((line) => line.includes("Base UI"))).toEqual([]);
    await view.unmount();
  });
});

describe("what the page says", () => {
  test("about an id nobody is waiting on, having asked every Bot including the hidden ones", async () => {
    /*
     * A person who answered on their other machine, or came back to the notice after lunch, arrives
     * here and deserves to be told that nothing went wrong. And a hidden Bot never raises a notice,
     * but a link can still name one of its questions — so it is asked too.
     */
    const view = await approvePage("nothing-here", null);
    expect(view.main.textContent).toContain("Nothing is waiting for an answer");
    expect(ko["Nothing is waiting for an answer"]).toBeTruthy();
    const asked = view.requests
      .filter((request) => request.pathname.startsWith("/api/approvals/"))
      .map((request) => request.pathname);
    expect(asked).toContain("/api/approvals/bot-1");
    expect(asked).toContain("/api/approvals/bot-hidden");
    await view.unmount();
  });

  test("about a question still waiting: the Bot's name, and the card itself", async () => {
    const view = await approvePage("ap-1", question);
    expect(view.main.querySelector("h1")?.textContent).toBe("초롱 needs you");
    // The card is `ApprovalRequest`, unmodified: its two answers are on the page.
    expect(view.buttonNamed("Allow once")).toBeDefined();
    expect(view.buttonNamed("Deny")).toBeDefined();
    await view.unmount();
  });
});
