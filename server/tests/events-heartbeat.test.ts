import { afterAll, describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  HEARTBEAT_CLOSE_CODE,
  PING_FRAME,
  PONG_FRAME,
} from "../../shared/channel-socket";
import type { AppVariables } from "../src/auth/guards";
import { createChannelEventHub } from "../src/channels/events";
import { createEventRoutes } from "../src/channels/events-routes";
import { type HeartbeatTiming, websocket } from "../src/channels/socket";
import { createFinishedNotice } from "../src/notifications/in-app";
import type { NotificationOutbox } from "../src/notifications/outbox";

/**
 * A SOCKET COUNTS AS A LISTENER ONLY WHILE ITS PAGE IS HEARD FROM.
 *
 * P2's measurement (2026-09-26): with the app's window put away, its page stopped running and its
 * socket stayed open — the operating system kept answering the protocol's pings — so the hub went
 * on counting it, every notice was written down it and stamped delivered, and nobody saw one. Here a
 * real Bun server holds real sockets on a shortened clock: one page that answers, one that has gone
 * silent, and one from before the heartbeat existed.
 */

const ORIGIN = "http://app.laf.test";

/** Fast enough for a test, and in the same proportions as the production numbers. */
const TIMING: HeartbeatTiming = {
  pingAfterMs: 100,
  liveForMs: 250,
  closeAfterMs: 450,
  tickMs: 50,
};

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  const id = context.req.header("x-test-actor") ?? "owner";
  context.set("actor", { id, email: `${id}@laf.test`, role: "user" });
  await next();
};

const hub = createChannelEventHub();
const app = new Hono<{ Variables: AppVariables }>();
app.route(
  "/api/channels",
  createEventRoutes(hub, requireUser, [ORIGIN], TIMING),
);

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request, bunServer) => app.fetch(request, { server: bunServer }),
  websocket,
});

afterAll(() => {
  server.stop(true);
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Page = {
  socket: WebSocket;
  frames: string[];
  closedWith: () => number | null;
};

/** A page's socket, opened and waited for. `answers` says whether its code answers pings. */
async function openPage(
  actor: string,
  query: string,
  answers: boolean,
): Promise<Page> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.port}/api/channels/events${query}`,
    { headers: { origin: ORIGIN, "x-test-actor": actor } } as never,
  );
  const frames: string[] = [];
  let code: number | null = null;
  socket.onmessage = (event) => {
    const data = String(event.data);
    frames.push(data);
    if (answers && data === PING_FRAME) socket.send(PONG_FRAME);
  };
  socket.onclose = (event) => {
    code = event.code;
  };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("the socket did not open"));
  });
  // The upgrade's `onOpen` runs on the server's side of the same tick; give it one.
  await wait(20);
  return { socket, frames, closedWith: () => code };
}

describe("the server's half of the heartbeat", () => {
  test("a page's ping is answered with a pong", async () => {
    const page = await openPage("pinger", "?heartbeat=1", true);
    page.socket.send(PING_FRAME);
    await wait(40);
    expect(page.frames).toContain(PONG_FRAME);
    page.socket.close();
  });

  test("a page that answers keeps counting, well past the listening window", async () => {
    const page = await openPage("answering", "?heartbeat=1", true);
    expect(hub.connectionCount("answering")).toBe(1);

    await wait(TIMING.closeAfterMs + 200);

    // It was pinged because it said nothing of its own, and it answered every time.
    expect(page.frames.filter((frame) => frame === PING_FRAME).length).toBe(
      page.frames.length,
    );
    expect(page.frames.length).toBeGreaterThan(0);
    expect(hub.connectionCount("answering")).toBe(1);
    expect(page.closedWith()).toBeNull();
    page.socket.close();
  });

  test("a page gone silent stops counting while its socket is still open, and is then closed", async () => {
    const page = await openPage("asleep", "?heartbeat=1", false);
    expect(hub.connectionCount("asleep")).toBe(1);

    // Past the listening window and short of the close: open, and no longer a listener.
    await wait(TIMING.liveForMs + 80);
    expect(page.socket.readyState).toBe(WebSocket.OPEN);
    expect(page.frames).toContain(PING_FRAME);
    expect(hub.connectionCount("asleep")).toBe(0);

    await wait(TIMING.closeAfterMs - TIMING.liveForMs + 120);
    expect(page.closedWith()).toBe(HEARTBEAT_CLOSE_CODE);
    expect(hub.connectionCount("asleep")).toBe(0);
  });

  test("the notice for a finished run is written when the only socket has gone silent", async () => {
    const written: string[] = [];
    const outbox = {
      enqueue: async (input: { userId: string }) => {
        written.push(input.userId);
        return null;
      },
    } as unknown as NotificationOutbox;
    const notice = createFinishedNotice(hub, outbox);
    const activity = {
      channelId: "channel-1",
      memberIds: ["dozing"],
      name: "Conversation",
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: "bot-1",
    };

    const page = await openPage("dozing", "?heartbeat=1", false);
    notice(activity);
    // Heard from a moment ago: the page is there, and it hears the activity itself.
    expect(written).toEqual([]);

    await wait(TIMING.liveForMs + 80);
    notice(activity);
    // Silent: the socket is open and nobody is behind it, so the notice is written for later.
    expect(written).toEqual(["dozing"]);
    page.socket.close();
  });

  test("a page from before the heartbeat is held as before: never pinged, never closed, always counted", async () => {
    const page = await openPage("legacy", "", false);

    await wait(TIMING.closeAfterMs + 150);

    expect(page.frames).toEqual([]);
    expect(page.closedWith()).toBeNull();
    expect(hub.connectionCount("legacy")).toBe(1);
    page.socket.close();
    await wait(40);
    expect(hub.connectionCount("legacy")).toBe(0);
  });
});

describe("the hub's count of listeners", () => {
  test("counts a connection only while it says its page is there", () => {
    const local = createChannelEventHub();
    let isAwake = true;
    const detach = local.register(
      "person",
      () => {},
      () => {},
      () => isAwake,
    );
    local.register("person", () => {});

    expect(local.connectionCount("person")).toBe(2);
    isAwake = false;
    expect(local.connectionCount("person")).toBe(1);
    detach();
    expect(local.connectionCount("person")).toBe(1);
  });
});
