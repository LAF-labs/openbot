import type { Message } from "@ag-ui/core";
import {
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RetriedMessage } from "@/components/channels/chat-transcript";
import { LEADING_SKILL } from "@/components/channels/composer/draft";
import {
  claimAutoSend,
  forgetUnsent,
  keepUnsent,
  noteResent,
  readUnsent,
  type UnsentMessage,
  useUnsent,
} from "@/components/channels/composer/outbox";
import { DraftScope } from "@/components/channels/composer/prefill";
import { ConversationView } from "@/components/channels/conversation-view";
import {
  forgetFirstMessage,
  hearFirstMessages,
  peekFirstMessage,
  seedMessage,
  transcriptMessages,
} from "@/components/channels/transcript-messages";
import { BrowsingBanner } from "@/components/computer/browsing-banner";
import { turnPhaseOf, usePublishTurn } from "@/lib/agents/presence";
import {
  recordChannelActivityMutationOptions,
  setChannelReadMutationOptions,
} from "@/lib/channels/mutations";
import {
  type AgentChannel,
  channelFailuresQueryOptions,
  messageTimesQueryOptions,
} from "@/lib/channels/queries";
import { retryWay, standingFailures } from "@/lib/channels/retry";
import {
  loadThreadHistory,
  mergeStoredHistory,
} from "@/lib/channels/thread-history";
import { liveTurnFailureCode } from "@/lib/channels/turn-failure";
import {
  CHANNEL_ACTIVITY,
  type ChannelActivity,
  channelActivity,
  isSocketLost,
  SOCKET_RECONNECTED,
  socketState,
} from "@/lib/channels/use-channel-events";
import { useBrowsingTasks } from "@/lib/computer/use-browsing-tasks";
import { useActiveBot, useActiveConversation } from "@/lib/copilot/active-bot";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { holdChat } from "@/lib/copilot/held-chats";
import { repairUnansweredToolCalls } from "@/lib/copilot/repair-history";
import { useToolsSettled } from "@/lib/copilot/tools-settled";

import { t } from "@/lib/i18n";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { refreshTodayUsage } from "@/lib/usage/today";

/**
 * Backstop for the first message of a new channel; a stalled join must not lose the message.
 */
const SEND_WITHOUT_JOIN_AFTER_MS = 1500;

/**
 * Backstop for the Bot's grants: a turn waits for them so every turn offers the same tools
 * (`useToolsSettled`), but a grant endpoint that never answers must not hold a message forever.
 */
const SEND_WITHOUT_GRANTS_AFTER_MS = 5000;

/** Frozen and shared, so "no times yet" is one identity rather than a new object per render. */
const EMPTY_TIMES: Readonly<Record<string, string>> = Object.freeze({});

/**
 * One channel's conversation with one coworker.
 *
 * The local agent id is channel-scoped so two channels with the same coworker keep separate
 * durable threads.
 */
export function ChannelChat({
  channel,
  runtimeAgentId,
}: {
  channel: AgentChannel;
  /**
   * The one Bot this conversation is with.
   *
   * A channel with more than one Bot never reaches this component — the route sends it to
   * `GroupChat`, where the turn runs on the server. Everything here can therefore assume one
   * Bot for the life of the thread, which is what lets the binding below be a constant.
   */
  runtimeAgentId: string;
}) {
  /*
   * NOT COMPILED, BECAUSE THE AGENT CHANGES UNDER IT.
   *
   * `agent` is one object CopilotKit keeps mutating, and `agent.messages` is one array: a streamed
   * reply is appended to it and then grown chunk by chunk, in place (`@ag-ui/client` adds each delta
   * onto the same message object and hands back the same array). The React Compiler assumes what a
   * hook returns never changes behind its back and skips any work whose inputs are the same objects
   * as last time — so compiled, this component would compute the transcript once and keep it, and a
   * Bot that answered would look like a Bot that had not. That is the bug `ChatTranscript` records
   * for a `useMemo`; the compiler would reintroduce it everywhere at once. So this one component,
   * where the agent enters the tree, reads it fresh on every render, and hands everything below it
   * a copy (`thread`, below).
   */
  "use no memo";

  /** Something arrived while the Bot had the turn; show it once the turn is over. */
  const missedWhileBusy = useRef(false);

  // The core attaches the frontend tool registry; direct agent runs do not.
  const { copilotkit } = useCopilotKit();
  const queryClient = useQueryClient();
  // Declared here, not beside its use: the run subscriber below holds a ref to its refetch.
  const storedTimes = useQuery(messageTimesQueryOptions(channel.id));
  /*
   * The turns in this conversation that got no answer, from the server's own run ledger.
   *
   * This is the half that survives a reload. Nothing new is written for it — a failed run has
   * always been recorded — the app simply never asked. See server/src/channels/turn-failures.ts.
   */
  const storedFailures = useQuery(channelFailuresQueryOptions(channel.id));

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

  /**
   * First-message seed from the compose screen. It is taken once per mount and retained until the
   * agent has its own messages because joining a fresh thread can temporarily empty the agent.
   */
  const [seed] = useState<Message | null>(() => {
    // Left in place while drawing: a render thrown away reads it again (`transcript-messages.ts`).
    const pending = peekFirstMessage(channel.id);
    return pending ? seedMessage(pending, crypto.randomUUID()) : null;
  });
  // Forgotten once this conversation is drawn, so a later mount cannot send it again.
  useEffect(() => {
    forgetFirstMessage(channel.id);
  }, [channel.id]);

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

  /*
   * Promise gate so no turn goes out before this Bot's tools are decided. Opened in an effect: the
   * tool registrations it waits for are effects too, earlier in the tree, and run first.
   */
  const toolsSettled = useToolsSettled(runtimeAgentId);
  const openToolsGate = useRef<() => void>(() => {});
  const toolsGate = useRef<Promise<void> | null>(null);
  if (toolsGate.current === null) {
    toolsGate.current = new Promise<void>((resolve) => {
      openToolsGate.current = resolve;
    });
  }
  const toolsGatePromise = toolsGate.current;
  useEffect(() => {
    if (toolsSettled) openToolsGate.current();
  }, [toolsSettled]);

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
        /*
         * MERGED, NOT APPLIED ONLY TO AN EMPTY AGENT. Joining replays the runtime's last run from
         * memory, and a question whose run failed after it is in the store and not in that replay —
         * it vanished on reload, and the 다시 시도 under it with it. See `mergeStoredHistory`, which
         * also keeps anything this tab sent while the history was on its way. Not over a run in
         * flight, whose stream is still appending to the array.
         */
        if (current && stored && stored.length > 0 && !agent.isRunning) {
          const merged = mergeStoredHistory(stored, agent.messages);
          if (merged !== agent.messages) {
            agent.setMessages(merged as typeof agent.messages);
          }
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
    const stored = await loadThreadHistory(channel.threadId, runtimeAgentId);
    // Unreadable: the next open of the room shows it; nothing here is worth a banner.
    if (!stored) return;
    const seen = new Set(agent.messages.map((message) => message.id));
    const missing = stored.filter((message) => !seen.has(message.id));
    if (missing.length === 0) return;
    agent.setMessages([...agent.messages, ...missing]);
    void refreshTimesRef.current();
    // Read, because it is on the screen in front of them.
    void markRead
      .current({ channelId: channel.id, read: true })
      .catch(() => {});
  }, [agent, channel.id, channel.threadId, runtimeAgentId]);
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

  // Tool calls from this conversation act on this coworker's own computer, and they say which
  // conversation they came from, so a question one raises can be answered for it.
  useActiveBot(runtimeAgentId);
  useActiveConversation(channel.threadId);

  const skillCommands = useSkillCommands(runtimeAgentId);

  /*
   * Run failures arrive as events and are reported only for turns started in this mount.
   *
   * A CODE, not the sentence. This used to hold whatever ended the turn in that thing's own words,
   * and what that turned out to mean in practice was `HTTP 404: {"error":"Not found."}` and
   * `Unable to connect. Is the computer able to access the url?` — English, in red, on a Korean
   * screen. `liveTurnFailureCode` reduces it to a fact and the transcript owns the sentence.
   */
  const [runError, setRunError] = useState<string | null>(null);
  /** Message id to the moment this tab sent it, for separators the server has not stamped yet. */
  const [sentAt, setSentAt] = useState<Record<string, string>>({});
  const awaitingReply = useRef(false);
  /**
   * The person's messages the turn in flight carries that the server may not have yet: kept on this
   * device if the run never reaches it, forgotten the moment it plainly has (`composer/outbox.ts`).
   */
  const sending = useRef<Omit<UnsentMessage, "autoTried">[]>([]);
  /** What this device kept because the server never got it, drawn in the thread until it does. */
  const unsent = useUnsent(channel.id);

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
   * idle in every one of those gaps — the truth about the wire and a lie about the turn. LAF Agent
   * registers every computer tool as a frontend tool, so the gaps open on ordinary work rather than
   * on some edge case, and anything keyed on the turn ending fires in the middle of one instead.
   *
   * Counters rather than booleans because nothing stops a second turn being started from a
   * component button while the first is still going, and two overlapping turns must not have the
   * first one to finish declare the conversation idle.
   */
  const [turnsInFlight, setTurnsInFlight] = useState(0);
  const [runsInFlight, setRunsInFlight] = useState(0);
  /*
   * The same count, readable outside a render: `모두 멈추기` asks whether this conversation has a
   * turn in flight from the sidebar, between renders, and state read there is a render behind.
   */
  const turnsNow = useRef(0);
  /**
   * `모두 멈추기` reached this turn before its first run began — while `say` was still waiting for the
   * runtime agent. The Stop button is not drawn in that window because there is no run to abort, so
   * the stop is kept here instead and `run` declines to start. Cleared by the next turn.
   */
  const stopBeforeRun = useRef(false);

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
  /** Wait briefly for the runtime agent instance; a stalled join must not lose the turn. */
  const untilReady = async () => {
    await Promise.race([
      toolsGatePromise,
      new Promise((resolve) =>
        setTimeout(resolve, SEND_WITHOUT_GRANTS_AFTER_MS),
      ),
    ]);
    if (isReadyRef.current) return;
    await Promise.race([
      readyGatePromise,
      new Promise((resolve) => setTimeout(resolve, SEND_WITHOUT_JOIN_AFTER_MS)),
    ]);
  };

  const deliver = async (trimmed: string, skillInstructions: string[]) => {
    // Before adding the message, not after: a message added to a provisional agent is lost.
    await untilReady();

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
     * WHAT WAS KEPT GOES FIRST. A message this device kept because the server never got it, and
     * that a reload left outside the thread, would otherwise sit below this one forever — drawn
     * after it and never sent. It goes in front, where it was typed, and leaves with this turn.
     */
    const present = new Set(agent.messages.map((message) => message.id));
    const kept = readUnsent(channel.id).filter(
      (message) => !present.has(message.id),
    );
    for (const message of kept) {
      for (const instruction of message.instructions) {
        agent.addMessage({
          content: instruction,
          id: crypto.randomUUID(),
          role: "system",
        });
      }
      agent.addMessage({ content: message.text, id: message.id, role: "user" });
    }

    for (const instruction of skillInstructions) {
      agent.addMessage({
        content: instruction,
        id: crypto.randomUUID(),
        role: "system",
      });
    }

    /*
     * STAMPED HERE, BY THE TAB THAT MINTED THE ID.
     *
     * The transcript's date separators come from the server's `message-times`, which is read once
     * when the channel opens and again when a turn FINISHES. So the message a person has just sent
     * has no time for the whole length of the turn, and a conversation resuming after a gap grew
     * its "오늘 오전 2:15" line only on reload — measured 2026-09-06.
     *
     * This is not a guess about when it was said: this line is the moment it was said, and the id
     * is one this function just minted, so there is no question of stamping somebody else's
     * history. The server's own stamp replaces it as soon as `message-times` is read again, which
     * is why these are merged UNDER the stored times rather than over them.
     */
    const messageId = crypto.randomUUID();
    const at = new Date().toISOString();
    setSentAt((held) => ({ ...held, [messageId]: at }));
    agent.addMessage({
      content: trimmed,
      id: messageId,
      role: "user",
    });
    report(trimmed, null);
    // What would be kept on this device if the server never gets it (`composer/outbox.ts`).
    sending.current = [
      ...kept.map(({ id, text, instructions, at: keptAt }) => ({
        id,
        text,
        instructions,
        at: keptAt,
      })),
      { id: messageId, text: trimmed, instructions: skillInstructions, at },
    ];

    await run();
  };

  /**
   * The run itself: the thread as it stands, sent.
   *
   * Its own function because a retry needs exactly this and nothing above it. The failed question
   * is already in the thread — the server stored it the moment the run began — so asking again is
   * running the thread again, not adding the words a second time.
   */
  const run = async () => {
    if (stopBeforeRun.current) {
      // No reply is coming, so nothing may go on waiting for one — activity would park behind it.
      awaitingReply.current = false;
      return;
    }
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
   * 다시 시도 under a failed question.
   *
   * MEASURED 2026-09-10 (audit A4, finding 1): this used to be `say(text)`, and the thread held
   * "지금 몇 시야" twice afterwards — on screen, in the store, in the export and in every prompt from
   * then on. The message was still there; what had not happened was the answer. So the thread is run
   * again with the question where it is, under the id the server's store already holds, which it
   * treats as a re-arrival of that row rather than a second one (`lib/channels/retry.ts`).
   *
   * The transcript draws the button only where the question can be asked again at all
   * (`retryWay`). A press that arrives after the person asked something else does nothing: the
   * answer would land under the wrong question.
   */
  const retry = async ({ id, text }: RetriedMessage) => {
    // Never reached the server: sent again from what this device kept, rather than retried.
    if (readUnsent(channel.id).some((message) => message.id === id)) {
      await resend(false);
      return;
    }
    const way = retryWay(agent.messages, id);
    if (way === null) return;
    /*
     * The Bot had answered part of it before it stopped (UI/UX audit 0.5.3, item 5). Run in place,
     * the provider would be handed a thread ending in the Bot's own half sentence, so the question
     * is asked again — the words, and the skill it was asked with — as what it is: a second asking,
     * below the half answer it did not finish.
     */
    if (way === "ask-again") {
      const skill = LEADING_SKILL.exec(text)?.[1];
      const prompt = skillCommands.find(
        (command) => command.name === skill,
      )?.prompt;
      await say(text, prompt ? [prompt] : []);
      return;
    }
    stopBeforeRun.current = false;
    turnsNow.current += 1;
    setTurnsInFlight((count) => count + 1);
    try {
      await untilReady();
      setRunError(null);
      awaitingReply.current = true;
      // The server stored this question when its first run began; there is nothing to keep.
      sending.current = [];
      await run();
    } finally {
      turnsNow.current -= 1;
      setTurnsInFlight((count) => count - 1);
    }
  };

  /**
   * Send again what this device kept because the server never got it (UI/UX audit 0.5.3, item 6).
   *
   * All of it, as one turn, under the ids it was first sent with: the server's store treats a
   * message it already holds as that message, so a copy that did arrive after all is not stored
   * twice. `automatic` is the one try made by itself when the connection comes back; it claims the
   * messages first, so a second tab of the same conversation hearing the same reconnect sends
   * nothing, and a message that fails again waits for the person.
   *
   * A reload found these in storage and not in the thread, so they are put back into it first —
   * with the skill instructions they were sent with, in front of them, as `deliver` does.
   */
  const resend = async (automatic: boolean) => {
    if (turnsNow.current > 0) return;
    const messages = automatic
      ? claimAutoSend(channel.id)
      : [...readUnsent(channel.id)];
    if (messages.length === 0) return;
    stopBeforeRun.current = false;
    turnsNow.current += 1;
    setTurnsInFlight((count) => count + 1);
    try {
      await untilReady();
      setRunError(null);
      awaitingReply.current = true;
      const present = new Set(agent.messages.map((message) => message.id));
      for (const message of messages) {
        if (present.has(message.id)) continue;
        for (const instruction of message.instructions) {
          agent.addMessage({
            content: instruction,
            id: crypto.randomUUID(),
            role: "system",
          });
        }
        agent.addMessage({
          content: message.text,
          id: message.id,
          role: "user",
        });
        setSentAt((held) => ({ ...held, [message.id]: message.at }));
      }
      sending.current = messages.map(({ id, text, instructions, at }) => ({
        id,
        text,
        instructions,
        at,
      }));
      if (automatic) noteResent(messages.map((message) => message.id));
      await run();
    } finally {
      turnsNow.current -= 1;
      setTurnsInFlight((count) => count - 1);
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
  const say = async (text: string, skillInstructions: string[] = []) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    stopBeforeRun.current = false;
    turnsNow.current += 1;
    setTurnsInFlight((count) => count + 1);
    try {
      await deliver(trimmed, skillInstructions);
    } finally {
      turnsNow.current -= 1;
      setTurnsInFlight((count) => count - 1);
    }
  };

  useEffect(() => {
    const fail = (code: string) => {
      if (!awaitingReply.current) return;
      awaitingReply.current = false;
      /*
       * THE ONE FAILURE THAT CAN LOSE WHAT SOMEBODY TYPED. The server stores a person's words when
       * a run begins, so every other failure left them stored; this one means the run never reached
       * it. They are kept on this device and drawn as not sent, which says it instead of the red
       * line — two lines under one message saying the same thing would be one too many.
       */
      if (
        code === "laf:turn_server_unreachable" &&
        sending.current.length > 0
      ) {
        for (const message of sending.current) keepUnsent(channel.id, message);
        sending.current = [];
        setRunError(null);
      } else {
        heard();
        setRunError(code);
      }
      /*
       * The server has just written the failure into the run ledger, and the person's own message
       * has just been stamped. Both were only ever asked for on a turn that SUCCEEDED, which is
       * why a failed turn left no separator and vanished entirely on reload.
       */
      void refreshTimesRef.current();
      void refreshFailuresRef.current();
    };
    /*
     * The run reached the server, which stored the thread it carried: nothing of it is unsent any
     * more, including a message kept earlier that went along with a later one.
     */
    const heard = () => {
      sending.current = [];
      forgetUnsent(
        channel.id,
        agent.messages.map((message) => message.id),
      );
    };
    /*
     * The Bot's words had started to arrive in this turn: an assistant message with words after
     * the person's last one. What tells a Bot that stopped partway from one that never answered,
     * when both end in the same error (`liveTurnFailureCode`).
     */
    const answerStarted = () => {
      const messages = agent.messages;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === "user") return false;
        if (
          message?.role === "assistant" &&
          typeof message.content === "string" &&
          message.content.trim()
        ) {
          return true;
        }
      }
      return false;
    };
    const subscription = agent.subscribe?.({
      // Both surfaces fall back to the same sentence, from the same place, so a person who uses
      // both is not told two different things about the same silence.
      // With the account's socket down, the server is the thing that failed, whatever the status.
      onRunErrorEvent: ({ event }) =>
        fail(
          liveTurnFailureCode(event?.message, {
            connectionLost: isSocketLost(),
            answerStarted: answerStarted(),
          }),
        ),
      onRunFailed: ({ error }) =>
        fail(
          liveTurnFailureCode(error, {
            connectionLost: isSocketLost(),
            answerStarted: answerStarted(),
          }),
        ),
      /*
       * The run began on the server, which stores the person's words as it does: what was kept
       * has arrived, so it stops saying "다시 보내는 중" for the whole length of the answer.
       */
      onRunStartedEvent: () => {
        if (awaitingReply.current) heard();
      },
      onRunFinishedEvent: () => {
        const wasOurs = awaitingReply.current;
        awaitingReply.current = false;
        if (!wasOurs) return;
        heard();

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
   * A TURN THAT ENDED MOVES TODAY'S METER — on a free trial, once per turn, and not per run: a turn
   * that used the browser is several runs, and the count is only worth asking for once they are all
   * in. `turnsInFlight` falling to zero is the whole turn being over, however it ended.
   */
  const hadTurn = useRef(false);
  useEffect(() => {
    if (turnsInFlight > 0) {
      hadTurn.current = true;
      return;
    }
    if (!hadTurn.current) return;
    hadTurn.current = false;
    refreshTodayUsage(queryClient);
  }, [turnsInFlight, queryClient]);

  /*
   * THIS CONVERSATION'S STOP, HANDED TO `모두 멈추기` for as long as it is on screen.
   *
   * The same two things the Stop button does — no reply is awaited any more, and the core is told,
   * which aborts the run, the browser step under way and any follow-up run — plus the one the button
   * cannot do, stopping a turn whose first run has not begun (`stopBeforeRun`). The server stops the
   * run on the wire and refuses to carry a step on; only this window can cut the step itself.
   */
  useEffect(
    () =>
      holdChat({
        threadId: channel.threadId,
        busy: () => agent.isRunning || turnsNow.current > 0,
        stop: () => {
          stopBeforeRun.current = true;
          awaitingReply.current = false;
          copilotkit.stopAgent({ agent });
        },
      }),
    [agent, copilotkit, channel.threadId],
  );

  /*
   * Held in a ref because the run subscriber is wired once per agent, not per render — capturing
   * `refetch` directly would pin the closure to the first one and quietly stop refreshing.
   */
  const refreshTimesRef = useRef(storedTimes.refetch);
  refreshTimesRef.current = storedTimes.refetch;
  /** Same reason as `refreshTimesRef`: the run subscriber is wired once, not once per render. */
  const refreshFailuresRef = useRef(storedFailures.refetch);
  refreshFailuresRef.current = storedFailures.refetch;

  /** Stable reference for effects and component callbacks. */
  const sayRef = useRef(say);
  sayRef.current = say;
  const retryRef = useRef(retry);
  retryRef.current = retry;
  const resendRef = useRef(resend);
  resendRef.current = resend;

  /*
   * THE CONNECTION CAME BACK: WHAT WAS KEPT GOES, ONCE, BY ITSELF.
   *
   * Two ways it comes back. The socket reconnects under an open conversation. Or the person
   * reloads — or the 서버에 닿지 못했습니다 screen sends them back here — and the conversation
   * opens with something kept and a server that answered the page, which is the connection back.
   * Once the history is in, so the kept words land after what the thread already holds.
   */
  useEffect(() => {
    const onBack = () => {
      if (readUnsent(channel.id).length > 0) void resendRef.current(true);
    };
    socketState.addEventListener(SOCKET_RECONNECTED, onBack);
    // A device that was offline for a moment may never have lost the socket; its network is back.
    window.addEventListener("online", onBack);
    return () => {
      socketState.removeEventListener(SOCKET_RECONNECTED, onBack);
      window.removeEventListener("online", onBack);
    };
  }, [channel.id]);
  useEffect(() => {
    let current = true;
    void joinGatePromise.then(() => {
      if (!current || isSocketLost() || navigator.onLine === false) return;
      if (readUnsent(channel.id).some((message) => !message.autoTried)) {
        void resendRef.current(true);
      }
    });
    return () => {
      current = false;
    };
  }, [joinGatePromise, channel.id]);

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

  // A first message started for this conversation while it is already on screen (a sidebar chip).
  useEffect(
    () =>
      hearFirstMessages(channel.id, (text) => {
        void sayRef.current(text);
      }),
    [channel.id],
  );

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
  /*
   * The stored times over this tab's own, never the other way round. A local stamp is a stand-in
   * for the round trip, and the moment the real one lands it is the one that counts — otherwise two
   * tabs would draw the same conversation with two different sets of separators.
   */
  const stored = storedTimes.data?.times;
  const messageTimes = useMemo(() => {
    // A message kept on this device has no stamp on the server; the moment it was sent is its time.
    const kept = Object.fromEntries(
      unsent.map((message) => [message.id, message.at]),
    );
    return Object.keys(sentAt).length === 0 && unsent.length === 0
      ? (stored ?? EMPTY_TIMES)
      : { ...kept, ...sentAt, ...(stored ?? {}) };
  }, [sentAt, stored, unsent]);
  /**
   * Message id to failure code, which is the shape the transcript draws from — without the ones a
   * retry has since answered, which the server's record keeps (`standingFailures`).
   *
   * Not memoised: `agent.messages` is the same array mutated in place, so a memo keyed on it would
   * keep the first answer forever (see `ChatTranscript`), and this is a walk over the thread.
   */
  const failuresById = standingFailures(
    storedFailures.data,
    agent.messages,
    storedTimes.data ? messageTimes : undefined,
  );

  /*
   * A NEW ARRAY ON EVERY RENDER, BECAUSE THE AGENT'S NEVER IS.
   *
   * Everything under this component is compiled, and compiled code keeps what it drew while its
   * inputs are the same objects. Handed the agent's own array, the transcript would keep the first
   * chunk of a reply. A copy costs one pass over the thread's references per render, and it makes
   * "the messages changed" true exactly when this component has rendered because they did.
   */
  const inThread = new Set(agent.messages.map((message) => message.id));
  const thread = [
    ...transcriptMessages(agent.messages, seed),
    /*
     * What this device kept and the thread does not hold — after a reload, since the server never
     * had it to replay. Drawn where it was typed, at the end, as not sent (`ChatTranscript`), until
     * a send puts it into the thread for real.
     */
    ...unsent
      .filter((message) => !inThread.has(message.id))
      .map(
        (message): Message => ({
          content: message.text,
          id: message.id,
          role: "user",
        }),
      ),
  ];

  /*
   * The task the Bot is doing in its browser, told to the banner and the header, and each task's
   * last picture kept when it ends. From the same copy the transcript draws, so the banner and the
   * card under it name the same task.
   */
  const openTask = useBrowsingTasks({
    channelId: channel.id,
    botId: runtimeAgentId,
    messages: thread,
    busy: agent.isRunning || turnsInFlight > 0,
  });

  /*
   * Where the turn is — thinking, working, answering — told to the header's pill (`presence.ts`).
   * The same turn-shaped fact the transcript draws from, read from the same copy of the thread.
   */
  usePublishTurn(
    runtimeAgentId,
    turnPhaseOf(thread, agent.isRunning || turnsInFlight > 0),
  );

  /*
   * STABLE BY HAND, BECAUSE NOTHING HERE IS MEMOISED FOR US.
   *
   * The compiled view keeps the composer it drew last time for as long as the composer's props are
   * the same objects. Built inline, these two were new on every render of this component — every
   * streamed chunk of an answer — so the box somebody is typing in redrew with each word the Bot
   * wrote. Neither reads the agent's messages, which is the one thing this component must never
   * cache.
   */
  /**
   * Stop through the core so the abort signal reaches frontend tools; `say` repairs any
   * unanswered tool call before the next turn.
   */
  const handleStop = useCallback(() => {
    awaitingReply.current = false;
    copilotkit.stopAgent({ agent });
  }, [agent, copilotkit]);

  return (
    <ConversationProvider ask={askFromComponent}>
      {/* The composer below takes a sentence offered to this conversation (`?draft=`), and no other. */}
      <DraftScope.Provider value={channel.id}>
        <ConversationView
          banner={
            <BrowsingBanner
              asked={openTask?.asked}
              botId={runtimeAgentId}
              isStoppable={agent.isRunning || runsInFlight > 0}
              onStop={handleStop}
            />
          }
          /*
           * The TURN, not the wire — the same fact `pending` uses, and for the reason this file's own
           * note above already gives. `agent.isRunning` stays false for the second and a half while
           * `say` waits for the runtime agent, so the transcript drew nothing at all during the one
           * window a person is most likely to wonder whether anything happened: right after pressing
           * send. It was the only one of the three turn-shaped props still reading the wire.
           */
          busy={agent.isRunning || turnsInFlight > 0}
          // What a 좋아요·아쉬워요 under an answer belongs to.
          channelId={channel.id}
          // The `/` menu exposes only skills granted to this Bot.
          commands={skillCommands}
          // Readiness is handled by `say`; deletion is the only disabled-chat state.
          disabled={!channel.active}
          messageTimes={messageTimes}
          {...(readWindow ? { readWindow } : {})}
          messages={thread}
          notice={
            channel.active ? null : (
              <p className="pb-2 text-sm text-muted-foreground" role="status">
                {t(
                  "This Bot has been deleted. The conversation stays readable, but it can no longer reply.",
                )}
              </p>
            )
          }
          onSubmit={async (draft) => {
            /*
             * `commandIds` are the `/` chips that survived into the send, in the order they were
             * typed. Resolved against the same list the menu was built from, so a chip left over
             * from a skill that has since been revoked resolves to nothing rather than to a stale
             * instruction — the menu is refetched, and this reads from it.
             */
            const skillInstructions = draft.commandIds
              .map(
                (id) =>
                  skillCommands.find((command) => command.id === id)?.prompt,
              )
              .filter((instruction): instruction is string =>
                Boolean(instruction),
              );

            await say(draft.text, skillInstructions);
          }}
          onStop={handleStop}
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
          stoppedCode={runError ?? undefined}
          failures={failuresById}
          onRetry={(message) => {
            // The failure line is this tab's; clear it so the retry is not drawn as still failed.
            setRunError(null);
            void retryRef.current(message);
          }}
        />
      </DraftScope.Provider>
    </ConversationProvider>
  );
}
