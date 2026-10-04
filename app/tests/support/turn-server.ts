import type { Message } from "@ag-ui/core";
import { UNANSWERED_RESULT } from "@shared/task-ending";
import type { StoredFailure } from "../../src/lib/channels/retry";
import type { HistoryPage } from "../../src/lib/turns/client";
import type { TurnFrame, TurnState } from "../../src/lib/turns/frames";
import {
  type ApiRequest,
  agentFixture,
  CURRENT_USER,
  json,
} from "./app-router";

/**
 * THE SERVER FOR ONE CONVERSATION WITH ONE BOT, AT THE NETWORK EDGE.
 *
 * For `mountApp`'s `api`: everything the channel route asks for on the way to a transcript — the
 * channel, the roster, stamps, failures, the read mark — and the doors of a turn the server owns,
 * answered the way `server/src/turns/routes.ts`, `engine.ts` and `hub.ts` do — read from them, not
 * from the client:
 *
 *   GET  /api/turns/:thread/history   a page of what the store holds, newest first
 *   GET  /api/turns/:thread/stream    a snapshot to a window with no cursor, then numbered frames
 *   POST /api/turns/:thread           202 and a `queued` turn, or 409 while one is going
 *   POST /api/turns/:thread/stop      the turn ends `stopped`
 *
 * The stream is an `EventSource`, which neither bun nor happy-dom has. `installTurnStreams` puts a
 * stand-in on the globals; a window that opens one is answered in the next microtask, as a server
 * that is up answers — unless the test holds the streams or has taken them down.
 *
 * THE ONLY DOUBLE THERE IS. Until 2026-10-05 a second one (`channel-server.ts`) answered as
 * CopilotKit's runtime does, for the window that drove its own turns, and every conversation test
 * written before 2026-10-02 mounted that one: the surface people use was the one nothing mounted.
 * The window-driven path was removed and its double with it; what that file answered for the
 * channel itself is below.
 */

export const BOT_ID = "agent_edge-bot";
export const THREAD_ID = "thread-edge";

/** The control state a Bot at work holds: its own wheel, nobody asked for. */
const BOT_AT_THE_WHEEL = {
  holder: "bot",
  since: "2026-09-10T00:00:00Z",
  requested: false,
};

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
  /**
   * How many messages a page of the history holds. The server's is eighty; a test of what lies
   * above the newest page says a few. Absent, a page is everything the store holds.
   */
  historyPage?: number;
  /** How the turn stands when the window opens, and what it has said so far. */
  turn?: TurnState | null;
  turnMessages?: Message[];
  /** False is a conversation whose Bot was deleted. */
  active?: boolean;
  /** Windows that open a stream are left unanswered until `answerStreams`. */
  holdStreams?: boolean;
  /** The turns that got no answer, as the server's run ledger holds them. Read again as a turn ends. */
  failures?: StoredFailure[];
  /**
   * Whether this deployment has a computer. With one, the control route answers a state every time,
   * which is what the polls were measured against; without one it is a 404 learned once.
   */
  computer?: boolean;
}) {
  /** Every time the page marked the room read, in order: on opening, and when a turn ends. */
  const reads: string[] = [];
  const stored: Message[] = [...(options.history ?? [])];
  const sends: TurnSend[] = [];
  const hub = {
    epoch: "epoch-1",
    seq: 0,
    turn: options.turn ?? null,
    messages: [...(options.turnMessages ?? [])],
    /** The cards the turn is waiting on a person to answer (`people.ts`). */
    waiting: [] as string[],
  };
  /** Every answer a window sent to a waiting card, in order. */
  const answers: { toolCallId: string; value: unknown }[] = [];
  /** Every time the card's door was asked, whatever it said. */
  let asks = 0;
  let historyDown = false;
  /** While set, a read of the history is kept waiting for its answer: it is slow, not failing. */
  let historyHold: Promise<void> | null = null;
  let releaseHistory = () => {};
  let historyReads = 0;
  /** Where each read of the history asked from, in order: null for the newest page. */
  const historyCursors: (number | null)[] = [];
  let doorDown = false;
  /** While set, the door is there and says no: the code it refuses a hand-over with. */
  let doorRefusal: string | null = null;
  /** While set, a hand-over is kept waiting for its answer: the send is on its way. */
  let doorHold: Promise<void> | null = null;
  let releaseDoor = () => {};
  /**
   * How the card's door stands: `down` answers 503 and takes nothing; `lost` takes the answer and
   * then answers 503 — the reply that never reached the window.
   */
  let answersDoor: "up" | "down" | "lost" = "up";
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
        waiting: hub.waiting,
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
      // A turn that is over waits on nothing: the real hub lets go of both (`hub.ts`, `turn`).
      if (!going()) {
        hub.messages = [];
        hub.waiting = [];
      }
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

  /** A call's result filed by the server itself, and every window told (`hub.event`). */
  const fileResult = (toolCallId: string, content: string) => {
    const turn = hub.turn;
    if (!turn) return;
    const result = {
      id: `result-${toolCallId}`,
      role: "tool",
      toolCallId,
      content,
    } as Message;
    stored.push(result);
    hub.messages = [...hub.messages, result];
    publish({
      kind: "event",
      turn: turn.id,
      event: {
        type: "TOOL_CALL_RESULT",
        messageId: result.id,
        toolCallId,
        content,
        role: "tool",
      } as { type: string } & object,
    });
  };

  /**
   * How a turn ends (`engine.ts`). A STOP OR A FAILURE LEAVES NO CALL UNANSWERED: each call of the
   * turn that has no result is filed one, and every window is told, before the turn is said to be
   * over. This used to say the turn was over and nothing else, so a test of "stopped while a card
   * waited" watched a window decide from a conversation no real server leaves behind.
   */
  const end = (status: TurnState["status"], code?: string) => {
    const turn = hub.turn;
    if (!turn) throw new Error("no turn to announce");
    if (status === "stopped" || status === "error") {
      const answered = new Set(
        hub.messages
          .filter((message) => message.role === "tool")
          .map((message) => (message as { toolCallId: string }).toolCallId),
      );
      for (const message of hub.messages) {
        if (message.role !== "assistant") continue;
        for (const call of message.toolCalls ?? []) {
          if (answered.has(call.id)) continue;
          fileResult(
            call.id,
            status === "stopped"
              ? JSON.stringify({
                  ok: false,
                  code: "laf:stopped",
                  stopped: true,
                })
              : UNANSWERED_RESULT,
          );
        }
      }
    }
    publish({
      kind: "turn",
      turn: { ...turn, status, ...(code ? { code } : {}) },
    });
  };

  /**
   * A page as the server cuts one (`historyPage` in `server/src/turns/history.ts`): the newest
   * `historyPage` messages below the cursor, a message's place in the store being its `seq` — and
   * never one that starts on a result, which reaches back to the message that asked for it.
   *
   * It answered every read with the whole store, whatever cursor it was asked from: nothing here
   * could put a question above the newest page, which is where a conversation that went on
   * without this window leaves one.
   */
  const page = (before: number | null): HistoryPage => {
    const upTo =
      before === null
        ? stored.length
        : Math.max(0, Math.min(stored.length, before - 1));
    let from = Math.max(0, upTo - (options.historyPage ?? upTo));
    while (from > 0 && stored[from]?.role === "tool") from -= 1;
    const messages = stored.slice(from, upTo);
    return {
      messages,
      times: {},
      seqs: Object.fromEntries(
        messages.map((message, index) => [message.id, from + index + 1]),
      ),
      oldestSeq: messages.length ? from + 1 : null,
      newestSeq: messages.length ? upTo : null,
      hasOlder: from > 0 || options.hasOlder === true,
    };
  };

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
    // The store keys a message by its id (`appendMessages`): one it already holds is that row
    // arriving again — a question asked again in place — and not a second row.
    const held = new Set(stored.map((message) => message.id));
    stored.push(...asked.filter((message) => !held.has(message.id)));
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
    if (pathname === "/api/agents") {
      return json({ agents: [agentFixture({ id: BOT_ID, name: "닻" })] });
    }
    const base = `/api/channels/${options.channelId}`;
    if (pathname === base) {
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
    if (pathname === `${base}/message-times`) {
      return json({ times: {}, speakers: {} });
    }
    if (pathname === `${base}/failures`) {
      return json({ failures: options.failures ?? [] });
    }
    if (pathname === `${base}/read`) {
      reads.push(new Date().toISOString());
      return json({ previousReadAt: null, readAt: new Date().toISOString() });
    }
    if (pathname === `${base}/activity`) {
      return new Response(null, { status: 204 });
    }
    if (pathname === `/api/computers/${BOT_ID}/control`) {
      return options.computer
        ? json(BOT_AT_THE_WHEEL)
        : json({ error: "Not found." }, 404);
    }
    if (pathname === "/api/sandboxed/published") {
      return json({ components: [] });
    }
    // What the provider asks before it settles: the runtime's roster, as a running server answers it.
    if (pathname === "/api/copilotkit/info") {
      return json({
        version: "1.67.1",
        agents: {
          [BOT_ID]: { name: BOT_ID, description: "", className: "Fe" },
        },
        mode: "sse",
      });
    }
    if (pathname === `${door}/history`) {
      historyReads += 1;
      // Any whole number is a cursor, as the route reads it; anything else is the newest page.
      const asked = request.url.searchParams.get("before");
      const cursor =
        asked === null || asked === "" ? Number.NaN : Number(asked);
      const before = Number.isInteger(cursor) ? cursor : null;
      historyCursors.push(before);
      // The front door's answer while the server behind it is restarting.
      if (historyDown) return new Response("", { status: 503 });
      // Answered late, with the record as it stands when it is.
      return historyHold
        ? historyHold.then(() => json(page(before)))
        : json(page(before));
    }
    // A person's answer to a card: taken while the turn waits on it, 409 once it does not.
    if (pathname.startsWith(`${door}/answers/`) && method === "POST") {
      const toolCallId = decodeURIComponent(
        pathname.slice(`${door}/answers/`.length),
      );
      asks += 1;
      if (answersDoor === "down") return new Response("", { status: 503 });
      if (!hub.waiting.includes(toolCallId)) {
        return json(
          { error: "laf:no_longer_waiting", code: "laf:no_longer_waiting" },
          409,
        );
      }
      answers.push({
        toolCallId,
        value: (request.body as { value?: unknown } | null)?.value ?? null,
      });
      /*
       * EVERY WINDOW IS TOLD THE CARD STOPPED WAITING, BEFORE THE DOOR REPLIES — the order the
       * real server keeps (`people.ts`: the wait ends, `onChange` publishes, then the route
       * answers). This used to change what waited and tell nobody, so a test of "the door took
       * it and its reply was lost" pressed its way through a 409 a real window is never sent.
       */
      hub.waiting = hub.waiting.filter((id) => id !== toolCallId);
      if (hub.turn) {
        publish({
          kind: "waiting",
          turn: hub.turn.id,
          toolCallIds: [...hub.waiting],
        });
      }
      if (answersDoor === "lost") return new Response("", { status: 503 });
      return json({ answered: true });
    }
    if (pathname === `${door}/stop` && method === "POST") {
      stops += 1;
      const turn = hub.turn;
      if (!turn || !going()) return json({ stopped: false });
      end("stopped");
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
    return undefined;
  };

  return {
    api,
    /** Every hand-over the door was sent, refused ones included, in order. */
    sends,
    /** Every time the page marked the room read, in order: on opening, and when a turn ends. */
    reads,
    stops: () => stops,
    historyReads: () => historyReads,
    /** Where each read of the history asked from, in order: null for the newest page. */
    historyCursors: () => historyCursors,
    turn: () => hub.turn,
    /** `/history` answers 503 until `historyUp`. */
    historyDown: () => {
      historyDown = true;
    },
    historyUp: () => {
      historyDown = false;
    },
    /** Reads of the history from now on are left on their way until `answerHistory`. */
    holdHistory: () => {
      historyHold = new Promise((resolve) => {
        releaseHistory = resolve;
      });
    },
    answerHistory: () => {
      historyHold = null;
      releaseHistory();
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
    /** A turn frame to every window: `running`, `queued` again, or how it ended (`end`). */
    announce: end,
    /**
     * The turn is over and this window never heard how: the frame that says so, and nothing of
     * what the server filed before it. A window that slept through the end of the turn and came
     * back past the frames the server keeps is told this much and no more.
     */
    announceUnheard: (status: TurnState["status"]) => {
      const turn = hub.turn;
      if (!turn) throw new Error("no turn to announce");
      publish({ kind: "turn", turn: { ...turn, status } });
    },
    /** Written to the store and told to no window: what a read of the record finds later. */
    file: (messages: Message[]) => {
      stored.push(...messages);
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
    /**
     * The turn ends and no window hears of it — a laptop asleep. The hub moves on; a window that
     * comes back with the cursor it had is past what it can be replayed, and is sent a snapshot.
     */
    endUnheard: (status: TurnState["status"]) => {
      const turn = hub.turn;
      if (!turn) throw new Error("no turn to end");
      hub.seq += 1;
      hub.turn = { ...turn, status };
      hub.messages = [];
      hub.waiting = [];
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
    /**
     * A CUSTOM event on the turn's own stream, as the hub hands one on (`hub.event`): agent-bot
     * says a cut-off or an empty answer this way, beside the token counts it reports the same way.
     */
    custom: (name: string, value: unknown = {}) => {
      const turn = hub.turn;
      if (!turn) throw new Error("no turn to say it in");
      publish({
        kind: "event",
        turn: turn.id,
        event: { type: "CUSTOM", name, value } as { type: string } & object,
      });
    },
    /** The turn stops on cards and waits for a person: every window is told which. */
    waitOn: (toolCallIds: string[]) => {
      const turn = hub.turn;
      if (!turn) throw new Error("no turn to wait in");
      hub.waiting = toolCallIds;
      publish({ kind: "waiting", turn: turn.id, toolCallIds });
    },
    /** The cards stop being waited on without an answer — the wait ran out — and every window is told. */
    stopWaiting: () => {
      hub.waiting = [];
      if (hub.turn) {
        publish({ kind: "waiting", turn: hub.turn.id, toolCallIds: [] });
      }
    },
    /**
     * The same, in the instant before this window hears of it: an answer sent now crosses the
     * frame on its way, and is refused by a door the window still took to be open.
     */
    stopWaitingUnheard: () => {
      hub.waiting = [];
    },
    /**
     * A card's wait ran out, as the server ends it (`people.ts`, `chat-tools.ts`): every window is
     * told it waits no more, and the call is answered with the code that says nobody did.
     */
    waitRanOut: (toolCallId: string) => {
      hub.waiting = hub.waiting.filter((id) => id !== toolCallId);
      if (hub.turn) {
        publish({
          kind: "waiting",
          turn: hub.turn.id,
          toolCallIds: [...hub.waiting],
        });
      }
      fileResult(
        toolCallId,
        JSON.stringify({ ok: false, code: "laf:nobody_answered" }),
      );
    },
    /** Every answer a window sent to a waiting card. */
    answers: () => answers,
    /** How many times the card's door was asked, whatever it said. */
    asks: () => asks,
    /** The card's door answers 503 and takes nothing, until `answersUp`. */
    answersDown: () => {
      answersDoor = "down";
    },
    /** The card's door takes the answer and its reply never arrives, until `answersUp`. */
    loseAnswerReply: () => {
      answersDoor = "lost";
    },
    answersUp: () => {
      answersDoor = "up";
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
