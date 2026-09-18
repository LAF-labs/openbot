/**
 * 연결 점검, RENDERED IN KOREAN IN THE REAL APP, REACHED THE WAYS A PERSON REACHES IT.
 *
 * In a process of its own for the reasons `feedback-render.tsx` gives: the locale is decided when the
 * dictionary is first loaded, and Base UI's dialog decides once, when it is first evaluated, whether
 * there is a DOM to portal into. Both are settled here before any app module is imported.
 *
 * Reads a scenario from the JSON file named by its one argument — what `/api/health` answers, whether
 * the probe sockets get through, how far the server's clock is from this one, which Bots there are,
 * and which way in to take — then opens the check, waits for it to finish, reads every row, presses
 * 복사, and prints one line, `CHECK_RENDER <json>`. Not a test file (no `.test.` in the name).
 *
 *     bun app/tests/support/connection-check-render.tsx /tmp/scenario.json
 */
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export type CheckScenario = {
  /** What `/api/health` answers. A null body is an empty one, the way a proxy answers. */
  health: { status: number; body: unknown };
  /** Whether a probe socket is answered, or refused at the handshake. */
  sockets: "answer" | "refuse";
  /** How far the server's clock is ahead of this one, in milliseconds. */
  serverClockAheadMs: number;
  /** The Bots `/api/agents` lists, as ids. */
  bots: string[];
  /**
   * `help`: the help page's button. `notice`: the app's own socket drops, and the line that says so
   * is pressed. `feedback`: from inside the 문의·의견 box, then 진단 정보 같이 보내기 is ticked.
   * `unreachable`: `/api/me` gets the same bare 500 the development server answers for a stopped
   * API, so the app lands on "서버에 닿지 못했습니다", and the check is run there.
   */
  via: "help" | "notice" | "feedback" | "unreachable";
};

export type CheckRow = {
  id: string;
  state: string;
  name: string;
  detail: string;
  advice: string;
};

export type CheckShown = {
  rows: CheckRow[];
  summary: string;
  copied: string | null;
  /** Every socket the page opened, in order. */
  sockets: string[];
  /** The check's result as the 문의·의견 box sent it on the diagnostics read. `feedback` only. */
  sentWithDiagnostics: unknown;
  /** The diagnostics preview's text. `feedback` only. */
  preview: string | null;
  /** The line under 진단 정보 같이 보내기, once a check has run. `feedback` only. */
  alsoSends: boolean;
};

const scenario = JSON.parse(
  readFileSync(process.argv[2] as string, "utf8"),
) as CheckScenario;

process.env.NODE_ENV = "test";
GlobalRegistrator.register({ url: "http://localhost:3110/" });
window.localStorage.setItem("laf.locale", "ko");
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const copied: string[] = [];
Object.defineProperty(window.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      copied.push(text);
    },
  },
});

const socketsOpened: string[] = [];
/** The app's own feed socket, the latest one: the `notice` way in drops it. */
let feed: ScriptedSocket | null = null;

/**
 * A browser WebSocket as far as the app and the check use one. A probe (`?probe`) does what the
 * scenario says; the app's own feed is left connecting until the script says otherwise.
 */
class ScriptedSocket {
  url: string;
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    socketsOpened.push(new URL(url).pathname + new URL(url).search);
    if (!new URL(url).searchParams.has("probe")) {
      feed = this;
      return;
    }
    setTimeout(() => {
      if (scenario.sockets === "refuse") {
        this.readyState = 3;
        this.onerror?.({});
        this.onclose?.({ code: 1006 });
        return;
      }
      this.readyState = 1;
      this.onopen?.({});
      this.onmessage?.({
        data: url.includes("/stream") ? '{"type":"probe"}' : '{"kind":"probe"}',
      });
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }, 5);
  }

  send() {}

  close() {
    this.readyState = 3;
  }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = ScriptedSocket;
(window as unknown as { WebSocket: unknown }).WebSocket = ScriptedSocket;

const { agentFixture, mountApp } = await import("./app-router");
const { act } = await import("react");

/** An answer with the `Date` header the clock check reads — the server's clock, as the scenario sets it. */
const answer = (body: unknown, status = 200) =>
  new Response(body === null ? "" : JSON.stringify(body), {
    status,
    headers: {
      "content-type": body === null ? "text/plain" : "application/json",
      date: new Date(Date.now() + scenario.serverClockAheadMs).toUTCString(),
    },
  });

let sentWithDiagnostics: unknown = null;

const view = await mountApp({
  path: scenario.via === "unreachable" ? "/" : "/help",
  api: ({ method, pathname, url }) => {
    if (pathname === "/api/support/help-opened") {
      return new Response(null, { status: 204 });
    }
    if (scenario.via === "unreachable" && pathname === "/api/me") {
      return answer(null, 500);
    }
    if (pathname === "/api/health") {
      return answer(scenario.health.body, scenario.health.status);
    }
    if (pathname === "/api/version") {
      return answer({ version: "v0.5.1", revision: "abc1234" });
    }
    if (pathname === "/api/agents") {
      return answer({
        agents: scenario.bots.map((id) => agentFixture({ id, name: id })),
      });
    }
    if (method === "GET" && pathname === "/api/support/diagnostics") {
      const sent = url.searchParams.get("connectionCheck");
      sentWithDiagnostics = sent ? JSON.parse(sent) : null;
      return answer({
        id: "preview-1",
        diagnostics: {
          assembledAt: "2026-09-18T10:00:00.000Z",
          version: { version: "v0.5.1" },
          health: { status: "ok", checks: { database: "ok" } },
          failureWindowDays: 7,
          failures: [],
          events: [],
          ...(sentWithDiagnostics
            ? { connectionCheck: sentWithDiagnostics }
            : {}),
        },
      });
    }
    return undefined;
  },
});

const body = document.body;
const buttonIn = (root: Element | null, name: string) =>
  [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (button) => button.textContent?.trim() === name,
  );
const panel = () =>
  body.querySelector<HTMLElement>('[data-testid="connection-check"]');
const isFinished = () =>
  panel()?.querySelector('[role="status"]')?.textContent?.includes("점검함") ===
  true;

if (scenario.via === "help") {
  const open = buttonIn(view.host, "연결 점검");
  if (!open) throw new Error("연결 점검 is not on the help page");
  await view.click(open);
} else if (scenario.via === "unreachable") {
  await view.waitFor(
    () => body.textContent?.includes("서버에 닿지 못했습니다.") === true,
    "the unreachable screen",
  );
  const open = buttonIn(view.host, "연결 점검");
  if (!open) throw new Error("연결 점검 is not on the unreachable screen");
  await view.click(open);
} else if (scenario.via === "notice") {
  // The feed opens, and then the server goes: the line that says so is what gets pressed.
  await act(async () => {
    feed?.onopen?.({});
  });
  await act(async () => {
    feed?.onclose?.({ code: 1006 });
  });
  await view.waitFor(
    () =>
      body.textContent?.includes("서버와 연결이 끊겼습니다") === true &&
      buttonIn(body, "연결 점검") !== undefined,
    "the lost-connection line",
  );
  await view.click(buttonIn(body, "연결 점검") as HTMLButtonElement);
} else {
  const ask = buttonIn(view.host, "문의·의견");
  if (!ask) throw new Error("문의·의견 is not on the help page");
  await view.click(ask);
  await view.waitFor(
    () => body.querySelector('[role="dialog"]') !== null,
    "the 문의·의견 box",
  );
  const inside = buttonIn(body.querySelector('[role="dialog"]'), "연결 점검");
  if (!inside) throw new Error("연결 점검 is not in the 문의·의견 box");
  await view.click(inside);
}

await view.waitFor(() => panel() !== null, "the check to open");
await view.waitFor(isFinished, "the check to finish", 8000);

const rows: CheckRow[] = [
  ...(panel()?.querySelectorAll<HTMLElement>("[data-check]") ?? []),
].map((row) => {
  const [nameSpan, detailSpan] = [
    ...row.querySelectorAll<HTMLElement>("div > div > span"),
  ].filter((span) => !span.classList.contains("sr-only"));
  const name = nameSpan?.cloneNode(true) as HTMLElement | undefined;
  name?.querySelector(".sr-only")?.remove();
  return {
    id: row.dataset.check ?? "",
    state: row.dataset.state ?? "",
    name: name?.textContent?.trim() ?? "",
    detail: detailSpan?.textContent?.trim() ?? "",
    advice: row.querySelector("p")?.textContent?.trim() ?? "",
  };
});
const summary =
  panel()?.querySelector('[role="status"]')?.textContent?.trim() ?? "";

const copy = buttonIn(panel(), "복사");
if (!copy) throw new Error("복사 is not in the check");
await view.click(copy);
await view.waitFor(() => copied.length > 0, "the clipboard to be written");

let preview: string | null = null;
let alsoSends = false;
if (scenario.via === "feedback") {
  // Closed over the box it was opened from, which is still there with the message in it.
  const checkDialog = panel()?.closest('[role="dialog"]') ?? null;
  const close = buttonIn(checkDialog, "닫기");
  if (!close) throw new Error("the check has no 닫기");
  await view.click(close);
  await view.waitFor(() => panel() === null, "the check to close");
  const box = [...body.querySelectorAll("label")]
    .find((label) => label.textContent?.includes("진단 정보 같이 보내기"))
    ?.querySelector("input");
  if (!box) throw new Error("진단 정보 같이 보내기 is not in the box");
  alsoSends =
    body.textContent?.includes("마지막 연결 점검 결과도 함께 보냅니다.") ===
    true;
  await view.click(box);
  await view.waitFor(
    () => body.querySelector('[data-testid="diagnostics-preview"]') !== null,
    "the diagnostics preview",
  );
  const shownPreview = body
    .querySelector('[data-testid="diagnostics-preview"]')
    ?.cloneNode(true) as Element | undefined;
  shownPreview?.querySelector('[data-testid="diagnostics-exact"]')?.remove();
  preview = shownPreview?.textContent ?? null;
}

const shown: CheckShown = {
  rows,
  summary,
  copied: copied[0] ?? null,
  sockets: socketsOpened,
  sentWithDiagnostics,
  preview,
  alsoSends,
};
console.log(`CHECK_RENDER ${JSON.stringify(shown)}`);
await view.unmount();
process.exit(0);
