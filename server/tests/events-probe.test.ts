import { afterAll, describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createChannelEventHub } from "../src/channels/events";
import {
  createEventRoutes,
  EVENTS_PROBE_FRAME,
} from "../src/channels/events-routes";
import { websocket } from "../src/channels/socket";

/**
 * The activity feed's probe, through a real Bun server — the one way to reach an upgrade.
 *
 * The connection check opens it to learn whether this network lets a live socket through
 * (`app/src/lib/support/connection-check.ts`). The feed says nothing until something moves, so the
 * probe is answered at once; and the hub must never count it, because a notification counts as
 * delivered once any socket of its person's took it (`notifications/in-app.ts`).
 */

const ORIGIN = "http://app.laf.test";

/** Who is asking, from a header, so each test says it outright. */
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  const id = context.req.header("x-test-actor");
  if (!id) {
    return context.json(
      { error: "laf:unauthenticated", code: "laf:unauthenticated" },
      401,
    );
  }
  context.set("actor", { id, email: `${id}@laf.test`, role: "user" });
  await next();
};

const hub = createChannelEventHub();
/** Every person the hub was asked to hold a socket for. */
const registered: string[] = [];
const watchedHub = {
  ...hub,
  register: (...args: Parameters<typeof hub.register>) => {
    registered.push(args[0]);
    return hub.register(...args);
  },
};

const app = new Hono<{ Variables: AppVariables }>();
app.route(
  "/api/channels",
  createEventRoutes(watchedHub, requireUser, [ORIGIN]),
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

type Heard = { opened: boolean; frames: string[]; code: number | null };

/** A socket to its end, or to `untilMs`: whether it opened, what it was sent, how it was closed. */
const listen = (
  path: string,
  headers: Record<string, string>,
  untilMs = 2_000,
): Promise<Heard & { socket: WebSocket }> => {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, {
    headers,
  } as never);
  const heard: Heard = { opened: false, frames: [], code: null };
  socket.onopen = () => {
    heard.opened = true;
  };
  socket.onmessage = (event) => heard.frames.push(String(event.data));
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ...heard, socket }), untilMs);
    socket.onclose = (event) => {
      clearTimeout(timer);
      heard.code = event.code;
      resolve({ ...heard, socket });
    };
  });
};

describe("the activity feed's probe", () => {
  test("is answered with one frame and closed, and the hub never holds it", async () => {
    registered.length = 0;
    const heard = await listen("/api/channels/events?probe=1", {
      origin: ORIGIN,
      "x-test-actor": "owner",
    });

    expect(heard.opened).toBe(true);
    expect(heard.frames).toEqual([EVENTS_PROBE_FRAME]);
    expect(JSON.parse(EVENTS_PROBE_FRAME)).toEqual({ kind: "probe" });
    expect(heard.code).toBe(1000);
    expect(registered).toEqual([]);
    expect(hub.connectionCount("owner")).toBe(0);
  });

  test("passes the same doors the feed does: no session and a foreign origin are refused", async () => {
    const anonymous = await listen("/api/channels/events?probe=1", {
      origin: ORIGIN,
    });
    const foreign = await listen("/api/channels/events?probe=1", {
      origin: "https://another-customer.agent.laf-co.com",
      "x-test-actor": "owner",
    });

    for (const heard of [anonymous, foreign]) {
      expect(heard.opened).toBe(false);
      expect(heard.frames).toEqual([]);
    }
  });

  test("the feed itself still registers, and says nothing first", async () => {
    registered.length = 0;
    const heard = await listen(
      "/api/channels/events",
      { origin: ORIGIN, "x-test-actor": "owner" },
      300,
    );

    expect(heard.opened).toBe(true);
    expect(heard.frames).toEqual([]);
    expect(registered).toEqual(["owner"]);
    expect(hub.connectionCount("owner")).toBe(1);
    heard.socket.close();
  });
});
