import type { Message } from "@ag-ui/core";
import {
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toAgentOptions } from "@/components/channels/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import {
  seedMessage,
  takeFirstMessage,
  transcriptMessages,
} from "@/components/channels/transcript-messages";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { agentPluginsQueryOptions } from "@/lib/plugins/queries";
import {
  recordChannelActivityMutationOptions,
  setChannelReadMutationOptions,
} from "@/lib/channels/mutations";
import {
  type AgentChannel,
  messageTimesQueryOptions,
} from "@/lib/channels/queries";
import { loadThreadHistory } from "@/lib/channels/thread-history";
import {
  CHANNEL_ACTIVITY,
  type ChannelActivity,
  channelActivity,
} from "@/lib/channels/use-channel-events";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { repairUnansweredToolCalls } from "@/lib/copilot/repair-history";
import { stoppedReason } from "@/lib/copilot/stopped-turn";
import { t } from "@/lib/i18n";
import { useSkillCommands } from "@/lib/plugins/skill-commands";

/**
 * Backstop for the first message of a new channel; a stalled join must not lose the message.
 */
const SEND_WITHOUT_JOIN_AFTER_MS = 1500;

/**
 * How long a room waits to be pointed at another Bot before giving up on the message.
 *
 * Longer than the join wait because the consequence is different: a join that has not finished
 * costs ordering, and a swap that has not finished costs the message going to the wrong colleague.
 * Giving up means saying so, never sending.
 */
const SWAP_TIMEOUT_MS = 5000;

/**
 * How the room note is recognised again on the next turn, so the old copy can be taken out.
 *
 * A marker rather than matching the sentence, because the sentence carries names and a language:
 * renaming a Bot or switching to Korean would otherwise leave the previous copies unmatched and
 * accumulating, which is the exact failure this exists to end.
 */
const ROOM_NOTE_PREFIX = "[room] ";

/** Frozen and shared, so "no times yet" is one identity rather than a new object per render. */
const EMPTY_TIMES: Readonly<Record<string, string>> = Object.freeze({});

/** The same, for a room with one Bot: nothing to name, and one identity to hand down. */
const EMPTY_SPEAKERS: Readonly<Record<string, string>> = Object.freeze({});

/**
 * One channel's conversation with one coworker.
 *
 * The local agent id is channel-scoped so two channels with the same coworker keep separate
 * durable threads.
 */
export function ChannelChat({
  channel,
  defaultAgentId,
}: {
  channel: AgentChannel;
  /** Who answers when nobody is named. The room's first member; see the route for why that one. */
  defaultAgentId: string;
}) {
  /*
   * WHO IS ANSWERING RIGHT NOW, WHICH IN A ROOM WITH SEVERAL BOTS IS NOT A CONSTANT.
   *
   * An `@` mention names the Bot a message is for, and the composer has always collected it. What
   * routes on it is this: the id is handed to `useAgent`, whose run URL is `/agent/{id}/run`, so
   * pointing it elsewhere is the whole of "ask the other one". It changes only BETWEEN turns —
   * Stop, the run counters and the run subscriber all bind to the agent instance, and swapping
   * under a live run would leave Stop aborting a controller nobody is watching.
   */
  const [speakingAgentId, setSpeakingAgentId] = useState(defaultAgentId);
  const runtimeAgentId = speakingAgentId;
  /** Something arrived while the Bot had the turn; show it once the turn is over. */
  const missedWhileBusy = useRef(false);

  /** Read by `say`, which runs between renders and must not see the previous target. */
  const speakingRef = useRef(speakingAgentId);
  speakingRef.current = speakingAgentId;

  /*
   * Who is saying the thing currently arriving on screen.
   *
   * The server records the speaker of every message, but it records it as the run ends, and a
   * name that appears only after the reply is finished is a name that appears too late in the one
   * room where it matters. This is the same fact taken from the same event the server takes it
   * from — TEXT_MESSAGE_START — one round trip earlier. The server's copy wins once it arrives;
   * they are the same answer.
   */
  const [localSpeakers, setLocalSpeakers] = useState<Record<string, string>>(
    {},
  );
  // The core attaches the frontend tool registry; direct agent runs do not.
  const { copilotkit } = useCopilotKit();
  // Mentions are scoped to the channel's permitted agents.
  const queryClient = useQueryClient();
  const { data: agentProfiles } = useQuery(agentListQueryOptions());
  // Declared here, not beside its use: the run subscriber below holds a ref to its refetch.
  const storedTimes = useQuery(messageTimesQueryOptions(channel.id));

  /*
   * OPENING A ROOM MARKS IT READ, AND HANDS BACK WHERE THE READING STOPPED.
   *
   * One call, on mount, per channel. The mark it replaced is the only thing that can place the
   * "unread from here" line — the write destroys it, so a second request to read it would be a
   * race with this one by construction.
   *
   * `readWindow` is state and never re-derived: the line has to stay where it was when the room was
   * opened. Recomputing it as replies arrive would walk it down the transcript, always sitting
   * above the newest message, which is not a mark of what you had seen — it is just a decoration
   * that follows the scroll.
   */
  const setRead = useMutation(setChannelReadMutationOptions(queryClient));
  /** Where the reading stopped and where it resumed, both on the server's clock. */
  const [readWindow, setReadWindow] = useState<{
    from: string;
    until: string;
  } | null>(null);
  const markRead = useRef(setRead.mutateAsync);
  markRead.current = setRead.mutateAsync;
  /*
   * ONCE PER MOUNTED ROOM, AND THE GUARD IS LOAD-BEARING.
   *
   * This call is not idempotent by nature: it reports the mark it replaced. React runs mount
   * effects twice in development, so the second call answered with the timestamp the FIRST one had
   * just written — "now" — and the line had nothing newer than itself to sit above. It drew
   * nothing, in development only, for a reason invisible on the server: both requests returned 200
   * and both did exactly what they were asked.
   *
   * A ref rather than a cleanup flag, because the second invocation must not send the request at
   * all. It survives the simulated unmount and is fresh on a real one — `ChannelChat` is keyed on
   * the channel — so revisiting a room still marks it read.
   */
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (marked.current === channel.id) return;
    marked.current = channel.id;
    void markRead
      .current({ channelId: channel.id, read: true })
      .then((result) => {
        if (result.previousReadAt && result.readAt) {
          setReadWindow({ from: result.previousReadAt, until: result.readAt });
        }
      })
      .catch(() => {
        // A room that cannot be marked read is still a readable room.
      });
  }, [channel.id]);
  const { agent, isReady } = useAgent({
    agentId: `channel:${channel.id}`,
    runtimeAgentId,
    threadId: channel.threadId,
    updates: [
      UseAgentUpdate.OnMessagesChanged,
      UseAgentUpdate.OnRunStatusChanged,
    ],
  });

  /*
   * THE SWAP, AND THE TWO THINGS IT COSTS.
   *
   * `useAgent` unregisters the old proxy and registers a fresh one when the runtime id changes, so
   * the instance changes identity and its `messages` start EMPTY. Two consequences, handled here:
   *
   * The transcript would blank. The history is carried across in a ref and seeded onto the new
   * instance the moment it arrives, before the restore effect above can race it — that effect
   * refuses to overwrite a non-empty agent, so it becomes a no-op rather than a second writer.
   *
   * And the turn would be sent to whichever instance happened to be bound. `say` parks on the gate
   * below until the seeding has happened, the same shape as the join and ready gates above.
   */
  const carried = useRef<Message[] | null>(null);
  const openSwapGate = useRef<() => void>(() => {});
  const swapGate = useRef<Promise<void> | null>(null);
  /** The live instance, for a `say` that started before a swap and finishes after it. */
  const agentRef = useRef(agent);
  agentRef.current = agent;

  useEffect(() => {
    if (!isReady) return;
    if (carried.current) {
      if (agent.messages.length === 0) agent.setMessages(carried.current);
      carried.current = null;
    }
    // Fired once, then forgotten: this effect also runs on reconnects and on later swaps, and a
    // resolver left in place is one that gets called again for a wait that ended long ago.
    const open = openSwapGate.current;
    openSwapGate.current = () => {};
    open();
  }, [agent, isReady]);

  /**
   * First-message seed from the compose screen. It is taken once per mount and retained until the
   * agent has its own messages because joining a fresh thread can temporarily empty the agent.
   */
  const [seed] = useState<Message | null>(() => {
    const pending = takeFirstMessage(channel.id);
    return pending ? seedMessage(pending, crypto.randomUUID()) : null;
  });

  /** Cleared by the send-on-mount effect without restarting it. */
  const seedRef = useRef(seed);
  seedRef.current = seed;

  /** Promise gate for ordering the first message after the thread join when possible. */
  const openJoinGate = useRef<() => void>(() => {});
  const joinGate = useRef<Promise<void> | null>(null);
  if (joinGate.current === null) {
    joinGate.current = new Promise<void>((resolve) => {
      openJoinGate.current = resolve;
    });
  }
  const joinGatePromise = joinGate.current;

  /** Promise gate so messages typed before runtime readiness wait instead of being discarded. */
  const openReadyGate = useRef<() => void>(() => {});
  const readyGate = useRef<Promise<void> | null>(null);
  if (readyGate.current === null) {
    readyGate.current = new Promise<void>((resolve) => {
      openReadyGate.current = resolve;
    });
  }
  const readyGatePromise = readyGate.current;
  const isReadyRef = useRef(isReady);
  isReadyRef.current = isReady;
  useEffect(() => {
    if (isReady) openReadyGate.current();
  }, [isReady]);

  // Join the gateway socket, restore durable history, then release the first-message gate.
  useEffect(() => {
    if (!isReady) return;
    let current = true;

    void (async () => {
      try {
        await copilotkit.connectAgent({ agent });
      } catch {
        // Reported by the run-failure subscriber below; history is still worth restoring.
      }

      try {
        const stored = await loadThreadHistory(
          channel.threadId,
          runtimeAgentId,
        );
        // Never overwrite local messages that arrived while history was loading.
        if (
          current &&
          stored &&
          stored.length > 0 &&
          agent.messages.length === 0
        ) {
          agent.setMessages(stored);
        }
      } finally {
        // Release even on join/restore failure; the gate orders messages, not withholds them.
        openJoinGate.current();
      }
    })();

    return () => {
      current = false;
    };
  }, [copilotkit, agent, isReady, channel.threadId, runtimeAgentId]);

  /*
   * A message that arrived in this room from elsewhere — a routine delivering its answer at seven
   * in the morning while the room sits open on a desk — is in the thread but not on the screen.
   * The activity event says a Bot spoke; the thread is fetched and whatever it holds that the
   * screen does not is appended. Not while this person's own turn is in flight: that reply is
   * already streaming in, and the fetch would race it for the same message.
   */
  /**
   * Fetch the thread and append whatever it holds that this screen does not.
   *
   * Bound to the agent instance it started with: a swap tears this effect down while the fetch is
   * still out, and setting messages on an unregistered proxy writes them into nothing at all —
   * silently, which is how it would have stayed.
   */
  const catchUp = useCallback(async () => {
    const bound = agentRef.current;
    const stored = await loadThreadHistory(channel.threadId, runtimeAgentId);
    // Unreadable: the next open of the room shows it; nothing here is worth a banner.
    if (!stored || bound !== agentRef.current) return;
    const seen = new Set(bound.messages.map((message) => message.id));
    const missing = stored.filter((message) => !seen.has(message.id));
    if (missing.length === 0) return;
    bound.setMessages([...bound.messages, ...missing]);
    void refreshTimesRef.current();
    // Read, because it is on the screen in front of them.
    void markRead
      .current({ channelId: channel.id, read: true })
      .catch(() => {});
  }, [channel.id, channel.threadId, runtimeAgentId]);
  const catchUpRef = useRef(catchUp);
  catchUpRef.current = catchUp;

  useEffect(() => {
    const onActivity = (event: Event) => {
      const activity = (event as CustomEvent<ChannelActivity>).detail;
      if (activity.channelId !== channel.id) return;
      if (!activity.lastMessageAgentId) return;
      /*
       * PARKED, not dropped, while this person's own turn is in flight. That reply is already
       * streaming in and the fetch would race it for the same message — but the event is the only
       * news that anything else arrived, and discarding it left a routine's answer sitting in
       * Postgres, invisible on an open screen until somebody navigated away and back.
       */
      if (awaitingReply.current || agent.isRunning) {
        missedWhileBusy.current = true;
        return;
      }
      void catchUpRef.current();
    };

    channelActivity.addEventListener(CHANNEL_ACTIVITY, onActivity);
    return () =>
      channelActivity.removeEventListener(CHANNEL_ACTIVITY, onActivity);
  }, [agent, channel.id]);

  // Tool calls from this conversation act on this coworker's own computer.
  useActiveBot(runtimeAgentId);

  const skillCommands = useSkillCommands(runtimeAgentId);

  // Run failures arrive as events and are reported only for turns started in this mount.
  const [runError, setRunError] = useState<string | null>(null);
  const awaitingReply = useRef(false);

  /*
   * TWO DIFFERENT FACTS ABOUT ONE TURN, AND NEITHER OF THEM IS `agent.isRunning`.
   *
   * `turnsInFlight` counts what a person would call the Bot having the turn: from the moment `say`
   * is entered until the whole thing has come back, browser actions in the middle included. It is
   * what decides whether the next thing typed is sent or parked, and what tells the queue its wait
   * is over.
   *
   * `runsInFlight` counts what Stop can actually reach: the run `copilotkit.runAgent` opens, and
   * nothing before it. A turn can be in flight for a second and a half before that, while `say`
   * waits for the runtime agent, and a Stop drawn in that window aborts a controller nobody has
   * made yet.
   *
   * `agent.isRunning` looks like both and is neither. It reports the run on the wire, and a turn
   * that touches the browser is several runs in a row: the Bot asks for a click, the run ENDS so
   * the browser can answer it, and another run starts carrying the answer. The agent reports itself
   * idle in every one of those gaps — the truth about the wire and a lie about the turn. OpenBot
   * registers every computer tool as a frontend tool, so the gaps open on ordinary work rather than
   * on some edge case, and anything keyed on the turn ending fires in the middle of one instead.
   *
   * Counters rather than booleans because nothing stops a second turn being started from a
   * component button while the first is still going, and two overlapping turns must not have the
   * first one to finish declare the conversation idle.
   */
  const [turnsInFlight, setTurnsInFlight] = useState(0);
  const [runsInFlight, setRunsInFlight] = useState(0);

  /**
   * Tell the roster what was just said. Failures here must not block the conversation.
   */
  const recordActivity = useMutation(recordChannelActivityMutationOptions());
  const report = (text: string, agentId: string | null) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    recordActivity.mutate({
      agentId,
      at: new Date().toISOString(),
      channelId: channel.id,
      text: trimmed,
    });
  };
  const reportRef = useRef(report);
  reportRef.current = report;

  /**
   * Everything `say` does once it has something worth sending, split out so the counter it is
   * wrapped in covers every way out of here, a throw included.
   */
  const deliver = async (trimmed: string, skillInstructions: string[]) => {
    /*
     * The LIVE instance, not the one this closure was built with. A turn that swapped Bots on its
     * way in resolved its gate one render later, and the agent bound at that point is the one that
     * has the history and the run URL of the Bot being asked.
     */
    const agent = agentRef.current;
    // Wait briefly for the runtime agent instance before adding the message.
    if (!isReadyRef.current) {
      await Promise.race([
        readyGatePromise,
        new Promise((resolve) =>
          setTimeout(resolve, SEND_WITHOUT_JOIN_AFTER_MS),
        ),
      ]);
    }

    setRunError(null);
    awaitingReply.current = true;

    /*
     * THE SKILL GOES IN FRONT OF THE MESSAGE, AS A SYSTEM TURN. A `/` chip is one token in the
     * composer; what it stands for is the instruction added here, ahead of what the person typed, so
     * the Bot reads the job before the request.
     *
     * A system message rather than text prepended to theirs, because the two are not the same kind
     * of thing: the transcript should show what a person said, and pasting the skill into their
     * words puts sentences in their mouth and makes the reply quote instructions back at them.
     *
     * `transcriptMessages` draws user and assistant turns, so this never appears on screen — the
     * chip is what says a skill was used, and it stays visible in the message they sent.
     */
    /*
     * ONE COPY, AT THE END. The room note is a property of the TURN, not of the transcript, and
     * `addMessage` puts it in the thread — which the runner persists and `mergeKeepingStoredOnly`
     * then re-inserts even if a client drops it. Bounding it to "only when a colleague has spoken"
     * bounded nothing: in a two-Bot room that is true permanently from the second Bot's first
     * sentence, so fifty turns left fifty identical system messages, all stored and all shipped to
     * the provider on every request. Prior copies come off first.
     */
    const notes = skillInstructions.filter((instruction) =>
      instruction.startsWith(ROOM_NOTE_PREFIX),
    );
    if (notes.length > 0) {
      const kept = agent.messages.filter(
        (message) =>
          message.role !== "system" ||
          typeof message.content !== "string" ||
          !message.content.startsWith(ROOM_NOTE_PREFIX),
      );
      if (kept.length !== agent.messages.length) {
        agent.setMessages(kept as typeof agent.messages);
      }
    }

    for (const instruction of skillInstructions) {
      agent.addMessage({
        content: instruction,
        id: crypto.randomUUID(),
        role: "system",
      });
    }

    agent.addMessage({
      content: trimmed,
      id: crypto.randomUUID(),
      role: "user",
    });
    report(trimmed, null);

    // Providers reject later turns if prior tool calls have no result; repair before sending.
    const repaired = repairUnansweredToolCalls(agent.messages);
    if (repaired !== agent.messages) {
      agent.setMessages(repaired as typeof agent.messages);
    }

    setRunsInFlight((count) => count + 1);
    try {
      await copilotkit.runAgent({ agent });
    } finally {
      setRunsInFlight((count) => count - 1);
    }
  };

  /**
   * Send a user turn through the channel, including activity reporting and history repair.
   *
   * Every user turn in this channel goes through here — what the composer sends, the seed from the
   * compose screen, and a button inside a rendered component. That is what makes the counter worth
   * keeping here rather than in the view: the view sees only the turns it started itself, and a
   * queue that drains on the wrong one of those posts a correction into the middle of an answer.
   */
  const say = async (
    text: string,
    skillInstructions: string[] = [],
    /** The Bot this message names. Ignored unless it is actually in this room. */
    target?: string | null,
  ) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    setTurnsInFlight((count) => count + 1);
    try {
      if (!(await routeTo(target))) {
        /*
         * The room could not be pointed at the Bot this message names, so the message is NOT sent.
         * Sending it to whoever was bound a moment ago is the one outcome that must not happen: it
         * puts a question meant for the risk analyst in front of the assistant, and both the person
         * and the transcript would have every reason to believe it had been asked of the right one.
         */
        setRunError(
          t("{name} did not pick up in time. Nothing was sent — try again.", {
            name:
              agentProfiles?.find((profile) => profile.id === target)?.name ??
              String(target),
          }),
        );
        return;
      }
      await deliver(trimmed, skillInstructions);
    } finally {
      setTurnsInFlight((count) => count - 1);
    }
  };

  /**
   * Point the room at the Bot this message names, and wait for the swap to land.
   *
   * Returns whether the room is now pointed where the caller asked. FALSE MEANS DO NOT SEND. The
   * bound wait exists because a swap that never reports ready must not hang the composer forever —
   * but timing out used to fall through and send anyway, to the Bot that was bound before, which is
   * the worst of the three possible outcomes: the person asked one colleague and another answered,
   * with nothing on screen saying so.
   *
   * An id that is not in the room is ignored rather than run, and that is not a failure: `agentIds`
   * is the room's membership, and a mention of somebody outside it is a typo or a stale chip, not
   * an instruction to bring a stranger into somebody's conversation. The message goes to whoever
   * the room was already asking.
   */
  const routeTo = async (target?: string | null): Promise<boolean> => {
    if (!target || target === speakingRef.current) return true;
    if (!channel.agentIds.includes(target)) return true;

    carried.current = [...agentRef.current.messages];
    let landed = false;
    swapGate.current = new Promise<void>((resolve) => {
      openSwapGate.current = () => {
        landed = true;
        resolve();
      };
    });
    speakingRef.current = target;
    setSpeakingAgentId(target);
    await Promise.race([
      swapGate.current,
      new Promise((resolve) => setTimeout(resolve, SWAP_TIMEOUT_MS)),
    ]);
    /*
     * NOTHING IS UNWOUND ON A TIMEOUT, and the previous attempt to unwind was worse than the wait.
     * It reset the ref that the very next render overwrites from state, left the room pointed at
     * the Bot the app had just said it could not reach, and dropped the carried history so the
     * swap — which does still land, a moment later — came up with an empty transcript. The swap is
     * kept; only the message is withheld, and the person is told to try again.
     */
    return landed;
  };

  useEffect(() => {
    const fail = (message: string) => {
      if (!awaitingReply.current) return;
      awaitingReply.current = false;
      setRunError(message);
    };
    const subscription = agent.subscribe?.({
      onTextMessageStartEvent: ({ event }) => {
        const messageId = (event as { messageId?: string }).messageId;
        if (!messageId) return;
        const by = speakingRef.current;
        setLocalSpeakers((known) =>
          known[messageId] === by ? known : { ...known, [messageId]: by },
        );
      },
      // Both surfaces fall back to the same sentence, from the same place, so a person who uses
      // both is not told two different things about the same silence.
      onRunErrorEvent: ({ event }) => fail(stoppedReason(event?.message)),
      onRunFailed: ({ error }) => fail(stoppedReason(error)),
      onRunFinishedEvent: () => {
        const wasOurs = awaitingReply.current;
        awaitingReply.current = false;
        if (!wasOurs) return;

        const reply = [...agent.messages]
          .reverse()
          .find((message) => message.role === "assistant");
        const content = typeof reply?.content === "string" ? reply.content : "";
        if (content) reportRef.current(content, runtimeAgentId);
        // The turn's messages have stamps now; this is the only thing that asks for them.
        void refreshTimesRef.current();
        // And anything that landed while the Bot had the turn, which was parked rather than shown.
        if (missedWhileBusy.current) {
          missedWhileBusy.current = false;
          void catchUpRef.current();
        }
        /*
         * And the room is read again. The mark was set when the room opened; a reply that landed
         * while the person sat watching it is newer than that mark, so on leaving, the roster
         * flagged as unread the one reply they had just read. The previous mark is deliberately
         * not captured here — the line stays where the person's reading actually started.
         */
        void markRead
          .current({ channelId: channel.id, read: true })
          .catch(() => {});
      },
    });
    return () => subscription?.unsubscribe();
  }, [agent, runtimeAgentId, channel.id]);

  /*
   * Held in a ref because the run subscriber is wired once per agent, not per render — capturing
   * `refetch` directly would pin the closure to the first one and quietly stop refreshing.
   */
  const refreshTimesRef = useRef(storedTimes.refetch);
  refreshTimesRef.current = storedTimes.refetch;

  /** Stable reference for effects and component callbacks. */
  const sayRef = useRef(say);
  sayRef.current = say;

  /**
   * Component buttons speak as user turns without forcing every transcript card to re-render.
   */
  const askFromComponent = useCallback((text: string) => {
    void sayRef.current(text);
  }, []);

  /**
   * Send the create-channel seed once, after the join gate opens or the backstop expires.
   */
  useEffect(() => {
    const pending = seedRef.current;
    if (!pending) return;
    seedRef.current = null;

    void (async () => {
      await Promise.race([
        joinGatePromise,
        new Promise((resolve) =>
          setTimeout(resolve, SEND_WITHOUT_JOIN_AFTER_MS),
        ),
      ]);
      await sayRef.current(
        typeof pending.content === "string" ? pending.content : "",
      );
    })();

    // Keep `seed` in state; transcriptMessages hides it as soon as agent messages exist.
  }, [joinGatePromise]);

  /*
   * WHEN EACH MESSAGE WAS SAID — FROM THE SERVER ONLY.
   *
   * The transcript comes out of CopilotKit's agent, whose message shape has no room for a time, so
   * the stamps live in our own snapshot and arrive by their own request.
   *
   * There was a second, local clock here: stamp anything this tab watches arrive, so the separator
   * for a message you just sent appears without a round trip. It had to go. History hydration and
   * this query are two independent fetches, and when the query settled first the "already restored"
   * set it measured itself against was empty — so the whole conversation was stamped `now` and the
   * transcript announced that every message in it had been said this afternoon. A separator that is
   * a second late is a detail; one that says the wrong day is a lie about the record.
   *
   * The refetch below is what closes the gap: the server writes a message's stamp as its run
   * begins and ends, so asking again when a turn finishes gets the real time within a round trip.
   */
  const messageTimes = storedTimes.data?.times ?? EMPTY_TIMES;

  /**
   * The line that tells a Bot it is in a room with colleagues, when it is true.
   *
   * One thread, several Bots, and AG-UI has one `assistant` role: the Bot about to answer reads a
   * colleague's replies as its own previous turns and will take credit for work it never did. This
   * is the only thing standing between it and that, and it rides the same slot as a skill
   * instruction — the Bot should read the situation before the request.
   *
   * Empty unless somebody else has actually spoken here, so a room whose second Bot has never said
   * anything carries nothing. It accumulates in the thread the way a skill instruction does;
   * bounding it to "when it is true" is what keeps that to a handful.
   */
  const colleagueNote = (target: string): string[] => {
    if (channel.agentIds.length < 2) return [];
    const spoke = Object.values(speakerIds).some((id) => id !== target);
    if (!spoke) return [];
    const nameOf = (id: string) =>
      agentProfiles?.find((profile) => profile.id === id)?.name ?? id;
    return [
      ROOM_NOTE_PREFIX +
        t(
          "You are {me}. This conversation is a room with more than one colleague in it: {roster}. Some of the earlier replies here are theirs, not yours — do not claim their work or their reasoning as your own. Answer only for yourself.",
          {
            me: nameOf(target),
            roster: channel.agentIds.map(nameOf).join(", "),
          },
        ),
    ];
  };

  /*
   * Names on the bubbles, and only where a name is needed: a room with more than one Bot in it.
   *
   * Resolved here, from ids the server recorded per message, because the transcript should be
   * handed strings and not asked to look anybody up. Memoised on the two things it reads: without
   * it every streamed chunk would hand the transcript a new object and undo the memo on every
   * message in the history.
   */
  /** Message id to Bot id: what the server recorded, over what this tab watched arrive. */
  const speakerIds = useMemo(
    () => ({ ...localSpeakers, ...(storedTimes.data?.speakers ?? {}) }),
    [localSpeakers, storedTimes.data?.speakers],
  );

  const speakers = useMemo(() => {
    if (channel.agentIds.length < 2) return EMPTY_SPEAKERS;
    const names = new Map(
      (agentProfiles ?? []).map((profile) => [profile.id, profile.name]),
    );
    const resolved: Record<string, string> = {};
    for (const [messageId, agentId] of Object.entries(speakerIds)) {
      const name = names.get(agentId);
      // A Bot that has left the roster keeps its id off the bubble rather than showing an id:
      // "agent_f89904c2" over a sentence is worse than no name at all.
      if (name) resolved[messageId] = name;
    }
    return resolved;
  }, [agentProfiles, channel.agentIds.length, speakerIds]);

  return (
    <ConversationProvider ask={askFromComponent}>
      <ConversationView
        agents={toAgentOptions(agentProfiles, channel.agentIds)}
        /*
         * The TURN, not the wire — the same fact `pending` uses, and for the reason this file's own
         * note above already gives. `agent.isRunning` stays false for the second and a half while
         * `say` waits for the runtime agent, so the transcript drew nothing at all during the one
         * window a person is most likely to wonder whether anything happened: right after pressing
         * send. It was the only one of the three turn-shaped props still reading the wire.
         */
        busy={agent.isRunning || turnsInFlight > 0}
        // The `/` menu exposes only skills granted to this Bot.
        commands={skillCommands}
        // Readiness is handled by `say`; deletion is the only disabled-chat state.
        disabled={!channel.active}
        messageTimes={messageTimes}
        speakers={speakers}
        {...(readWindow ? { readWindow } : {})}
        messages={transcriptMessages(agent.messages, seed)}
        notice={
          channel.active ? null : (
            <p className="pb-2 text-sm text-muted-foreground" role="status">
              {t(
                "This coworker has been deleted. The conversation stays readable, but it can no longer reply.",
              )}
            </p>
          )
        }
        onSubmit={async (draft) => {
          /*
           * `commandIds` are the `/` chips that survived into the send, in the order they were
           * typed, and they are resolved against the skills of THE BOT THIS MESSAGE IS FOR — not
           * the one the menu was drawn from. A chip picked while A was answering and then sent to
           * B with an `@` would otherwise hand B an instruction for a skill B was never granted.
           * The same read also drops a chip for a skill that has since been revoked, which is the
           * behaviour this had before and the reason it resolves at send rather than at pick.
           */
          const target =
            draft.agentId && channel.agentIds.includes(draft.agentId)
              ? draft.agentId
              : speakingRef.current;
          const skills =
            target === runtimeAgentId
              ? skillCommands
              : (
                  (
                    await queryClient
                      .ensureQueryData(agentPluginsQueryOptions(target))
                      .catch(() => null)
                  )?.skills ?? []
                ).map((skill) => ({
                  id: skill.slug,
                  prompt: skill.instructions,
                }));
          const skillInstructions = draft.commandIds
            .map((id) => skills.find((command) => command.id === id)?.prompt)
            .filter((instruction): instruction is string =>
              Boolean(instruction),
            );

          await say(
            draft.text,
            [...colleagueNote(target), ...skillInstructions],
            draft.agentId,
          );
        }}
        /**
         * Stop through the core so the abort signal reaches frontend tools; `say` repairs any
         * unanswered tool call before the next turn.
         */
        onStop={() => {
          awaitingReply.current = false;
          copilotkit.stopAgent({ agent });
        }}
        /*
         * The turn, not the run. A browser action ends one run and starts another, and telling the
         * conversation it is idle in between is what would drain a parked correction into the
         * middle of an answer: a second turn racing the first on one thread, with a fabricated
         * result stitched over a tool call that is still executing.
         */
        pending={agent.isRunning || turnsInFlight > 0}
        /*
         * A channel outlives its turns, so it is the screen where waiting is worth offering. A
         * correction typed mid-answer is held here, in this tab, and runs as one follow-up turn the
         * moment this one is over — including when it is over because somebody pressed the button
         * above.
         */
        queueWhileBusy
        /*
         * The run, not the turn. Stop reaches a run through the core's abort controller, and that
         * controller does not exist until `say` has finished waiting for the runtime agent — so
         * this is the one place the narrower fact is the honest one to draw a button from.
         */
        stoppable={agent.isRunning || runsInFlight > 0}
        /*
         * At the END OF THE TRANSCRIPT rather than above the composer, which is where this used to
         * be. A turn that ends without an answer leaves a gap exactly where the reply was going to
         * appear, and the person is already looking at it; an explanation in the composer area is a
         * different part of the screen from the thing it explains.
         *
         * `runError` carries whatever ended the turn, in that thing's own words. A Bot that stopped
         * streaming says so, because the deployment's stall watchdog writes that sentence into the
         * run before closing it; see server/src/channels/stall-guard.ts.
         */
        stopped={runError ?? undefined}
      />
    </ConversationProvider>
  );
}
