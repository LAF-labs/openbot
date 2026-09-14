import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { UserRole } from "../src/auth/roles";
import type { websocket as channelSocket } from "../src/channels/socket";
import { createDemonstrationRecorder } from "../src/computer/demonstration";
import type { ScreenViewer } from "../src/computer/screen-view";
import {
  createLiveScreen,
  describePointOn,
  type LiveScreen,
  type SocketData,
} from "../src/live-screen";

/**
 * The live screen, driven through a real Bun server and a fake computer.
 *
 * It lived in `main.ts` until 2026-09-14, where the only way to reach it was to start the whole
 * process — so the socket a person's keystrokes travel down, into a browser holding their logins,
 * had its refusals and its relay covered by nothing but a boot. These are the same checks, one
 * process and two ports.
 */

const ORIGIN = "http://app.laf.test";
const TOKEN = "computer-token";
const OWNER = "owner-1";
const BOT = "agent_screen-owner";
const SOMEBODY_ELSES = "agent_screen-other";

/** What the fake computer was asked, in order. */
let computerSaw: Array<Record<string, unknown>> = [];

const computer = Bun.serve<{ bot: string | null; token: string | null }>({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/stream") {
      const data = {
        bot: url.searchParams.get("bot"),
        token: url.searchParams.get("token"),
      };
      return server.upgrade(request, { data })
        ? undefined
        : new Response("no", { status: 400 });
    }
    if (url.pathname === "/describe-point") {
      computerSaw.push({
        describePoint: await request.json(),
        bot: request.headers.get("x-openbot-bot-id"),
        authorization: request.headers.get("authorization"),
      });
      return Response.json({ element: { role: "button", name: "결제하기" } });
    }
    return new Response("nf", { status: 404 });
  },
  websocket: {
    open(ws) {
      computerSaw.push({ opened: ws.data });
      ws.send("frame-1");
    },
    message(_ws, message) {
      computerSaw.push({ input: String(message) });
    },
  },
});

const computerConfig = {
  baseUrl: `http://127.0.0.1:${computer.port}/`,
  token: TOKEN,
  allowPrivateHosts: false,
};

const opened: Array<{ botId: string; viewer: ScreenViewer }> = [];
const channelCalls: string[] = [];
/** Hono's adapter, as far as the dispatch reaches it: which of its three handlers was called. */
const fakeChannels = {
  open: () => channelCalls.push("open"),
  message: () => channelCalls.push("message"),
  close: () => channelCalls.push("close"),
} as unknown as typeof channelSocket;

const demonstrations = createDemonstrationRecorder({
  namePoint: describePointOn(computerConfig),
});

/** Who is asking, from a header, so each test says it outright. */
const actorOf = async (request: Request) => {
  const id = request.headers.get("x-test-actor");
  return id ? { id, role: "user" as UserRole } : null;
};

const liveScreenWith = (computerSetting: typeof computerConfig | undefined) =>
  createLiveScreen({
    computer: computerSetting,
    trustedOrigins: [ORIGIN],
    actorOf,
    botOwner: async (botId) =>
      botId === BOT ? OWNER : botId === SOMEBODY_ELSES ? "owner-2" : undefined,
    screenViews: {
      opened: async (botId, viewer) => {
        opened.push({ botId, viewer });
      },
      replayed: async () => {},
    },
    demonstrations,
  });

/** The process's own `fetch`, as `main.ts` writes it, with a Hono-style socket on `/channel`. */
const serverFor = (live: LiveScreen) =>
  Bun.serve<SocketData>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      const botId = live.botOf(request);
      if (botId !== null) return live.upgrade(request, server, botId);
      if (new URL(request.url).pathname === "/channel") {
        return server.upgrade(request, { data: {} as SocketData })
          ? undefined
          : new Response("no", { status: 400 });
      }
      return new Response("the app");
    },
    websocket: live.websocket(fakeChannels),
  });

const live = liveScreenWith(computerConfig);
const server = serverFor(live);
const withoutComputer = serverFor(liveScreenWith(undefined));

afterAll(() => {
  server.stop(true);
  withoutComputer.stop(true);
  computer.stop(true);
});

beforeEach(() => {
  computerSaw = [];
  opened.length = 0;
  channelCalls.length = 0;
});

const upgradeHeaders = (headers: Record<string, string> = {}) => ({
  upgrade: "websocket",
  connection: "Upgrade",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  "sec-websocket-version": "13",
  ...headers,
});

/** An upgrade that is refused comes back as an ordinary response, which `fetch` can read. */
const refusal = async (
  path: string,
  headers: Record<string, string>,
  target = server,
) => {
  const response = await fetch(`http://127.0.0.1:${target.port}${path}`, {
    headers: upgradeHeaders(headers),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.startsWith("{") ? JSON.parse(text) : text,
  };
};

const until = async (check: () => boolean) => {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
};

/**
 * A screen, open end to end: the first frame has come back, so the socket inward is open too. Input
 * sent before that is dropped rather than queued — on purpose, see the proxy's `open`.
 */
const openScreen = async (botId: string) => {
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.port}/api/computers/${botId}/stream`,
    { headers: { origin: ORIGIN, "x-test-actor": OWNER } } as never,
  );
  const frames: string[] = [];
  socket.onmessage = (event) => frames.push(String(event.data));
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("the screen did not open"));
  });
  await until(() => frames.length > 0);
  return { socket, frames };
};

describe("which requests are the live screen's", () => {
  test("an upgrade on a Bot's stream path, and nothing else", () => {
    const at = (path: string, headers: Record<string, string> = {}) =>
      live.botOf(new Request(`http://laf.test${path}`, { headers }));

    expect(at(`/api/computers/${BOT}/stream`, { upgrade: "websocket" })).toBe(
      BOT,
    );
    expect(
      at("/api/computers/agent%5Fx/stream", { upgrade: "WebSocket" }),
    ).toBe("agent_x");
    // The same path without an upgrade is the app's.
    expect(at(`/api/computers/${BOT}/stream`)).toBeNull();
    expect(at("/api/channels/events", { upgrade: "websocket" })).toBeNull();
  });
});

describe("the refusals, before anything is opened inward", () => {
  test("no computer configured is a 503", async () => {
    const answer = await refusal(
      `/api/computers/${BOT}/stream`,
      { origin: ORIGIN, "x-test-actor": OWNER },
      withoutComputer,
    );
    expect(answer.status).toBe(503);
  });

  test("an Origin that is missing or foreign is refused first, by code", async () => {
    const attempts: Record<string, string>[] = [
      { "x-test-actor": OWNER },
      {
        origin: "https://another-customer.agent.laf-co.com",
        "x-test-actor": OWNER,
      },
    ];
    for (const headers of attempts) {
      expect(await refusal(`/api/computers/${BOT}/stream`, headers)).toEqual({
        status: 403,
        body: { error: "laf:origin_refused", code: "laf:origin_refused" },
      });
    }
  });

  test("a malformed id, nobody signed in, and somebody else's Bot are each their own fact", async () => {
    expect(
      await refusal(`/api/computers/${encodeURIComponent("../etc")}/stream`, {
        origin: ORIGIN,
        "x-test-actor": OWNER,
      }),
    ).toEqual({
      status: 400,
      body: { error: "laf:bot_id_invalid", code: "laf:bot_id_invalid" },
    });
    expect(
      await refusal(`/api/computers/${BOT}/stream`, { origin: ORIGIN }),
    ).toEqual({
      status: 401,
      body: { error: "laf:unauthenticated", code: "laf:unauthenticated" },
    });
    expect(
      await refusal(`/api/computers/${SOMEBODY_ELSES}/stream`, {
        origin: ORIGIN,
        "x-test-actor": OWNER,
      }),
    ).toEqual({
      status: 404,
      body: { error: "laf:bot_not_found", code: "laf:bot_not_found" },
    });
    expect(computerSaw).toEqual([]);
    expect(opened).toEqual([]);
  });
});

describe("an opened screen", () => {
  test("relays frames outward and input inward, to that Bot's computer with the token", async () => {
    const { socket, frames } = await openScreen(BOT);
    expect(frames).toEqual(["frame-1"]);
    // The Bot and the secret travel in the query, because an upgrade carries no custom header.
    expect(computerSaw[0]).toEqual({ opened: { bot: BOT, token: TOKEN } });
    // One row per socket, for the person who opened it.
    expect(opened).toEqual([
      { botId: BOT, viewer: { id: OWNER, role: "user" } },
    ]);

    socket.send("not json, forwarded all the same");
    await until(() => computerSaw.length > 1);
    expect(computerSaw[1]).toEqual({
      input: "not json, forwarded all the same",
    });
    socket.close();
  });

  test("while somebody is teaching, a press is recorded and named by the Bot's computer", async () => {
    demonstrations.start(BOT, OWNER);
    const { socket } = await openScreen(BOT);
    const press = JSON.stringify({
      type: "mouse",
      event: "pressed",
      x: 12,
      y: 34,
    });
    socket.send(press);
    // The name arrives after the step does: the lookup is fired and not awaited.
    await until(() => {
      const step = demonstrations.read(BOT, OWNER)?.steps[0];
      return step?.kind === "pressed" && step.element !== null;
    });

    // Forwarded, not swallowed: the recorder is told and the press still reaches the browser.
    expect(computerSaw).toContainEqual({ input: press });
    // Asked by HEADER, with the token — a query would silently be nobody's blank page.
    expect(computerSaw).toContainEqual({
      describePoint: { x: 12, y: 34 },
      bot: BOT,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(demonstrations.read(BOT, OWNER)?.steps[0]).toMatchObject({
      kind: "pressed",
      element: { role: "button", name: "결제하기" },
    });
    socket.close();
    demonstrations.discard(BOT, OWNER);
  });

  test("a socket the app upgraded is handed to the channels, not proxied", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/channel`);
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve();
    });
    socket.send("hello");
    await until(() => channelCalls.includes("message"));
    socket.close();
    await until(() => channelCalls.includes("close"));
    expect(channelCalls).toEqual(["open", "message", "close"]);
    expect(computerSaw).toEqual([]);
  });
});

describe("naming a point", () => {
  test("says nothing, and asks nobody, when there is no computer", async () => {
    expect(await describePointOn(undefined)(BOT, { x: 1, y: 1 })).toBeNull();
  });
});
