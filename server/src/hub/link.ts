/**
 * This VM's line to its company hub: who it is there, what has changed, and whether the line is up.
 *
 * THE SHAPE (hub design §4, appendix A.2). At boot, `GET /me` — who this pass belongs to, which
 * company, the newest event's number. Then one WebSocket to `/events?since=<cursor>`, the cursor
 * from `hub_cursor`: the hub sends what was missed and then each event as it is committed. A dropped
 * socket is tried again after 1 s, 2 s, 4 s … at most 30 s, each time `/me` first; while it is down,
 * `/sync?since=` is asked every 30 s, so a VM that can reach the hub over HTTP but not hold a socket
 * still hears everything, only later. Every event is passed to the app's own socket as a `hub.*`
 * frame — the browser never talks to the hub and never learns its address or the pass.
 *
 * A REFUSED PASS IS SAID ONCE AND NOT TRIED AGAIN. A 401 on `/me`, or the hub closing the socket
 * with 4401 (the member left), means this pass opens nothing; asking again every second would be a
 * VM knocking on a locked door forever, and every knock a line in somebody's log. So the line goes
 * to `refused`, one log line says so, and nothing is sent until a restart brings another pass
 * (`laf hub rotate` restarts the server).
 *
 * THE HUB'S OWN HEARTBEAT IS THE ONE THAT COUNTS. It pings every ten seconds and drops a socket it
 * has not heard from in thirty, so this end answers every ping, and gives the socket up itself when
 * it has heard nothing in thirty: a hub that froze, or a network that swallowed the connection
 * without closing it, is otherwise a line that says 연결됨 and hears nothing.
 */
import {
  HEARTBEAT_MS,
  heartbeatFrameKind,
  PONG_FRAME,
} from "../../../shared/channel-socket";
import {
  HUB_EVENT_TYPES,
  HUB_FACTS,
  type HubEvent,
  type HubMe,
  type HubSync,
} from "../../../shared/hub/protocol";
import type { Database } from "../db/client";
import { log } from "../log";
import { readHubCursor, writeHubCursor } from "./cursor";
import type { HubHttp } from "./http";

export type HubLinkState =
  /** Not reached yet since boot. */
  | "connecting"
  /** The socket is open. */
  | "connected"
  /** It was reached, or tried, and is not now. Being tried again. */
  | "disconnected"
  /** The pass was refused. Not tried again until a restart. */
  | "refused";

export type HubStatus = {
  state: HubLinkState;
  /** Why it is not connected, as a fact; null when it is. */
  code: string | null;
  /** From the last `/me` that answered. */
  workspace: { name: string } | null;
  member: { role: string; name: string | null } | null;
  /** When `state` last changed, ISO 8601. */
  since: string;
};

/** What reaches the app's socket. The browser drops a `hub.*` kind it does not know. */
export type HubFrame =
  | ({ kind: `hub.${string}` } & Omit<HubEvent, "type">)
  | ({ kind: "hub.status" } & HubStatus)
  | HubDocHoldFrame;

/**
 * Who is writing in which document block ("쓰는 중"), passed on as the hub sent it: a light frame,
 * not an event — not numbered, not kept, never caught up after an outage, since a hold lives
 * seconds and the editor reads the standing holds when it opens a document. `until` null: let go.
 */
export type HubDocHoldFrame = {
  kind: "hub.doc.lock";
  doc: string;
  block: string;
  member: string;
  name: string | null;
  until: string | null;
};

/** The hub's `doc.lock` frame as this VM passes it on, or null when it is not one. */
export function docHoldFrame(frame: unknown): HubDocHoldFrame | null {
  if (typeof frame !== "object" || frame === null) return null;
  const hold = frame as Record<string, unknown>;
  if (hold.kind !== "doc.lock") return null;
  const { doc, block, member, name, until } = hold;
  if (
    typeof doc !== "string" ||
    typeof block !== "string" ||
    typeof member !== "string" ||
    (name !== null && typeof name !== "string") ||
    (until !== null && typeof until !== "string")
  ) {
    return null;
  }
  return { kind: "hub.doc.lock", doc, block, member, name, until };
}

export type HubLinkTiming = {
  firstRetryMs: number;
  maxRetryMs: number;
  /** `/sync` while the socket is down. */
  pollMs: number;
  /** How long the socket may be silent before it is given up on. */
  silenceMs: number;
};

export const HUB_LINK_TIMING: HubLinkTiming = {
  firstRetryMs: 1_000,
  maxRetryMs: 30_000,
  pollMs: 30_000,
  // Three of the hub's pings: the same rule it holds this end to.
  silenceMs: 3 * HEARTBEAT_MS,
};

export type HubLink = {
  start(): void;
  stop(): void;
  status(): HubStatus;
  /** The `/me` the line last read, or null before one answered. */
  me(): HubMe | null;
  /** Another caller met a 401 (the outbox, a route): the same as the line meeting it. */
  passRefused(reason: string): void;
};

const KNOWN_TYPES: ReadonlySet<string> = new Set(HUB_EVENT_TYPES);

/** The WebSocket constructor, Bun's, which takes headers. Injected in tests. */
type SocketFactory = (
  url: string,
  headers: Record<string, string>,
) => WebSocket;

const bunSocket: SocketFactory = (url, headers) =>
  // Bun's constructor takes `{ headers }`; the DOM's type does not know it.
  new WebSocket(url, { headers } as unknown as string[]);

export function createHubLink(input: {
  database: Database;
  http: HubHttp;
  /** The hub's origin: what the cursor is kept against. */
  hub: string;
  /** The app's socket, every connection of the deployment's person. */
  deliver: (frame: HubFrame) => void;
  /** The hub answered again after being away: the outbox is offered what it kept. */
  onReachable?: () => void;
  timing?: HubLinkTiming;
  openSocket?: SocketFactory;
}): HubLink {
  const timing = input.timing ?? HUB_LINK_TIMING;
  const openSocket = input.openSocket ?? bunSocket;
  let status: HubStatus = {
    state: "connecting",
    code: null,
    workspace: null,
    member: null,
    since: new Date().toISOString(),
  };
  let me: HubMe | null = null;
  let cursor = 0;
  let stopped = true;
  let socket: WebSocket | undefined;
  let retryDelay = timing.firstRetryMs;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let silenceTimer: ReturnType<typeof setInterval> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let heardAt = 0;
  /** Events are applied one at a time, in order, whichever door they came through. */
  let applying: Promise<void> = Promise.resolve();

  /** A function, not the field read inline: TypeScript would narrow it across an `await`. */
  const isRefused = () => status.state === "refused";

  const setStatus = (
    state: HubLinkState,
    code: string | null,
    reason?: string,
  ) => {
    const changed = status.state !== state || status.code !== code;
    status = {
      ...status,
      state,
      code,
      ...(me
        ? {
            workspace: me.workspace ? { name: me.workspace.name } : null,
            member: { role: me.member.role, name: me.member.name },
          }
        : {}),
      since: changed ? new Date().toISOString() : status.since,
    };
    if (!changed) return;
    // The line's own events, once each. No URL, no pass: the origin is on the boot line already.
    if (state === "connected") {
      log.info("hub_connected", { seq: cursor });
    } else if (state === "refused") {
      log.warn("hub_pass_refused", { code, ...(reason ? { reason } : {}) });
    } else if (state === "disconnected") {
      log.info("hub_disconnected", { code, ...(reason ? { reason } : {}) });
    }
    input.deliver({ kind: "hub.status", ...status });
  };

  const apply = (events: HubEvent[], seq?: number) => {
    applying = applying.then(async () => {
      let moved = false;
      for (const event of events) {
        if (event.seq <= cursor) continue;
        cursor = event.seq;
        moved = true;
        // A type this build does not know is passed over, and the cursor still moves past it.
        if (!KNOWN_TYPES.has(event.type)) continue;
        const { type, ...rest } = event;
        input.deliver({ kind: `hub.${type}`, ...rest });
      }
      if (seq !== undefined && seq > cursor) {
        cursor = seq;
        moved = true;
      }
      if (!moved) return;
      await writeHubCursor(input.database, input.hub, cursor).catch(
        (error: unknown) =>
          log.warn("hub_cursor_not_written", {
            reason: error instanceof Error ? error.name : "unknown",
          }),
      );
    });
    return applying;
  };

  const clearTimers = () => {
    if (retryTimer) clearTimeout(retryTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (silenceTimer) clearInterval(silenceTimer);
    if (stableTimer) clearTimeout(stableTimer);
    retryTimer = undefined;
    pollTimer = undefined;
    silenceTimer = undefined;
    stableTimer = undefined;
  };

  const dropSocket = () => {
    const current = socket;
    socket = undefined;
    if (!current) return;
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    try {
      current.close();
    } catch {
      // Already closing.
    }
  };

  const refuse = (reason: string) => {
    clearTimers();
    dropSocket();
    setStatus("refused", HUB_FACTS.passRefused, reason);
  };

  const poll = async () => {
    if (stopped || socket || isRefused()) return;
    const answer = await input.http.request<HubSync>({
      path: `/sync?since=${cursor}`,
      retry: false,
    });
    if (stopped || isRefused()) return;
    if (answer.ok) {
      await apply(answer.body.events, answer.body.seq);
      if (answer.body.more) void poll();
    } else if (answer.code === HUB_FACTS.passRefused) {
      refuse("sync");
    }
  };

  /** Down, and to be tried again: after the backoff, with `/sync` asked meanwhile. */
  const lost = (code: string, reason: string) => {
    dropSocket();
    if (stopped || isRefused()) return;
    setStatus("disconnected", code, reason);
    if (silenceTimer) clearInterval(silenceTimer);
    silenceTimer = undefined;
    if (!pollTimer) {
      pollTimer = setInterval(() => void poll(), timing.pollMs);
    }
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, timing.maxRetryMs);
  };

  const listen = () => {
    const { url, headers } = input.http.socket(cursor);
    let next: WebSocket;
    try {
      next = openSocket(url, headers);
    } catch {
      lost(HUB_FACTS.unreachable, "socket_not_opened");
      return;
    }
    socket = next;
    heardAt = Date.now();
    next.onopen = () => {
      if (socket !== next) return;
      heardAt = Date.now();
      /*
       * The backoff starts again from a second only once the socket has STAYED up for the longest
       * wait. Reset on open, a front door that accepts the upgrade and drops it at once (measured
       * live with a proxy whose hub was down) was knocked on every second for as long as it did.
       */
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = setTimeout(() => {
        if (socket === next) retryDelay = timing.firstRetryMs;
      }, timing.maxRetryMs);
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
      silenceTimer = setInterval(
        () => {
          if (socket === next && Date.now() - heardAt > timing.silenceMs) {
            lost(HUB_FACTS.unreachable, "silent");
          }
        },
        Math.max(250, Math.floor(timing.silenceMs / 3)),
      );
      setStatus("connected", null);
      input.onReachable?.();
    };
    next.onmessage = (message) => {
      if (socket !== next) return;
      heardAt = Date.now();
      const beat = heartbeatFrameKind(message.data);
      if (beat === "ping") {
        try {
          next.send(PONG_FRAME);
        } catch {
          // Closing; its close says so.
        }
      }
      if (beat !== null) return;
      let frame: unknown;
      try {
        frame = JSON.parse(String(message.data));
      } catch {
        return;
      }
      const hold = docHoldFrame(frame);
      if (hold) {
        input.deliver(hold);
        return;
      }
      const event = frame as { kind?: unknown } & Partial<HubEvent>;
      if (event.kind !== "event" || typeof event.seq !== "number") return;
      void apply([
        {
          seq: event.seq,
          type: String(event.type),
          refId: event.refId ?? null,
          actor: event.actor ?? null,
          at: String(event.at),
        },
      ]);
    };
    next.onclose = (event) => {
      if (socket !== next) return;
      socket = undefined;
      // 4401: this member left, or the pass is no longer theirs. The hub's own word for it.
      if (event.code === 4401) {
        refuse("socket_closed");
        return;
      }
      lost(HUB_FACTS.unreachable, `closed_${event.code}`);
    };
    // An `error` is followed by a `close`, which is the one that decides.
    next.onerror = () => {};
  };

  const connect = async () => {
    if (stopped || isRefused()) return;
    const answer = await input.http.request<HubMe>({ path: "/me" });
    if (stopped) return;
    if (!answer.ok) {
      if (answer.code === HUB_FACTS.passRefused) {
        refuse("me");
        return;
      }
      lost(answer.code, "me");
      return;
    }
    me = answer.body;
    const kept = await readHubCursor(input.database, input.hub).catch(
      () => null,
    );
    if (kept === null) {
      // No place in this hub's sequence: start at its newest event, as the hub's own socket does.
      cursor = Math.max(cursor, me.seq);
      await writeHubCursor(input.database, input.hub, cursor).catch(
        () => undefined,
      );
    } else {
      cursor = Math.max(cursor, kept);
    }
    if (stopped) return;
    listen();
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void connect();
    },
    stop() {
      stopped = true;
      clearTimers();
      dropSocket();
    },
    status: () => status,
    me: () => me,
    passRefused(reason) {
      if (stopped || isRefused()) return;
      refuse(reason);
    },
  };
}
