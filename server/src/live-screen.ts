/**
 * The live screen, proxied.
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
import { CONNECTION_PROBE_PARAM } from "../../shared/support/connection-check";
import { ORIGIN_REFUSED, upgradeOriginAllowed } from "./auth/origin";
import type { UserRole } from "./auth/roles";
import {
  SESSION_REVOKED,
  type SessionRevocation,
} from "./auth/session-revocation";
import { streamBotAccess } from "./auth/stream-access";
import type { BotOwnerLookup } from "./auth/guards";
import type { websocket as channelSocket } from "./channels/socket";
import type { ScreenViewAudit, ScreenViewer } from "./computer/screen-view";
import type { DeploymentConfig } from "./config";
import { describeFailure } from "./failure-text";
import { log } from "./log";

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
  /** Which Bot's browser this socket shows, for the row `open` writes. */
  botId: string;
};

/**
 * The connection check's socket on this door (`app/src/lib/support/connection-check.ts`).
 *
 * It clears every gate a screen does — the computer, the origin, the session, whose Bot it is — and
 * is then answered with one frame and closed. NOTHING INWARD: the computer keeps one viewer per Bot
 * and a new one replaces the last (`agent-computer/src/live-screen.ts`), so a check that opened the
 * real stream would freeze the picture in any window already watching that Bot. And NO ROW: the trail's line says a person looked at a Bot's
 * screen (`computer/screen-view.ts`), and a check shows nobody anything.
 */
type ProbeData = { screenProbe: true };

/** The frame a probe is answered with — `type`, as every frame on this socket is keyed. */
export const SCREEN_PROBE_FRAME = JSON.stringify({ type: "probe" });

/**
 * How far behind a viewer may fall before its pictures are dropped: about half a second of the live
 * screen at the rate the computer now sends (~1 MB/s, `agent-computer/src/live-screen.ts`).
 */
const RELAY_BACKLOG_BYTES = 512 * 1024;

/**
 * Bun takes exactly one WebSocket handler for the server, and two features need one: this proxies
 * the computer stream, and the channels push their activity through Hono's adapter. So the handler
 * dispatches on what the upgrade attached — a proxy socket carries `upstream`, a probe carries
 * `screenProbe`, a Hono socket carries neither — rather than either feature quietly taking the slot
 * and breaking the other on connect.
 */
type ChannelSocket = Parameters<typeof channelSocket.open>[0];
export type SocketData = StreamData | ProbeData | ChannelSocket["data"];

const isProxiedStream = (data: SocketData): data is StreamData =>
  typeof (data as StreamData).upstream === "string";

const isProbe = (data: SocketData): data is ProbeData =>
  (data as ProbeData).screenProbe === true;

// Hono owns the socket's data once it has upgraded it; this hands its own back to it.
const asChannelSocket = (ws: { data: SocketData }) => ws as ChannelSocket;

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

/*
 * The three the upgrade answered in English until 2026-09-14, as plain text: "No computer is
 * configured.", "Expected a WebSocket upgrade.", and whatever building the inward address threw. A
 * browser's WebSocket never shows its page a refused handshake's body, so no screen printed them;
 * a proxy's log and anybody with curl did, and the rule is the wire's, not the screen's.
 */
/** This deployment runs no computer, so there is no screen behind any Bot. */
const COMPUTER_NOT_CONFIGURED = "laf:computer_not_configured";
/** The request named the stream but Bun would not upgrade it — agent-computer's word for the same. */
const UPGRADE_REQUIRED = "laf:stream_upgrade_required";
/** The inward address could not be built. The pane's own word for a screen it could not reach. */
const SCREEN_UNREACHABLE = "laf:screen_unreachable";

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
  /** How many screens this person has open right now. */
  openFor: (userId: string) => number;
};

/**
 * The close code a screen is ended with when its person's sessions are: 4000–4999 is the
 * application's own range (RFC 6455 §7.4.2), and 4401 reads as the 401 every other door answers.
 */
export const SCREEN_SESSION_ENDED = 4401;

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
  /**
   * Where a person's sessions are ended — removed by an administrator, struck off the sign-in list.
   *
   * THE SESSION IS CHECKED ONCE, AT THE UPGRADE, and a socket that opened lives as long as nobody
   * closes it: taking the row away does nothing to a connection already carrying frames out. So the screens a person has open are held here by who opened them, and closed
   * when their sessions end. Absent in the suites that drive the proxy alone.
   */
  sessions?: Pick<SessionRevocation, "onEnded">;
}): LiveScreen {
  const { computer, screenViews } = input;
  /** Every proxied screen open on this process, by the person who opened it. */
  const openByViewer = new Map<string, Set<ServerWebSocket<StreamData>>>();

  input.sessions?.onEnded((userId) => {
    const open = openByViewer.get(userId);
    if (!open) return;
    openByViewer.delete(userId);
    for (const ws of open) {
      /*
       * The person's side first, with the code. Closing inward first handed the browser a plain
       * 1000 (measured): the inward socket's own `onclose` closes this one, and it got there before
       * the line that says why.
       */
      ws.close(SCREEN_SESSION_ENDED, SESSION_REVOKED);
      ws.data.inward?.close();
    }
    log.info("live_screens_closed", { user: userId, screens: open.size });
  });

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
        return fact(COMPUTER_NOT_CONFIGURED, 503);
      }
      /*
       * Where the socket was opened from, checked before anything else and before the session.
       *
       * This is the socket that shows a browser holding a person's real logins — and until
       * 2026-10-09 carried their clicks and keystrokes into it. It checked nothing but the cookie — and every deployment of this product
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
      // After every gate and before anything inward: see `ProbeData`.
      if (new URL(request.url).searchParams.has(CONNECTION_PROBE_PARAM)) {
        return server.upgrade(request, { data: { screenProbe: true } })
          ? undefined
          : fact(UPGRADE_REQUIRED, 400);
      }
      let upstream: string;
      try {
        upstream = toStreamUrl(computer.baseUrl, botId, computer.token ?? "");
      } catch (error) {
        // Said out loud rather than falling back to another Bot's computer, which is the failure this
        // whole path exists to prevent — to the operator as what went wrong, to the caller as a fact.
        log.warn("live_screen_unreachable", {
          bot: botId,
          reason: describeFailure(error),
        });
        return fact(SCREEN_UNREACHABLE, 502);
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
      return fact(UPGRADE_REQUIRED, 400);
    },

    websocket: (channels) => ({
      open(ws: ServerWebSocket<SocketData>) {
        if (isProbe(ws.data)) {
          ws.send(SCREEN_PROBE_FRAME);
          ws.close(1000, "laf:probe_answered");
          return;
        }
        if (!isProxiedStream(ws.data)) {
          channels.open(asChannelSocket(ws));
          return;
        }
        // Once per socket, here and not per frame: the session is the fact. Not awaited — the
        // screen opens whether or not the trail is reachable, as every other computer row does.
        void screenViews.opened(ws.data.botId, ws.data.viewer);
        const viewer = ws.data.viewer.id;
        const held = openByViewer.get(viewer) ?? new Set();
        held.add(ws as ServerWebSocket<StreamData>);
        openByViewer.set(viewer, held);
        const inward = new WebSocket(ws.data.upstream);
        // Frames are bytes (`shared/screen-frame.ts`) and go on as bytes. `String(event.data)` was
        // right while they were JSON text, and would turn a binary frame into "[object ArrayBuffer]".
        inward.binaryType = "arraybuffer";
        ws.data.inward = inward;
        /*
         * Frames outward, and nothing inward (see `message`). A frame the browser is too slow for is dropped, not queued,
         * because a stale frame is worse than a missing one — which this said and did not do: Bun
         * queues whatever `send` cannot write at once, so a slow viewer's backlog grew without bound.
         * A picture is dropped while the viewer is more than {@link RELAY_BACKLOG_BYTES} behind; text
         * (an error, the probe) always goes.
         */
        inward.onmessage = (event) => {
          const isFrame = typeof event.data !== "string";
          if (isFrame && ws.getBufferedAmount() > RELAY_BACKLOG_BYTES) return;
          try {
            ws.send(event.data as string | ArrayBuffer);
          } catch {
            inward.close();
          }
        };
        inward.onclose = () => ws.close();
        inward.onerror = () => ws.close();
      },
      message(ws: ServerWebSocket<SocketData>, raw) {
        /*
         * NOTHING GOES INWARD (owner, 2026-10-09) — from a probe, which has no browser behind it,
         * and from a screen. Every click and keystroke a person made in a Bot's browser, passwords
         * included, used to pass through here on its way to the page. Nobody drives the Bot's
         * browser now, on any surface, and what a window loaded before that still sends is dropped
         * here unread — and again at the computer, which takes nothing from this socket either
         * (`agent-computer/src/live-screen.ts`).
         */
        if (isProbe(ws.data) || isProxiedStream(ws.data)) return;
        channels.message(asChannelSocket(ws), raw);
      },
      close(ws: ServerWebSocket<SocketData>, code, reason) {
        if (isProbe(ws.data)) return;
        if (!isProxiedStream(ws.data)) {
          channels.close(asChannelSocket(ws), code, reason);
          return;
        }
        ws.data.inward?.close();
        const held = openByViewer.get(ws.data.viewer.id);
        if (held) {
          held.delete(ws as ServerWebSocket<StreamData>);
          // Dropped when empty, so a process that runs for months keeps no set per person who ever looked.
          if (held.size === 0) openByViewer.delete(ws.data.viewer.id);
        }
      },
    }),

    openFor: (userId) => openByViewer.get(userId)?.size ?? 0,
  };
}
