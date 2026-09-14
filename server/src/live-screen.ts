/**
 * The live screen, proxied — and the names of the presses somebody makes on it while teaching.
 *
 * Proxied rather than connected directly. `agent-computer` authenticates its callers with a
 * shared token, not with a person's session, and it must never be reachable from a browser. So the
 * socket terminates here, behind the same session guard as every other route, and this process opens
 * a second socket inward carrying the token.
 *
 * Not a Hono route because an upgrade is not a request/response: Bun hands it over before Hono sees a
 * body, so it is handled in `fetch` ahead of the app (`main.ts`). It lived in `main.ts` itself until
 * 2026-09-14, where the only way a test could reach it was to start the whole process.
 */
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { ORIGIN_REFUSED, upgradeOriginAllowed } from "./auth/origin";
import type { UserRole } from "./auth/roles";
import { streamBotAccess } from "./auth/stream-access";
import type { BotOwnerLookup } from "./auth/guards";
import type { websocket as channelSocket } from "./channels/socket";
import type {
  DemonstrationRecorder,
  PointNamer,
} from "./computer/demonstration";
import type { ScreenViewAudit, ScreenViewer } from "./computer/screen-view";
import type { DeploymentConfig } from "./config";

/**
 * What is at a point on a Bot's screen, asked of its computer, for a demonstration's step.
 *
 * It names each press, which is the whole difference between a trace worth writing up and a list of
 * coordinates. See `computer/demonstration.ts`.
 */
export function describePointOn(
  computer: DeploymentConfig["computer"],
): PointNamer {
  return async (botId, point) => {
    if (!computer) return null;
    const response = await fetch(
      `${computer.baseUrl.replace(/\/$/, "")}/describe-point`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          /*
           * THE HEADER, NOT A QUERY. `agent-computer` reads the Bot from `x-openbot-bot-id` and
           * falls back to a default when it is absent — so a query string is not a different Bot,
           * it is silently the wrong one. Measured: every press came back unnameable, because every
           * lookup was asking about a blank page belonging to nobody.
           */
          "x-openbot-bot-id": botId,
          ...(computer.token
            ? { authorization: `Bearer ${computer.token}` }
            : {}),
        },
        body: JSON.stringify(point),
        // A name is a nicety. A lookup that hangs must not sit in a map for the rest of the session.
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      element?: { role?: unknown; name?: unknown } | null;
    };
    const element = body.element;
    return element &&
      typeof element.role === "string" &&
      typeof element.name === "string"
      ? { role: element.role, name: element.name }
      : null;
  };
}

/** What each proxied socket carries: where to connect inward, and the socket once opened. */
type StreamData = {
  upstream: string;
  inward?: WebSocket;
  /**
   * Who opened it, with their role. Resolved at the upgrade — the only moment a session cookie is
   * in hand — and carried so `open` can write the row once the socket actually exists, rather than
   * at the upgrade, where a refused upgrade would leave a row saying a screen was watched.
   */
  viewer: ScreenViewer;
  /**
   * Which Bot's browser this socket drives.
   *
   * Carried so a demonstration can be recorded from the messages passing through. The proxy is
   * otherwise byte-for-byte and has no reason to know — see the `message` handler for the one line
   * that reads it, and `demonstration.ts` for why that line is where teaching happens.
   */
  botId: string;
};

/**
 * Bun takes exactly one WebSocket handler for the server, and two features need one: this proxies
 * the computer stream, and the channels push their activity through Hono's adapter. So the handler
 * dispatches on what the upgrade attached — a proxy socket carries `upstream`, a Hono socket does
 * not — rather than either feature quietly taking the slot and breaking the other on connect.
 */
type ChannelSocket = Parameters<typeof channelSocket.open>[0];
export type SocketData = StreamData | ChannelSocket["data"];

const isProxiedStream = (data: SocketData): data is StreamData =>
  typeof (data as StreamData).upstream === "string";

// Hono owns the socket's data once it has upgraded it; this hands its own back to it.
const asChannelSocket = (ws: { data: SocketData }) =>
  ws as unknown as ChannelSocket;

const toStreamUrl = (baseUrl: string, botId: string, token: string) =>
  // The Bot travels in the query, because a websocket upgrade carries no custom header for the
  // computer to read and every call it serves is per Bot. The secret travels the same way and for the
  // same reason, this socket is the one a person can type into, so it is the last thing that should
  // be reachable without it.
  `${baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/stream?bot=${encodeURIComponent(botId)}&token=${encodeURIComponent(token)}`;

/**
 * A refusal from the upgrade path, as a fact code and nothing else.
 *
 * Written by hand because an upgrade is handled in `fetch`, ahead of Hono, so `context.json` is not
 * available here. Same shape as every other refusal in this server: a code the surface owns the
 * words for, never a sentence meant for a screen.
 */
const fact = (code: string, status: number) =>
  new Response(JSON.stringify({ error: code, code }), {
    status,
    headers: { "content-type": "application/json" },
  });

export type LiveScreen = {
  /**
   * Which Bot's screen this request is an upgrade for, or null when it is not one.
   *
   * The Bot is named in the path and its computer is located the same way every other call locates
   * it, so the live stream cannot point at a different Bot's browser.
   */
  botOf: (request: Request) => string | null;
  /** Answer the upgrade: a refusal, or `undefined` once Bun has taken the connection over. */
  upgrade: (
    request: Request,
    server: Server<SocketData>,
    botId: string,
  ) => Promise<Response | undefined>;
  /** The server's one WebSocket handler, for both the proxy and the channel sockets. */
  websocket: (channels: typeof channelSocket) => WebSocketHandler<SocketData>;
};

export function createLiveScreen(input: {
  /** Absent means no computer, and every upgrade is answered 503. */
  computer: DeploymentConfig["computer"];
  trustedOrigins: readonly string[];
  /** Who is opening it, or null. Never the anonymous fallback: this decides whose screen is served. */
  actorOf: (request: Request) => Promise<{ id: string; role: UserRole } | null>;
  /**
   * Whose the Bot is, through the same lookup `requireUser` hands every route — not the profile
   * store's `get`, which answers what the person may SEE and let a public Bot's socket open for
   * anybody signed in. See auth/stream-access.ts.
   */
  botOwner: BotOwnerLookup;
  /** The row a looked-at screen leaves. */
  screenViews: ScreenViewAudit;
  /** Where teaching is recorded from the messages passing through. */
  demonstrations: DemonstrationRecorder;
}): LiveScreen {
  const { computer, demonstrations, screenViews } = input;

  return {
    botOf(request) {
      const match = new URL(request.url).pathname.match(
        /^\/api\/computers\/([^/]+)\/stream$/,
      );
      const botId = match?.[1] ? decodeURIComponent(match[1]) : null;
      return botId !== null &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
        ? botId
        : null;
    },

    async upgrade(request, server, botId) {
      if (!computer) {
        return new Response("No computer is configured.", { status: 503 });
      }
      /*
       * Where the socket was opened from, checked before anything else and before the session.
       *
       * This is the socket a person's clicks and keystrokes travel down, into a browser holding
       * their real logins. It checked nothing but the cookie — and every deployment of this product
       * is a name under one registrable domain, so `SameSite=Lax` sends that cookie on a socket
       * opened from another customer's page. An upgrade with no `Origin` at all is refused too: a
       * browser always sends one on a handshake, and nothing but a browser drives this.
       */
      if (!upgradeOriginAllowed(request.headers, input.trustedOrigins)) {
        return fact(ORIGIN_REFUSED, 403);
      }
      /*
       * The session guard AND the Bot, applied by hand because middleware does not run on an
       * upgrade. The person was already resolved here and the answer was thrown away — see
       * `streamBotAccess`, which is the whole check now.
       */
      const actor = await input.actorOf(request);
      const access = await streamBotAccess(botId, actor, input.botOwner);
      if (access === "bad_id") {
        return fact("laf:bot_id_invalid", 400);
      }
      // `|| !actor` says nothing the rule did not; it is here so the compiler knows it too.
      if (access === "unauthenticated" || !actor) {
        return fact("laf:unauthenticated", 401);
      }
      if (access === "not_found") {
        return fact("laf:bot_not_found", 404);
      }
      let upstream: string;
      try {
        upstream = toStreamUrl(computer.baseUrl, botId, computer.token ?? "");
      } catch (error) {
        // Said out loud rather than falling back to another Bot's computer, which is the failure this
        // whole path exists to prevent.
        return new Response(
          error instanceof Error
            ? error.message
            : "That Bot's computer could not be reached.",
          { status: 502 },
        );
      }
      if (
        server.upgrade(request, {
          data: {
            upstream,
            botId,
            viewer: { id: actor.id, role: actor.role },
          },
        })
      ) {
        return undefined;
      }
      return new Response("Expected a WebSocket upgrade.", { status: 400 });
    },

    websocket: (channels) => ({
      open(ws: ServerWebSocket<SocketData>) {
        if (!isProxiedStream(ws.data)) {
          channels.open(asChannelSocket(ws));
          return;
        }
        // Once per socket, here and not per frame: the session is the fact. Not awaited — the
        // screen opens whether or not the trail is reachable, as every other computer row does.
        void screenViews.opened(ws.data.botId, ws.data.viewer);
        const inward = new WebSocket(ws.data.upstream);
        ws.data.inward = inward;
        // Frames outward, input inward. Buffered by neither side: a frame the browser is too slow for
        // should be dropped, not queued, because a stale frame is worse than a missing one.
        inward.onmessage = (event) => {
          try {
            ws.send(String(event.data));
          } catch {
            inward.close();
          }
        };
        inward.onclose = () => ws.close();
        inward.onerror = () => ws.close();
      },
      message(ws: ServerWebSocket<SocketData>, raw) {
        if (!isProxiedStream(ws.data)) {
          channels.message(asChannelSocket(ws), raw);
          return;
        }
        const text = String(raw);
        /*
         * WHERE TEACHING HAPPENS, and the only place it could.
         *
         * Every click and keystroke a person makes in a Bot's browser passes through this line on its
         * way there. When they are showing the Bot how a task is done, that is the demonstration —
         * and nothing else in this process ever sees these messages.
         *
         * Before the forward, never instead of it: the recorder is told and the message goes on
         * regardless. It cannot throw and does not wait; see `observe`.
         */
        if (demonstrations.recording(ws.data.botId)) {
          try {
            demonstrations.observe(ws.data.botId, JSON.parse(text));
          } catch {
            // Not JSON, so not an input message this understands. Forwarded all the same.
          }
        }
        if (ws.data.inward?.readyState === 1) ws.data.inward.send(text);
      },
      close(ws: ServerWebSocket<SocketData>, code, reason) {
        if (!isProxiedStream(ws.data)) {
          channels.close(asChannelSocket(ws), code, reason);
          return;
        }
        ws.data.inward?.close();
      },
    }),
  };
}
