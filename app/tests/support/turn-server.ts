import type { Message } from "@ag-ui/core";
import type { HistoryPage } from "../../src/lib/turns/client";
import type { TurnFrame, TurnState } from "../../src/lib/turns/frames";
import {
  type ApiRequest,
  agentFixture,
  CURRENT_USER,
  json,
} from "./app-router";
import { BOT_ID, channelServer, THREAD_ID } from "./channel-server";

/**
 * THE SERVER FOR ONE CONVERSATION WHOSE TURNS IT OWNS, AT THE NETWORK EDGE.
 *
 * `channel-server.ts` answers as CopilotKit's runtime does, which is the window driving the turn
 * (`ChannelChat`, `SERVER_TURNS=off`). Until 2026-10-02 nothing mounted the surface people actually
 * use: `/api/me` in the test shell never says `serverTurns`, so every mounted conversation test ran
 * the old one. This says it, and answers the doors of a server-owned turn the way
 * `server/src/turns/routes.ts`, `engine.ts` and `hub.ts` do — read from them, not from the client:
 *
 *   GET  /api/turns/:thread/history   a page of what the store holds, newest first
 *   GET  /api/turns/:thread/stream    a snapshot to a window with no cursor, then numbered frames
 *   POST /api/turns/:thread           202 and a `queued` turn, or 409 while one is going
 *   POST /api/turns/:thread/stop      the turn ends `stopped`
 *
 * The stream is an `EventSource`, which neither bun nor happy-dom has. `installTurnStreams` puts a
 * stand-in on the globals; a window that opens one is answered in the next microtask, as a server
 * that is up answers — unless the test holds the streams or has taken them down.
 */

type StreamHandler = ((event: { data: string }) => void) | null;

const streams = new Set<FakeStream>();
/**
 * Told of every stream a window opens: the newest conversation's server, and only that one. A test
 * that failed before closing its server used to leave it answering the next test's windows with a
 * turn that was not theirs — one red test, and every one after it red for no reason of its own.
 */
let server: ((stream: FakeStream) => void) | null = null;

class FakeStream {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readyState: number = FakeStream.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: StreamHandler = null;
  onerror: (() => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    streams.add(this);
    // After the caller has set its handlers, which `watchTurn` does right after constructing.
    queueMicrotask(() => server?.(this));
  }

  /** The keepalive's `ping`: no test here waits the forty seconds its silence takes. */
  addEventListener(): void {}

  close(): void {
    this.readyState = FakeStream.CLOSED;
    streams.delete(this);
  }
}

export function installTurnStreams(): void {
  const stream = FakeStream as unknown as typeof EventSource;
  (globalThis as { EventSource?: typeof EventSource }).EventSource = stream;
  (window as { EventSource?: typeof EventSource }).EventSource = stream;
}

export function removeTurnStreams(): void {
  streams.clear();
  server = null;
  delete (globalThis as { EventSource?: typeof EventSource }).EventSource;
}

/** Run something that reaches React — a frame pushed to a window — inside `act`. */
export async function acted(run: () => void | Promise<void>): Promise<void> {
  const { act } = await import("react");
  await act(async () => {
    await run();
  });
}

export type TurnSend = { botId: string; messages: Message[] };

type Unnumbered =
  | { kind: "turn"; turn: TurnState }
  | { kind: "event"; turn: string; event: { type: string } & object }
  | { kind: "messages"; turn: string; messages: Message[] }
  | { kind: "waiting"; turn: string; toolCallIds: string[] };

export function turnServer(options: {
  channelId: string;
  /** What the store holds: the conversation so far, oldest first. */
  history?: Message[];
  /** The store holds more above the newest page. */
  hasOlder?: boolean;
  /** How the turn stands when the window opens, and what it has said so far. */
  turn?: TurnState | null;
  turnMessages?: Message[];
  /** False is a conversation whose Bot was deleted. */
  active?: boolean;
  /** Windows that open a stream are left unanswered until `answerStreams`. */
  holdStreams?: boolean;
}) {
  const channel = channelServer({ channelId: options.channelId });
  const stored: Message[] = [...(options.history ?? [])];
  const sends: TurnSend[] = [];
  const hub = {
    epoch: "epoch-1",
    seq: 0,
    turn: options.turn ?? null,
    messages: [...(options.turnMessages ?? [])],
  };
  let historyDown = false;
  let historyReads = 0;
  let doorDown = false;
  /** While set, the door is there and says no: the code it refuses a hand-over with. */
  let doorRefusal: string | null = null;
  /** While set, a hand-over is kept waiting for its answer: the send is on its way. */
  let doorHold: Promise<void> | null = null;
  let releaseDoor = () => {};
  let stops = 0;
  let held = options.holdStreams === true;
  let turns = 0;

  const going = () =>
    hub.turn?.status === "queued" || hub.turn?.status === "running";

  const isMine = (stream: FakeStream) =>
    stream.url.includes(`/api/turns/${THREAD_ID}/stream`);

  /** What `hub.subscribe` does: nothing to a cursor that missed nothing, a snapshot to any other. */
  const answer = (stream: FakeStream) => {
    if (!isMine(stream) || stream.readyState !== FakeStream.CONNECTING) return;
    stream.readyState = FakeStream.OPEN;
    stream.onopen?.();
    const cursor = new URL(stream.url, "http://localhost").searchParams.get(
      "cursor",
    );
    if (cursor === `${hub.epoch}:${hub.seq}`) return;
    stream.onmessage?.({
      data: JSON.stringify({
        kind: "snapshot",
        epoch: hub.epoch,
        seq: hub.seq,
        turn: hub.turn,
        messages: hub.messages,
        waiting: [],
      } satisfies TurnFrame),
    });
  };
  const onStream = (stream: FakeStream) => {
    if (!held) answer(stream);
  };
  server = onStream;

  /** Numbered and handed to every window watching, as `hub.publish` does. */
  const publish = (frame: Unnumbered) => {
    hub.seq += 1;
    if (frame.kind === "turn") {
      hub.turn = frame.turn;
      if (!going()) hub.messages = [];
    }
    if (frame.kind === "messages") {
      const ids = new Set(frame.messages.map((message) => message.id));
      hub.messages = [
        ...hub.messages.filter((message) => !ids.has(message.id)),
        ...frame.messages,
      ];
    }
    const data = JSON.stringify({ ...frame, seq: hub.seq });
    for (const stream of streams) {
      if (isMine(stream) && stream.readyState === FakeStream.OPEN) {
        stream.onmessage?.({ data });
      }
    }
  };

  const page = (): HistoryPage => ({
    messages: stored,
    times: {},
    seqs: Object.fromEntries(
      stored.map((message, index) => [message.id, index + 1]),
    ),
    oldestSeq: stored.length ? 1 : null,
    newestSeq: stored.length || null,
    hasOlder: options.hasOlder === true,
  });

  /** What `engine.send` answers a hand-over: 409 while a turn is going, else 202 and a queued turn. */
  const takeTurn = (body: TurnSend): Response => {
    if (going()) {
      return json(
        { error: "laf:turn_in_progress", code: "laf:turn_in_progress" },
        409,
      );
    }
    // The person's side is filed, the turn is announced `queued`, and its question goes to every
    // window before any of the answer.
    const asked = body.messages.filter((message) => message.role === "user");
    stored.push(...asked);
    turns += 1;
    const turn: TurnState = {
      id: `turn-${turns}`,
      status: "queued",
      asked: body.messages.map((message) => message.id),
    };
    publish({ kind: "turn", turn });
    publish({ kind: "messages", turn: turn.id, messages: asked });
    return json({ turnId: turn.id, epoch: hub.epoch }, 202);
  };

  const api = (
    request: ApiRequest,
  ): Response | Promise<Response> | undefined => {
    const { pathname, method } = request;
    const door = `/api/turns/${THREAD_ID}`;
    if (pathname === "/api/me") {
      return json({
        user: { ...CURRENT_USER, role: "user", onboarded: true },
        deployment: { effort: true, autoReview: true, serverTurns: true },
      });
    }
    if (pathname === `/api/agents/${BOT_ID}`) {
      return json({ agent: agentFixture({ id: BOT_ID, name: "닻" }) });
    }
    if (pathname === `/api/channels/${options.channelId}`) {
      return json({
        channel: {
          id: options.channelId,
          name: "닻",
          agentIds: [BOT_ID],
          threadId: THREAD_ID,
          active: options.active !== false,
        },
      });
    }
    if (pathname === `${door}/history`) {
      historyReads += 1;
      // The front door's answer while the server behind it is restarting.
      if (historyDown) return new Response("", { status: 503 });
      return json(page());
    }
    if (pathname === `${door}/stop` && method === "POST") {
      stops += 1;
      const turn = hub.turn;
      if (!turn || !going()) return json({ stopped: false });
      publish({ kind: "turn", turn: { ...turn, status: "stopped" } });
      return json({ stopped: true });
    }
    if (pathname === door && method === "POST") {
      const body = request.body as TurnSend;
      sends.push({ botId: body.botId, messages: body.messages });
      // Decided as it arrives; a hand-over that is held is answered late, not differently.
      const isLost = doorDown;
      const refusal = doorRefusal;
      const answerIt = () =>
        isLost
          ? new Response("", { status: 503 })
          : refusal
            ? json({ error: refusal, code: refusal }, 400)
            : takeTurn(body);
      return doorHold ? doorHold.then(answerIt) : answerIt();
    }
    return channel.api(request);
  };

  return {
    api,
    /** Every hand-over the door was sent, refused ones included, in order. */
    sends,
    stops: () => stops,
    historyReads: () => historyReads,
    turn: () => hub.turn,
    /** `/history` answers 503 until `historyUp`. */
    historyDown: () => {
      historyDown = true;
    },
    historyUp: () => {
      historyDown = false;
    },
    /** The hand-over door answers 503 until `doorUp`: the words never arrive. */
    doorDown: () => {
      doorDown = true;
    },
    doorUp: () => {
      doorDown = false;
    },
    /** The door answers, and refuses every hand-over with this code, until `doorAccepts`. */
    doorRefuses: (code: string) => {
      doorRefusal = code;
    },
    doorAccepts: () => {
      doorRefusal = null;
    },
    /** Hand-overs from now on are left on their way until `answerDoor`. */
    holdDoor: () => {
      doorHold = new Promise((resolve) => {
        releaseDoor = resolve;
      });
    },
    answerDoor: () => {
      doorHold = null;
      releaseDoor();
    },
    /** Answer the streams that were held: the stream says how the turn stands. */
    answerStreams: () => {
      held = false;
      for (const stream of streams) answer(stream);
    },
    /** A turn frame to every window: `running`, `queued` again, or how it ended. */
    announce: (status: TurnState["status"], code?: string) => {
      const turn = hub.turn;
      if (!turn) throw new Error("no turn to announce");
      publish({
        kind: "turn",
        turn: { ...turn, status, ...(code ? { code } : {}) },
      });
    },
    /**
     * A turn frame no window hears: its socket was half-open — a laptop asleep — while another
     * window started a turn. The server's state moves on; only a fresh stream is told, in its
     * snapshot.
     */
    unheard: (turn: TurnState) => {
      hub.seq += 1;
      hub.turn = turn;
    },
    /** The server's own copies of what the turn has written; filed in the store as it does. */
    say: (messages: Message[]) => {
      const turn = hub.turn;
      if (!turn) throw new Error("no turn to speak in");
      const ids = new Set(messages.map((message) => message.id));
      stored.splice(
        0,
        stored.length,
        ...stored.filter((message) => !ids.has(message.id)),
        ...messages,
      );
      publish({ kind: "messages", turn: turn.id, messages });
    },
    /**
     * Written to the store by something that is not a turn — a routine delivering its answer. No
     * frame goes to anybody: the roster's news of it is the only news, as on the server.
     */
    deliver: (messages: Message[]) => {
      stored.push(...messages);
    },
    close: () => {
      if (server === onStream) server = null;
    },
  };
}

/** The user messages of a hand-over, which is what the thread will hold of it. */
export function askedIn(send: TurnSend | undefined): Message[] {
  return (send?.messages ?? []).filter((message) => message.role === "user");
}
