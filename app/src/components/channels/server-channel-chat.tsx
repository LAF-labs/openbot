import type { Message, Tool } from "@ag-ui/core";
import { useCopilotKit } from "@copilotkit/react-core/v2";
import { type AttachmentPart, attachmentPartsOf } from "@shared/attachments";
import { MANAGE_ROUTINE, REMEMBER, UPDATE_PROFILE } from "@shared/tools/self";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CarryOnNotice } from "@/components/channels/carry-on-notice";
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
import { agentKeys, agentQueryOptions } from "@/lib/agents/queries";
import { contentOf } from "@/lib/attachments/message";
import { authKeys, currentUserQueryOptions } from "@/lib/auth/queries";
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
import { liveTurnFailureCode } from "@/lib/channels/turn-failure";
import {
  isSocketLost,
  SOCKET_RECONNECTED,
  socketState,
} from "@/lib/channels/use-channel-events";
import { useBrowsingTasks } from "@/lib/computer/use-browsing-tasks";
import { useActiveBot, useActiveConversation } from "@/lib/copilot/active-bot";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { holdChat } from "@/lib/copilot/held-chats";
import { taskStopOf } from "@/lib/copilot/stranded-steps";
import { useToolsSettled } from "@/lib/copilot/tools-settled";
import { t } from "@/lib/i18n";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { routineKeys } from "@/lib/routines/queries";
import { ServerAnswersProvider } from "@/lib/turns/answers";
import { answerCard, sendTurn, stopTurn } from "@/lib/turns/client";
import { isTurnGoing, type TurnFrame } from "@/lib/turns/frames";
import { watchServerQuestions } from "@/lib/turns/questions";
import { createThreadStore } from "@/lib/turns/thread-store";
import { refreshTodayUsage } from "@/lib/usage/today";
import { deviceClock } from "@/lib/whereabouts/queries";

/**
 * How long a send waits for the Bot's grants: every turn offers the same tools (`useToolsSettled`),
 * but a grant endpoint that never answers must not hold a message forever.
 */
const SEND_WITHOUT_GRANTS_AFTER_MS = 5000;

/** Frozen and shared, so "no times yet" is one identity rather than a new object per render. */
const EMPTY_TIMES: Readonly<Record<string, string>> = Object.freeze({});

/** A window that was out of sight this long reopens its stream when it comes back. */
const REOPEN_AFTER_HIDDEN_MS = 20_000;

/**
 * One conversation with the one Bot, while the server owns its turns (`server/src/turns/`).
 *
 * `ChannelChat` drove each turn from this window through CopilotKit — the page ran the model, carried
 * out every tool call and started the next run — so a closed laptop ended the task, and a second
 * window could only replay the first. Here the window hands over what the person said and WATCHES:
 * the turn runs on the server, every window of the conversation sees the same numbered frames, and a
 * window that reopens catches up from its cursor. What the person sees is kept the same — the same
 * transcript, tool lines, cards, questions, Stop, 이어서 하기, 다시 시도 and files — drawn from the
 * server's events instead of from an agent running in the page.
 *
 * CopilotKit stays for what it draws: the tool lines and cards are registered renderers, and it is
 * asked which tools this window offers so the turn offers the same ones. Nothing here calls
 * `runAgent`, so no frontend tool's handler ever runs in the page.
 *
 * History arrives a page at a time (`lib/turns/thread-store.ts`), newest first.
 */
export function ServerChannelChat({
  channel,
  runtimeAgentId,
}: {
  channel: AgentChannel;
  /** The one Bot this conversation is with. */
  runtimeAgentId: string;
}) {
  const { copilotkit } = useCopilotKit();
  const queryClient = useQueryClient();
  const storedTimes = useQuery(messageTimesQueryOptions(channel.id));
  const storedFailures = useQuery(channelFailuresQueryOptions(channel.id));
  const botName = useQuery(agentQueryOptions(runtimeAgentId)).data?.name;
  const signedIn = useQuery(currentUserQueryOptions()).data;
  const deployment =
    typeof signedIn === "object" && signedIn ? signedIn.deployment : undefined;

  const [store] = useState(() => createThreadStore(channel.threadId));
  const thread = useSyncExternalStore(store.subscribe, store.snapshot);
  const going = isTurnGoing(thread.turn);

  /*
   * OPENING A ROOM MARKS IT READ, AND HANDS BACK WHERE THE READING STOPPED — once per mounted room,
   * and the guard is load-bearing (see `ChannelChat`, which learnt it: the second call of a
   * development double-mount answers with the mark the first had just written).
   */
  const setRead = useMutation(setChannelReadMutationOptions(queryClient));
  const [readWindow, setReadWindow] = useState<{
    from: string;
    until: string;
  } | null>(null);
  const markRead = useEffectEvent(() =>
    setRead
      .mutateAsync({ channelId: channel.id, read: true })
      .catch(() => null),
  );
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (marked.current === channel.id) return;
    marked.current = channel.id;
    void markRead().then((result) => {
      if (result?.previousReadAt && result.readAt) {
        setReadWindow({ from: result.previousReadAt, until: result.readAt });
      }
    });
  }, [channel.id]);

  // The newest page and the live stream, together; closed with the room.
  useEffect(() => {
    void store.open();
    return () => store.close();
  }, [store]);

  /*
   * THE FIRST MESSAGE FROM THE COMPOSE SCREEN, drawn until the thread has messages of its own. Taken
   * once per mount; forgotten once drawn, so a later mount cannot send it again.
   */
  const [seed] = useState<Message | null>(() => {
    const pending = peekFirstMessage(channel.id);
    return pending ? seedMessage(pending, crypto.randomUUID()) : null;
  });
  useEffect(() => {
    forgetFirstMessage(channel.id);
  }, [channel.id]);

  // Tool calls act on this Bot's computer and say which conversation they came from.
  useActiveBot(runtimeAgentId);
  useActiveConversation(channel.threadId);
  const skillCommands = useSkillCommands(runtimeAgentId);
  const toolsSettled = useToolsSettled(runtimeAgentId);

  /** What this device kept because the server never got it, drawn in the thread until it does. */
  const unsent = useUnsent(channel.id);
  /** Message id to the moment this tab sent it, for separators the server has not stamped yet. */
  const [sentAt, setSentAt] = useState<Record<string, string>>({});
  /** Sends on their way to the server: the Bot has the turn from the person's point of view. */
  const [sending, setSending] = useState(0);
  /** A send the server never took, as a failure code for the line at the end of the transcript. */
  const [sendFailure, setSendFailure] = useState<string | null>(null);
  const busy = going || sending > 0;

  const recordActivity = useMutation(recordChannelActivityMutationOptions());
  const report = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // The person's line on the roster. The Bot's is the server's to report, when its turn ends.
    recordActivity.mutate({
      agentId: null,
      at: new Date().toISOString(),
      channelId: channel.id,
      text: trimmed,
    });
  };

  /** The tools this window would have offered the Bot, for the turn to offer the same. */
  const declaredTools = async (): Promise<Tool[] | null> => {
    if (!toolsSettled) {
      await new Promise((resolve) =>
        setTimeout(resolve, SEND_WITHOUT_GRANTS_AFTER_MS),
      );
    }
    const core = copilotkit as unknown as {
      buildFrontendTools?: (agentId?: string) => Tool[];
    };
    return core.buildFrontendTools?.(runtimeAgentId) ?? null;
  };

  /**
   * Hand the server a turn: what was kept on this device first, then the skill instructions, then
   * what the person said. Drawn at once; the stream's own copies replace these by id.
   */
  const handOver = async (
    outgoing: Omit<UnsentMessage, "autoTried">[],
    retrying: Message | null,
  ): Promise<void> => {
    const messages: Message[] = retrying
      ? [retrying]
      : outgoing.flatMap((message) => [
          ...message.instructions.map(
            (instruction): Message => ({
              content: instruction,
              id: crypto.randomUUID(),
              role: "system",
            }),
          ),
          {
            content: contentOf(message.text, message.attachments ?? []),
            id: message.id,
            role: "user",
          } as Message,
        ]);
    const drawn = messages.filter((message) => message.role === "user");
    if (!retrying) {
      const at = new Date().toISOString();
      store.addLocal(drawn, at);
      setSentAt((held) => ({
        ...held,
        ...Object.fromEntries(
          outgoing.map((message) => [message.id, message.at]),
        ),
      }));
    }
    setSendFailure(null);
    store.clearEnding();
    setSending((count) => count + 1);
    const tools = await declaredTools();
    const sent = await sendTurn(channel.threadId, {
      botId: runtimeAgentId,
      messages,
      tools,
      device: deviceClock(),
    });
    setSending((count) => count - 1);
    if (sent.ok) {
      forgetUnsent(
        channel.id,
        outgoing.map((message) => message.id),
      );
      return;
    }
    if (retrying) {
      setSendFailure(
        sent.reached ? "laf:turn_failed" : "laf:turn_server_unreachable",
      );
      return;
    }
    /*
     * THE ONE FAILURE THAT CAN LOSE WHAT SOMEBODY TYPED: the server never took it — unreachable, or
     * another window's turn got there first. Kept on this device and drawn as not sent, which says
     * so instead of a red line, and sent again by itself when the connection or the turn frees up.
     */
    for (const message of outgoing) keepUnsent(channel.id, message);
    store.removeLocal(drawn.map((message) => message.id));
    if (sent.reached && sent.code !== "laf:turn_in_progress") {
      setSendFailure("laf:turn_failed");
    }
  };

  /** Send a person's turn: what the composer sends, the compose screen's seed, a card's button. */
  const say = async (
    text: string,
    skillInstructions: string[] = [],
    attachments: AttachmentPart[] = [],
  ) => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    const present = new Set(thread.messages.map((message) => message.id));
    const kept = readUnsent(channel.id)
      .filter((message) => !present.has(message.id))
      .map(({ autoTried: _autoTried, ...message }) => message);
    const message = {
      id: crypto.randomUUID(),
      text: trimmed,
      instructions: skillInstructions,
      at: new Date().toISOString(),
      ...(attachments.length ? { attachments } : {}),
    };
    report(trimmed || attachments.map((part) => part.filename).join(", "));
    // The person is at the bottom, reading the newest: what is held past three pages can go.
    store.compact(true);
    await handOver([...kept, message], null);
  };
  const sayNow = useEffectEvent(
    (text: string, instructions?: string[], attachments?: AttachmentPart[]) =>
      say(text, instructions, attachments),
  );

  /** Send again what this device kept because the server never got it. */
  const resend = async (automatic: boolean) => {
    if (busy) return;
    const messages = automatic
      ? claimAutoSend(channel.id)
      : [...readUnsent(channel.id)];
    if (messages.length === 0) return;
    if (automatic) noteResent(messages.map((message) => message.id));
    await handOver(
      messages.map(({ autoTried: _autoTried, ...message }) => message),
      null,
    );
  };
  const resendNow = useEffectEvent((automatic: boolean) => resend(automatic));

  /**
   * 다시 시도 under a failed question: run the thread again with the question where it is, under the
   * id the server already holds — or, where the Bot had answered part of it, ask it again.
   */
  const retry = async ({ id, text }: RetriedMessage) => {
    if (readUnsent(channel.id).some((message) => message.id === id)) {
      await resend(false);
      return;
    }
    const way = retryWay(thread.messages, id);
    if (way === null) return;
    if (way === "ask-again") {
      const skill = LEADING_SKILL.exec(text)?.[1];
      const prompt = skillCommands.find(
        (command) => command.name === skill,
      )?.prompt;
      const asked = thread.messages.find((message) => message.id === id);
      await say(
        text,
        prompt ? [prompt] : [],
        attachmentPartsOf(asked?.content),
      );
      return;
    }
    const asked = thread.messages.find((message) => message.id === id);
    if (!asked) return;
    await handOver([], {
      id: asked.id,
      role: "user",
      content: (asked as { content?: unknown }).content,
    } as Message);
  };

  const handleStop = () => {
    void stopTurn(channel.threadId);
  };

  /*
   * THE TURN ENDED, HOWEVER IT ENDED: the stamps and failures are read again, today's meter moves,
   * and the room is marked read again — a reply that landed while the person watched is newer than
   * the mark the room opened with.
   */
  /*
   * On the fall from going to not, whatever it fell to: an ending frame, or a server that came back
   * from a restart knowing no turn at all — whose ending is in the ledger's record, not in a frame.
   */
  const [wasGoing, setWasGoing] = useState(false);
  useEffect(() => {
    if (going) {
      if (!wasGoing) setWasGoing(true);
      return;
    }
    if (!wasGoing) return;
    setWasGoing(false);
    void storedTimes.refetch();
    void storedFailures.refetch();
    refreshTodayUsage(queryClient);
    void markRead();
  }, [going, wasGoing, storedTimes, storedFailures, queryClient]);

  /*
   * WHAT A TOOL CHANGED ELSEWHERE ON SCREEN. The window's handlers used to refresh these as they
   * ran; the server runs them now, so the result frame is the news.
   */
  const refreshAfter = useEffectEvent((frame: TurnFrame) => {
    if (frame.kind !== "event" || frame.event.type !== "TOOL_CALL_RESULT")
      return;
    const toolCallId = String(frame.event.toolCallId ?? "");
    const name = store
      .snapshot()
      .messages.flatMap((message) =>
        message.role === "assistant" ? (message.toolCalls ?? []) : [],
      )
      .find((call) => call.id === toolCallId)?.function.name;
    if (name === UPDATE_PROFILE.name) {
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
    } else if (name === MANAGE_ROUTINE.name) {
      void queryClient.invalidateQueries({ queryKey: routineKeys.all });
    } else if (name === REMEMBER.name) {
      void queryClient.invalidateQueries({
        queryKey: agentKeys.memories(runtimeAgentId),
      });
      void queryClient.invalidateQueries({ queryKey: authKeys.currentUser() });
    }
  });
  useEffect(() => store.onFrame((frame) => refreshAfter(frame)), [store]);

  // The questions the turn waits on, on the lines of the calls that raised them, in every window.
  useEffect(() => {
    const watcher = watchServerQuestions({
      botId: runtimeAgentId,
      threadId: channel.threadId,
      going: () => isTurnGoing(store.snapshot().turn),
    });
    const unwatch = store.onFrame((frame) => {
      if (frame.kind === "turn" || frame.kind === "waiting") watcher.look();
    });
    return () => {
      unwatch();
      watcher.dispose();
    };
  }, [store, runtimeAgentId, channel.threadId]);

  // `모두 멈추기` reaches the turn on the server; this is the window's half, for the sidebar's count.
  useEffect(
    () =>
      holdChat({
        threadId: channel.threadId,
        busy: () => isTurnGoing(store.snapshot().turn),
        stop: () => {
          void stopTurn(channel.threadId);
        },
      }),
    [store, channel.threadId],
  );

  /*
   * THE CONNECTION CAME BACK: the stream is reopened from its cursor, and what was kept goes, once,
   * by itself. A window that slept may hold a socket that looks alive and hears nothing.
   */
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onBack = () => {
      store.nudge();
      if (readUnsent(channel.id).length > 0) void resendNow(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && Date.now() - hiddenAt > REOPEN_AFTER_HIDDEN_MS) {
        store.nudge();
      }
      hiddenAt = null;
    };
    socketState.addEventListener(SOCKET_RECONNECTED, onBack);
    window.addEventListener("online", onBack);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      socketState.removeEventListener(SOCKET_RECONNECTED, onBack);
      window.removeEventListener("online", onBack);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [store, channel.id]);

  // Kept words from before a reload go once the page is in, if the connection is there to take them.
  const loaded = thread.loaded;
  useEffect(() => {
    if (!loaded || isSocketLost() || navigator.onLine === false) return;
    if (readUnsent(channel.id).some((message) => !message.autoTried)) {
      void resendNow(true);
    }
  }, [loaded, channel.id]);

  // A turn that ends frees the conversation for what another window's turn kept waiting.
  useEffect(() => {
    if (going || sending > 0 || !loaded) return;
    if (readUnsent(channel.id).some((message) => !message.autoTried)) {
      void resendNow(true);
    }
  }, [going, sending, loaded, channel.id]);

  // The compose screen's first message, sent once.
  const seedSent = useRef(false);
  useEffect(() => {
    if (!seed || seedSent.current) return;
    seedSent.current = true;
    void sayNow(typeof seed.content === "string" ? seed.content : "");
  }, [seed]);

  // A first message started for this conversation while it is already on screen (a sidebar chip).
  useEffect(
    () =>
      hearFirstMessages(channel.id, (text) => {
        void sayNow(text);
      }),
    [channel.id],
  );

  const stored = storedTimes.data?.times;
  const messageTimes = useMemo(() => {
    const kept = Object.fromEntries(
      unsent.map((message) => [message.id, message.at]),
    );
    const any =
      Object.keys(sentAt).length > 0 ||
      unsent.length > 0 ||
      Object.keys(thread.times).length > 0;
    return any
      ? { ...kept, ...sentAt, ...thread.times, ...(stored ?? {}) }
      : (stored ?? EMPTY_TIMES);
  }, [sentAt, stored, unsent, thread.times]);

  const failuresById = standingFailures(
    storedFailures.data,
    thread.messages,
    storedTimes.data ? messageTimes : undefined,
  );

  const inThread = new Set(thread.messages.map((message) => message.id));
  const drawn = [
    ...transcriptMessages(thread.messages, seed),
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

  const openTask = useBrowsingTasks({
    channelId: channel.id,
    botId: runtimeAgentId,
    messages: drawn,
    busy,
  });
  usePublishTurn(runtimeAgentId, turnPhaseOf(drawn, busy));

  /*
   * What ended the turn, in a word the transcript owns: the Bot's stream said why, and it is read
   * the way the window read the RUN_ERROR it used to receive itself.
   */
  const answerStarted = (() => {
    for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
      const message = thread.messages[index];
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
  })();
  const runError =
    sendFailure ??
    (thread.turn?.status === "error"
      ? liveTurnFailureCode(thread.turn.code ?? thread.failure, {
          connectionLost: isSocketLost(),
          answerStarted,
        })
      : null);

  const lastAskedAt = thread.messages.findLastIndex(
    (message) => message.role === "user",
  );
  const taskStop = taskStopOf(thread.messages, {
    failed:
      runError !== null ||
      Object.keys(failuresById).some((id) => {
        const at = thread.messages.findIndex((message) => message.id === id);
        return at >= 0 && at >= lastAskedAt;
      }),
  });

  const answers = useMemo(
    () => ({
      waiting: new Set(thread.waiting),
      answer: async (toolCallId: string, value: unknown) => {
        await answerCard(channel.threadId, toolCallId, value);
      },
    }),
    [thread.waiting, channel.threadId],
  );

  return (
    <ConversationProvider
      ask={(text: string) => {
        void sayNow(text);
      }}
    >
      <ServerAnswersProvider value={answers}>
        {/* The composer below takes a sentence offered to this conversation (`?draft=`), and no other. */}
        <DraftScope.Provider value={channel.id}>
          <ConversationView
            banner={
              <BrowsingBanner
                asked={openTask?.asked}
                botId={runtimeAgentId}
                isStoppable={going}
                onStop={handleStop}
              />
            }
            busy={busy}
            channelId={channel.id}
            commands={skillCommands}
            disabled={!channel.active}
            messageTimes={messageTimes}
            {...(readWindow ? { readWindow } : {})}
            messages={drawn}
            notice={
              channel.active ? (
                <CarryOnNotice
                  busy={busy}
                  checked={thread.loaded}
                  onCarryOn={() => {
                    void say(
                      t("Please carry on with the task you were doing."),
                    );
                  }}
                  stop={taskStop}
                />
              ) : (
                <p className="pb-2 text-sm text-muted-foreground" role="status">
                  {t(
                    "This Bot has been deleted. The conversation stays readable, but it can no longer reply.",
                  )}
                </p>
              )
            }
            attach={
              deployment?.attachments && channel.active
                ? { channelId: channel.id, images: deployment.images === true }
                : undefined
            }
            onSubmit={async (draft) => {
              const skillInstructions = draft.commandIds
                .map(
                  (id) =>
                    skillCommands.find((command) => command.id === id)?.prompt,
                )
                .filter((instruction): instruction is string =>
                  Boolean(instruction),
                );
              await say(draft.text, skillInstructions, draft.attachments ?? []);
            }}
            onStop={handleStop}
            placeholder={
              botName ? t("Ask {name}", { name: botName }) : undefined
            }
            pending={busy}
            queueWhileBusy
            stoppable={going}
            stoppedCode={runError ?? undefined}
            noticeCode={thread.notice ?? undefined}
            failures={failuresById}
            onRetry={(message) => {
              setSendFailure(null);
              store.clearEnding();
              void retry(message);
            }}
            older={{
              has: thread.hasOlder,
              loading: thread.loadingOlder,
              onLoad: () => {
                void store.loadOlder();
              },
            }}
          />
        </DraftScope.Provider>
      </ServerAnswersProvider>
    </ConversationProvider>
  );
}
