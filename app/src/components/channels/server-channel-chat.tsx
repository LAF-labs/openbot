import type { Message, Tool } from "@ag-ui/core";
import { Greeting } from "@/components/agents/greeting";
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
import {
  type ComposerDraft,
  LEADING_SKILL,
} from "@/components/channels/composer/draft";
import {
  claimAutoSend,
  forgetUnsent,
  handToPerson,
  isKeptForCard,
  isWaitingForBot,
  keepUnsent,
  noteResent,
  readSendable,
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
import { ReadNotice } from "@/components/layout/read-states";
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
import { taskStopOf } from "@/lib/copilot/stranded-steps";
import { useToolsSettled } from "@/lib/copilot/tools-settled";
import { t } from "@/lib/i18n";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import type { ReadLine } from "@/lib/read-line";
import { routineKeys } from "@/lib/routines/queries";
import { ServerAnswersProvider } from "@/lib/turns/answers";
import {
  type AnswerDelivery,
  answerCard,
  type HistoryPage,
  readHistory,
  sendTurn,
  stopTurn,
} from "@/lib/turns/client";
import { isTurnGoing, isTurnQueued, type TurnFrame } from "@/lib/turns/frames";
import { watchServerQuestions } from "@/lib/turns/questions";
import { holdThread, releaseThread, threadFor } from "@/lib/turns/kept-threads";
import {
  answeredInWords,
  askerOf,
  hasResult,
  holdsCall,
  isShownOnCard,
  type Offer,
  openChoiceCall,
  restAfter,
  typedAnswer,
} from "@/lib/turns/typed-answer";
import { refreshTodayUsage } from "@/lib/usage/today";
import { useLasting } from "@/lib/use-lasting";
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
 * How long a turn stays `queued` before the transcript says it is waiting for the Bot.
 *
 * Every turn is queued for a moment: the engine announces it on accepting the turn and `running`
 * once it has the Bot and its thread (`server/src/turns/engine.ts`), which with the Bot free is a
 * few milliseconds. Two seconds is the line the thinking counter already keeps (`Thinking`): what
 * is over sooner than that is not worth a word, and a routine in front of a turn takes far longer.
 */
const QUEUED_SAID_AFTER_MS = 2000;

/** Words the card itself is showing, and so not drawn as waiting for the turn (`isShownOnCard`). */
function isOnCard(
  message: UnsentMessage,
  offers: ReadonlyMap<string, Offer>,
): boolean {
  return isKeptForCard(message) && isShownOnCard(offers.get(message.id));
}

/** The question words were kept for: the call's id, and the message that asked it. */
function questionOf(message: UnsentMessage): string {
  return `${message.answerTo ?? ""} ${message.askedBy ?? ""}`;
}

/**
 * WORDS KEPT FOR AN EARLIER QUESTION UNDER THE SAME ID: the conversation's newest call under the
 * id they were kept for is another message's than the one that asked them (`askedBy`).
 *
 * A provider's ids are its own to mint. Kept by the id alone, words typed for a question whose
 * turn died — the server stopped holding it — were, on the next question to carry that id,
 * offered to it as its answer, drawn on its card, and taken away by whatever was typed for it
 * (review, eighth round). Such words are no card's: their own question is over, however that
 * id stands now.
 */
function isForEarlier(
  message: UnsentMessage,
  messages: readonly Message[],
): boolean {
  if (!message.answerTo || !message.askedBy) return false;
  const newest = askerOf(messages, message.answerTo);
  return newest !== undefined && newest !== message.askedBy;
}

/**
 * A page of the record, read until it is in — on the waits an offer rests for — or until nobody is
 * there to hear it (`isGone`), which is the only way it comes back with nothing.
 *
 * Out here because it loops: the compiler leaves a component with such a loop in it uncompiled.
 */
async function readPage(
  threadId: string,
  before: number | null,
  isGone: () => boolean,
): Promise<HistoryPage | null> {
  for (let tries = 1; ; tries += 1) {
    const page = await readHistory(threadId, before);
    if (isGone()) return null;
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, restAfter(tries)));
    if (isGone()) return null;
  }
}

/**
 * THE RECORD AS FAR BACK AS A QUESTION, oldest first: the newest page, and then the page above it,
 * one at a time, until one holds the question itself — the Bot's call — or nothing is above.
 *
 * THE NEWEST PAGE IS NOT THE RECORD. It is eighty messages (`server/src/turns/history.ts`), and a
 * conversation goes on without this window: turns from another device, a routine delivering every
 * morning. A window that slept through more than a page of that read the newest one, found
 * nothing of its question there, and took that for a record that says nothing — words the server
 * had taken were handed to the person as not sent, with the press that sends them a second time
 * (review, seventh round).
 *
 * AS FAR AS THE QUESTION, AND NO FURTHER: a result is filed after its call, always, so once the
 * call has been read, so has everything the record says of what became of it (`holdsCall`). That
 * is not far, as a rule — the question was on this screen when the words were typed. A record that
 * never got the call at all is read to its start, once, and only then says nothing.
 *
 * Each page is what lies below the cursor of the one before, so none overlaps another; and a
 * cursor that does not move back is nothing older, whatever the page says of itself — it is not
 * asked from twice.
 */
async function readRecord(
  threadId: string,
  asked: { call: string; in?: string },
  isGone: () => boolean,
): Promise<Message[] | null> {
  let record: Message[] = [];
  let before: number | null = null;
  for (;;) {
    const page = await readPage(threadId, before, isGone);
    if (!page) return null;
    record = [...page.messages, ...record];
    if (holdsCall(page.messages, asked.call, asked.in)) return record;
    const above = page.oldestSeq;
    if (!page.hasOlder || above === null) return record;
    if (before !== null && above >= before) return record;
    before = above;
  }
}

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

  /*
   * The conversation's store, which outlives this screen for a while (`kept-threads.ts`): somebody
   * coming back from another place is handed the one they left, with what it holds.
   */
  const [store] = useState(() => threadFor(channel.threadId));
  const thread = useSyncExternalStore(store.subscribe, store.snapshot);
  /** The conversation was already here when this screen mounted: they came back to it. */
  const [isResumed] = useState(() => store.snapshot().loaded);
  const going = isTurnGoing(thread.turn);
  /*
   * THE TURN IS WAITING FOR THE BOT, AND HAS BEEN FOR A WHILE: a routine has it, and the turn runs
   * when the routine is done. Keyed on the turn, so the next turn starts its own wait, and false
   * the moment the turn is told it runs — however many times in a turn that happens.
   */
  const waitingForBot = useLasting(
    isTurnQueued(thread.turn) ? (thread.turn?.id ?? null) : null,
    QUEUED_SAID_AFTER_MS,
  );

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

  // The newest page and the live stream, together — opened on the first look, kept for a while
  // after this screen leaves, and woken on coming back.
  useEffect(() => {
    holdThread(channel.threadId, undefined, store);
    return () => releaseThread(channel.threadId, undefined, store);
  }, [channel.threadId, store]);

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

  /**
   * What this device kept: words the server never got, drawn in the thread until it does, and
   * words typed while the Bot worked, drawn under it as waiting until the turn is over.
   */
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

  /** Whether the grants are in, readable from a send that started before they were. */
  const settled = useRef(toolsSettled);
  useEffect(() => {
    settled.current = toolsSettled;
  }, [toolsSettled]);

  /** The tools this window would have offered the Bot, for the turn to offer the same. */
  const declaredTools = async (): Promise<Tool[] | null> => {
    const deadline = Date.now() + SEND_WITHOUT_GRANTS_AFTER_MS;
    while (!settled.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
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
    /*
     * The same skill asked for twice in one hand-over is one instruction: said again, it puts the
     * same paragraph in front of the Bot twice and tells it nothing new. The queue did this when it
     * joined what was parked into one message (`joinQueued`); parked messages go as themselves
     * now, so it is done here.
     */
    const given = new Set<string>();
    const firstTime = (instruction: string) => {
      if (given.has(instruction)) return false;
      given.add(instruction);
      return true;
    };
    const messages: Message[] = retrying
      ? [retrying]
      : outgoing.flatMap((message) => [
          ...message.instructions.filter(firstTime).map(
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
      // The server has them: the store is told, since a stream that has gone quiet says nothing.
      store.sent(drawn.map((message) => message.id));
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
     *
     * What was waiting for the Bot and went along with a new send (`say`) goes on waiting only when
     * the server said a turn is going — it is still behind that turn. Refused any other way, it was
     * tried and did not leave: an unsent message like any other. Left marked, it would be drawn as
     * "보낼 예정" under no job at all.
     *
     * What the send-by-itself claimed arrives here with its mark already off (`resend`), so refused
     * for any reason it is "보내지 못함" and the next send is the person's. That includes another
     * window's turn getting in first at the instant this one's ended — where the queue in the mount
     * went once more by itself after that turn. Not done here: going again by itself needs to know
     * the other turn has been heard of, or it sends into the same refusal for as long as the stream
     * says nothing.
     */
    const isBehindATurn = sent.reached && sent.code === "laf:turn_in_progress";
    /*
     * THE SERVER WAS THERE AND SAID NO, and not because it is busy: nothing is coming back that
     * would make a send by itself worth anything, so the one it would get is marked spent and the
     * line under the message is "보내지 못함" with 다시 보내기 — no promise. It used to be kept as
     * though the connection had dropped AND reported as a turn that failed, which drew two lines
     * for one failure: that one, and "답을 받지 못했어요 [다시 시도]" where the answer would be,
     * about a message the Bot was never given, with a second button doing the same thing.
     */
    const isRefused = sent.reached && !isBehindATurn;
    for (const tried of outgoing) {
      const { waiting, ...message } = tried;
      keepUnsent(channel.id, {
        ...(waiting && isBehindATurn ? tried : message),
        ...(isRefused ? { autoTried: true } : {}),
      });
    }
    /*
     * AND WHAT WAS TYPED WHILE THIS SEND WAS ON ITS WAY is waiting behind a job that never started.
     * Left marked, it would say "보낼 예정 · 지금 일이 끝나면 전해요" under no job at all. It is an
     * unsent message like the one it follows, and goes with it, in the order they were typed.
     */
    if (!isBehindATurn) {
      for (const kept of readUnsent(channel.id)) {
        // Not words kept for a card: what becomes of those is said in one place (`answerInWords`).
        if (!kept.waiting || kept.answerTo) continue;
        const { waiting: _waiting, ...message } = kept;
        keepUnsent(channel.id, message);
      }
    }
    store.removeLocal(drawn.map((message) => message.id));
  };

  /** What the `/` skills a message was typed with tell the Bot, which goes in front of it. */
  const instructionsOf = (commandIds: readonly string[]) =>
    commandIds
      .map((id) => skillCommands.find((command) => command.id === id)?.prompt)
      .filter((instruction): instruction is string => Boolean(instruction));

  /** Send a person's turn: what the composer sends, the compose screen's seed, a card's button. */
  const say = async (
    text: string,
    skillInstructions: string[] = [],
    attachments: AttachmentPart[] = [],
  ) => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    const present = new Set(thread.messages.map((message) => message.id));
    // What the device kept goes ahead of it — except an answer not known to have been taken.
    const kept = readSendable(channel.id)
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

  /**
   * Typed while the Bot has the turn: kept on this device as waiting for the Bot (`outbox.ts`), and
   * drawn under the conversation as that. The send below takes it when the turn is over.
   *
   * It used to be parked in `ConversationView`'s state, which a reload emptied without a word —
   * and reloading, or closing the laptop, is what a turn the server owns is for (review,
   * 2026-10-02). Kept as it will be sent: its own id, and the instructions of its `/` skills
   * already read out, as a message that failed to leave is kept.
   */
  const park = (draft: ComposerDraft) => {
    keepUnsent(channel.id, {
      id: crypto.randomUUID(),
      text: draft.text.trim(),
      instructions: instructionsOf(draft.commandIds),
      at: new Date().toISOString(),
      waiting: true,
      ...(draft.attachments?.length ? { attachments: draft.attachments } : {}),
    });
  };

  /**
   * TYPED WHILE THE BOT WAITS ON A CHOICE: the answer to it, not something to keep until the turn
   * is over — the turn is over when the question is answered (`lib/turns/typed-answer.ts`).
   *
   * Words alone, and typed here. A file or a skill is a message of its own, for after the turn, as
   * before; so is a sentence another screen sends for the person (`isOffered`).
   *
   * KEPT FIRST, THEN OFFERED TO THE CARD. The words are put in the outbox as anything typed
   * mid-turn is — waiting for the Bot — with the card they are for (`answerTo`), before the door is
   * asked: a page reloaded while the door is slow still has them. What becomes of them after that
   * is decided in ONE place, from the conversation as the stream has it (the effect below), and
   * nowhere else:
   *
   *  - the card shows them as its answer: they were delivered, and are forgotten;
   *  - it shows the question over some other way — another answer, its wait ran out, the turn
   *    stopped: they are words typed mid-turn like any other, and go when the turn is over;
   *  - the turn is over and nothing held says what became of the question: they are the person's
   *    to send, and nothing sends them by itself (`handToPerson`);
   *  - none of those yet: they wait, and are offered to the card again for as long as it waits —
   *    after a wait when the door did not take them, and at once when the connection returns.
   *
   * It was a row of its own kind with a press on it (보내지 못함 · 다시 보내기), taught to one reader of
   * the outbox at a time: the resend, the next message, the screen that drives its own turns — and
   * each press decided from what its window happened to hold. Three rounds of review and a second
   * read found a reader each time.
   */
  const openChoice = openChoiceCall(thread.messages, thread.waiting);
  /**
   * WHERE EACH OFFER TO A CARD STANDS, by the id of the words kept for it (`Offer`). Nothing here
   * for words not offered since this screen opened.
   *
   * ONE MAP, AND ONE WAIT A ROW. It was three sets and a count kept beside them: what was out, what
   * was taken, what was not due yet, and how often each had been tried. Read together they left
   * windows a second read walked through (2026-10-03): a row left the list of waiting words on
   * every offer and came back when it failed, so each retry blinked it and pulled the transcript
   * to the end; a refusal was never offered again though its card still waited; a connection that
   * came back started a second chain of retries beside the wait already running; and an offer
   * that answered after the screen had gone started a wait nothing would ever call off.
   */
  const [offers, setOffers] = useState<ReadonlyMap<string, Offer>>(new Map());
  const putOffer = (id: string, offer: Offer) =>
    setOffers((held) => new Map(held).set(id, offer));
  /** The waits of resting offers, by row — and whether the screen is gone, so none starts after it. */
  const rests = useRef({
    timers: new Map<string, ReturnType<typeof setTimeout>>(),
    /**
     * THE LATEST OFFER TO EACH QUESTION, as whether it gave the card its answer (`questionOf`).
     * Each offer waits for the one before it: one request at the door at a time for a question.
     */
    flights: new Map<string, Promise<boolean>>(),
    isGone: false,
  });
  useEffect(() => {
    const held = rests.current;
    held.isGone = false;
    return () => {
      held.isGone = true;
      for (const timer of held.timers.values()) clearTimeout(timer);
      held.timers.clear();
    };
  }, []);
  /** These words are still kept for their card: not forgotten, nor replaced, nor let go of it. */
  const isStillForCard = (message: UnsentMessage) =>
    readUnsent(channel.id).some(
      (kept) => kept.id === message.id && kept.answerTo !== undefined,
    );
  /*
   * ONE REQUEST AT THE DOOR AT A TIME FOR A QUESTION, AND THE LATEST WORDS LAST. Two answers out
   * together race, and the server takes whichever reaches it first: a correction typed while the
   * first was out could lose to it, and then went after the turn as a message of its own (review,
   * tenth round). Waiting only on the first, a third went out beside the first while the second
   * waited — and the second, replaced meanwhile, was still offered when the first came back
   * (eleventh round). So every offer to a question waits for the one before it (`flights`), and
   * is made only if its words are still the ones kept for the card. Where an earlier one gave the
   * card its answer, nothing can take that back: these are what the person says next (`answered`),
   * and the settling lets go of the mark — sending them at once where the turn is already over,
   * which the turn's own end, heard before this, did not (eleventh round).
   */
  const offer = async (message: UnsentMessage, tries: number) => {
    const call = message.answerTo;
    if (!call) return;
    const { flights } = rests.current;
    const question = questionOf(message);
    const before = flights.get(question);
    const flight = (async (): Promise<{
      delivery: AnswerDelivery | "replaced" | "answered";
      isAnswered: boolean;
    }> => {
      const isAnswered = before ? await before : false;
      if (!isStillForCard(message)) return { delivery: "replaced", isAnswered };
      if (isAnswered) return { delivery: "answered", isAnswered };
      const delivery = await answerCard(
        channel.threadId,
        call,
        typedAnswer(message.text),
      );
      return { delivery, isAnswered: delivery === "taken" };
    })();
    flights.set(
      question,
      flight.then((offered) => offered.isAnswered),
    );
    const { delivery } = await flight;
    const { timers, isGone } = rests.current;
    if (isGone || delivery === "replaced") return;
    if (delivery === "answered") {
      putOffer(message.id, { at: "answered", tries });
      return;
    }
    // Taken: the conversation is about to show them as the card's answer, which is what forgets
    // them — and if the turn is stopped before that is filed, they are still here to go.
    if (delivery === "taken") {
      putOffer(message.id, { at: "taken", tries });
      return;
    }
    /*
     * Not taken, or nothing back: offered again after a wait, for as long as the card goes on
     * waiting. A REFUSAL TOO. The stream names the card as waiting and the door says otherwise:
     * either the stream is about to say so, and the settling below then stops asking, or the door
     * refused for a reason of its own that may not last — and words left unoffered there sat
     * under the card until its question ran out.
     */
    const tried = tries + 1;
    putOffer(message.id, { at: "resting", tries: tried });
    clearTimeout(timers.get(message.id));
    timers.set(
      message.id,
      setTimeout(() => {
        timers.delete(message.id);
        setOffers((held) =>
          held.get(message.id)?.at === "resting"
            ? new Map(held).set(message.id, { at: "due", tries: tried })
            : held,
        );
      }, restAfter(tried)),
    );
  };
  const answerInWords = (draft: ComposerDraft) => {
    const words = draft.text.trim();
    const isWordsAlone =
      words !== "" &&
      draft.commandIds.length === 0 &&
      !draft.attachments?.length;
    if (!openChoice || !isWordsAlone || draft.isOffered) {
      park(draft);
      return;
    }
    // Which question: the message that asked, since an id can be another question's later.
    const askedBy = askerOf(thread.messages, openChoice);
    // One answer in words per card: a second one takes the first one's place — this card's
    // first, not words kept for an earlier question that carried the same id.
    const replaced = readUnsent(channel.id).filter(
      (kept) =>
        kept.answerTo === openChoice &&
        (kept.askedBy === undefined || kept.askedBy === askedBy),
    );
    forgetUnsent(
      channel.id,
      replaced.map((kept) => kept.id),
    );
    const message: UnsentMessage = {
      id: crypto.randomUUID(),
      text: words,
      instructions: [],
      at: new Date().toISOString(),
      autoTried: false,
      waiting: true,
      answerTo: openChoice,
      ...(askedBy ? { askedBy } : {}),
    };
    // Its offer first: nothing that reads the outbox finds these words without one. It waits
    // behind any offer to the same question still out (`offer`).
    putOffer(message.id, { at: "out", tries: 0 });
    keepUnsent(channel.id, message);
    void offer(message, 0);
  };
  const offerNow = useEffectEvent((message: UnsentMessage, tries: number) =>
    offer(message, tries),
  );
  /**
   * THE RECORD AS IT WAS READ FOR A QUESTION, by the id of the words kept for it — read once the
   * turn was over with nothing held saying what became of that question (the settling below).
   *
   * WHAT IS HELD CAN BE BEHIND THE RECORD. A window that slept, or whose server restarted, is told
   * how the turn stands before anything has read what it missed; and one that reconnects late is
   * replayed that the turn is over and none of what was said in it. For a moment "the turn is
   * over and nothing says what became of the question" is true of a question whose answer the
   * record holds: read off that, words the server had taken were handed to the person as not
   * sent, with the press that sends them a second time, until the page came and forgot them
   * (review, sixth round).
   *
   * So that is decided against the record as it was read for the question, and not before it has
   * been: as far back as the question itself (`readRecord`), read here and until it is in — a
   * read that fails says nothing either, and nor does the newest page alone. Not through the
   * store, whose own reading of the pages is its own business and on its own time.
   */
  const [records, setRecords] = useState<
    ReadonlyMap<string, readonly Message[]>
  >(new Map());
  /** The ones a read is out or waiting for, so the settling asks for one and not one a render. */
  const confirming = useRef(new Set<string>());
  const readRecordFor = useEffectEvent(async (message: UnsentMessage) => {
    const { id, answerTo: call } = message;
    if (!call || confirming.current.has(id)) return;
    confirming.current.add(id);
    const record = await readRecord(
      channel.threadId,
      { call, in: message.askedBy },
      () => rests.current.isGone,
    );
    confirming.current.delete(id);
    if (!record) return;
    setRecords((held) => new Map(held).set(id, record));
  });

  /**
   * Whether what this device kept may go by itself: the page is in, the stream has said how the
   * turn stands, and the conversation can still be answered.
   *
   * THE STREAM HAS TO HAVE SPOKEN. The page and the stream are opened together and either can
   * arrive first; with the page in and no snapshot yet, `going` is false only because nobody has
   * said otherwise. A correction left waiting by the last page load was sent then, into the turn it
   * was waiting behind, and refused (measured in `queued-message-kept.test.tsx`).
   *
   * AND NOT INTO A CONVERSATION WHOSE BOT IS GONE. The queue refused to drain while the composer
   * was disabled, for the same reason: the screen has already said the conversation can no longer
   * reply. What waits stays on screen, under that notice.
   */
  const mayGoByItself =
    thread.loaded && thread.epoch !== null && channel.active;

  /**
   * Send what this device kept: what was waiting for the Bot, for the first time, and what the
   * server never got, again. By itself once (`claimAutoSend`), or all of it on the person's press.
   */
  const resend = async (automatic: boolean) => {
    if (busy) return;
    if (automatic) {
      /*
       * BY ITSELF ONLY ON WHAT THE STORE SAYS NOW, not on what this render saw. A screen that has
       * just come back to a kept conversation resumes its store in an effect of the same commit
       * (`kept-threads.ts`): the render saw the old "the stream has spoken, and no turn is going",
       * and what the device kept went into a turn another window had started while this one's
       * stream was dead — its one send by itself, refused (review, 2026-10-02).
       */
      const now = store.snapshot();
      const hasSpoken = now.loaded && now.epoch !== null;
      if (!hasSpoken || !channel.active || isTurnGoing(now.turn)) return;
    }
    // Never words still kept for a card (`answerTo`): `readSendable`, and `claimAutoSend`.
    const messages = automatic
      ? claimAutoSend(channel.id)
      : [...readSendable(channel.id)];
    if (messages.length === 0) return;
    // "다시 연결돼서 보냈어요" is said of what had failed to leave, not of words going for the first time.
    if (automatic) {
      noteResent(
        messages
          .filter((message) => !message.waiting)
          .map((message) => message.id),
      );
    }
    // The person's line on the roster, when their words go: what a queue draining through `say` did.
    report(
      messages
        .filter(isWaitingForBot)
        .map(
          (message) =>
            message.text ||
            (message.attachments ?? []).map((part) => part.filename).join(", "),
        )
        .join("\n"),
    );
    await handOver(
      // Its mark comes off with the send: one that fails is not sent, not waiting (`handOver`).
      messages.map(
        ({ autoTried: _autoTried, waiting: _waiting, ...message }) => message,
      ),
      null,
    );
  };
  const resendNow = useEffectEvent((automatic: boolean) => resend(automatic));

  /*
   * WHAT BECOMES OF WORDS KEPT FOR A CARD — THE ONE PLACE THAT DECIDES (see `answerInWords`).
   *
   * From the conversation as the stream has it, and not before the stream has spoken: a page just
   * reloaded holds no turn and no result, and "no turn, no result" read off that is "over some
   * other way" about a question that is still being asked.
   */
  useEffect(() => {
    if (!thread.loaded || thread.epoch === null) return;
    let isFreed = false;
    const marked = new Set<string>();
    for (const message of unsent) {
      const call = message.answerTo;
      if (!call) continue;
      marked.add(message.id);
      const offer = offers.get(message.id);
      // The door is being asked: what it says comes first.
      if (offer?.at === "out") continue;
      // Another answer reached the card first: words like any other, said next (`offer`).
      if (offer?.at === "answered") {
        const { answerTo: _answerTo, askedBy: _askedBy, ...plain } = message;
        keepUnsent(channel.id, plain);
        isFreed = true;
        continue;
      }
      // The conversation as it is held — and the record as it was read for this question, where
      // it has been (`records`): either may be the one that shows what became of it.
      const record = records.get(message.id) ?? [];
      // For the call the asking message made, where the words were kept with it (`askedBy`).
      const asker = message.askedBy;
      const answered =
        answeredInWords(thread.messages, call, asker) ??
        answeredInWords(record, call, asker);
      // Their own words — or, where the door said it took them, whatever words the card shows.
      if (
        answered !== undefined &&
        (answered === message.text || offer?.at === "taken")
      ) {
        forgetUnsent(channel.id, [message.id]);
        continue;
      }
      // Over, and not with these words: words like any other the device kept.
      if (
        hasResult(thread.messages, call, asker) ||
        hasResult(record, call, asker)
      ) {
        const { answerTo: _answerTo, askedBy: _askedBy, ...plain } = message;
        keepUnsent(channel.id, plain);
        isFreed = true;
        continue;
      }
      // Its own question is over too where a later one carries its id (`isForEarlier`), whatever
      // the turn is doing: it is never that one's answer.
      if (!going || isForEarlier(message, thread.messages)) {
        /*
         * THE TURN IS OVER AND NOTHING HELD SAYS WHAT BECAME OF THE QUESTION. Every turn that
         * ends files a result for each of its calls and says so on the stream, so this is a window
         * that did not hear it: asleep while the turn finished, or opened long after — or a server
         * that died holding the question. The first of those is a window about to read the record
         * and find these words there as the card's answer; this used to take the mark off and send
         * them, and the Bot was told the same thing twice (adversarial read, 2026-10-03). So
         * nothing is sent by itself here. They are the person's, drawn as not sent with the press
         * that sends them, and forgotten above the moment the conversation shows them answered.
         */
        // Once the record has been read for it, and says nothing either (`records`): what is
        // held may be behind it, and the record may hold these words as the answer.
        if (records.has(message.id)) handToPerson(channel.id, message);
        else if (isKeptForCard(message)) void readRecordFor(message);
        continue;
      }
      // Still being asked, and these words are not known to have reached it: offered, unless an
      // offer is out, the door took them, or one it did not take is resting (`Offer`).
      if (
        isKeptForCard(message) &&
        thread.waiting.includes(call) &&
        (offer === undefined || offer.at === "due")
      ) {
        const tries = offer?.tries ?? 0;
        setOffers((held) =>
          new Map(held).set(message.id, { at: "out", tries }),
        );
        void offerNow(message, tries);
      }
    }
    // Where words are no longer marked for a card, how their offer stood is nothing's to read —
    // nor that the record was read for them.
    if ([...offers.keys()].some((id) => !marked.has(id))) {
      setOffers((held) => new Map([...held].filter(([id]) => marked.has(id))));
    }
    if ([...records.keys()].some((id) => !marked.has(id))) {
      setRecords((held) => new Map([...held].filter(([id]) => marked.has(id))));
    }
    // Words freed after their turn was already over have nothing left to send them but this.
    if (isFreed && !going) void resendNow(true);
  }, [
    unsent,
    thread.messages,
    thread.waiting,
    thread.loaded,
    thread.epoch,
    going,
    offers,
    records,
    channel.id,
  ]);

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
    // Anything that arrived beside the turn — a routine's delivery — is read in with it.
    void store.refresh();
    void storedTimes.refetch();
    void storedFailures.refetch();
    refreshTodayUsage(queryClient);
    void markRead();
  }, [going, wasGoing, store, storedTimes, storedFailures, queryClient]);

  /*
   * SOMETHING ELSE WROTE TO THE CONVERSATION — a routine delivering its answer while the
   * conversation sits open — and the roster's news of it is the only news. Read in now, or at the
   * end of the turn in flight (above), and read, because it is on the screen in front of them.
   */
  useEffect(() => {
    const onActivity = (event: Event) => {
      const activity = (event as CustomEvent<ChannelActivity>).detail;
      if (activity.channelId !== channel.id || !activity.lastMessageAgentId) {
        return;
      }
      if (isTurnGoing(store.snapshot().turn)) return;
      void store.refresh().then(() => markRead());
    };
    channelActivity.addEventListener(CHANNEL_ACTIVITY, onActivity);
    return () =>
      channelActivity.removeEventListener(CHANNEL_ACTIVITY, onActivity);
  }, [store, channel.id]);

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
      // And words resting after an offer the door did not take are due: it may be there again.
      setOffers((held) =>
        [...held.values()].some((offer) => offer.at === "resting")
          ? new Map(
              [...held].map(([id, offer]) => [
                id,
                offer.at === "resting"
                  ? { at: "due" as const, tries: offer.tries }
                  : offer,
              ]),
            )
          : held,
      );
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
  useEffect(() => {
    if (!mayGoByItself || isSocketLost() || navigator.onLine === false) return;
    if (readUnsent(channel.id).some((message) => !message.autoTried)) {
      void resendNow(true);
    }
  }, [mayGoByItself, channel.id]);
  /*
   * AND WHEN THE STREAM SAYS HOW THE TURN STANDS AGAIN — the answer a store that was resumed waits
   * for. The effect above runs when `mayGoByItself` changes, and for a screen that came back it may
   * never be seen to: the store forgets what it knew and is told again between two renders.
   */
  useEffect(
    () =>
      store.onFrame((frame) => {
        if (frame.kind !== "snapshot") return;
        if (isSocketLost() || navigator.onLine === false) return;
        if (readUnsent(channel.id).some((message) => !message.autoTried)) {
          void resendNow(true);
        }
      }),
    [store, channel.id],
  );

  /*
   * A TURN THAT ENDS FREES THE CONVERSATION for what was kept waiting behind it: the corrections
   * somebody typed while the Bot worked, and what another window's turn got in front of.
   *
   * ON THE TURN BEING OVER, HOWEVER IT ENDED — finished, failed or stopped all arrive as `going`
   * falling, so a correction parked and then Stop pressed is what runs next, with no stop path to
   * forget (`composer/queue.ts`).
   *
   * NOT ON WHAT IS KEPT CHANGING, though that would look safer. Another tab of this conversation
   * parks a correction while its own send is still on its way; this tab, which has heard of no
   * turn yet, would take the correction the moment it appeared and send it ahead of the message
   * it corrects. The composer parks only while it sees a turn in flight, and it sees that from the
   * same `going` and `sending` this reads, so the edge that frees the composer is the one that
   * sends what was parked.
   */
  /*
   * ON THE TURN ENDING, AND NOT ON A SEND ENDING. This used to run whenever nothing was going and
   * nothing was being sent, which is also the instant after a send FAILS. Measured on the running
   * app, 2026-10-02, with the server out of reach: one press of send made two hand-overs 47 ms
   * apart — the same server asked again in the same instant — and that second one was the kept
   * message's one send by itself. When the connection came back nothing went: the message sat
   * under "보내지 못함" until somebody pressed, and the line that says it will go by itself was
   * never drawn. So what frees the conversation is a turn that was going and is not: remembered
   * here until a send can go, since the turn can end while this window is still handing one over.
   */
  const turnWasGoing = useRef(going);
  const freedByTurn = useRef(false);
  useEffect(() => {
    if (turnWasGoing.current && !going) freedByTurn.current = true;
    turnWasGoing.current = going;
    if (!freedByTurn.current || going || sending > 0 || !mayGoByItself) return;
    freedByTurn.current = false;
    if (readUnsent(channel.id).some((message) => !message.autoTried)) {
      void resendNow(true);
    }
  }, [going, sending, mayGoByItself, channel.id]);

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
  const notInThread = unsent.filter((message) => !inThread.has(message.id));
  /*
   * WAITING FOR THE BOT IS NOT SAID YET. What was parked is drawn under the conversation as waiting
   * (`Queued`), never in it: a row in the conversation is the newest thing said, and the transcript
   * reads "생각 중", the half answer and 다시 시도 off whatever row is last.
   */
  const waitingForTurn = notInThread
    .filter(isWaitingForBot)
    // Words the card itself is showing are not "waiting for the turn" (`isOnCard`).
    .filter((message) => !isOnCard(message, offers));
  const drawn = [
    ...transcriptMessages(thread.messages, seed),
    ...notInThread
      .filter((message) => !isWaitingForBot(message))
      .map(
        (message): Message => ({
          content: message.text,
          id: message.id,
          role: "user",
        }),
      ),
  ];

  useBrowsingTasks({
    channelId: channel.id,
    botId: runtimeAgentId,
    messages: drawn,
    busy,
  });
  // Told only once the stream has said how the turn stands: before that, "idle" is "not heard yet".
  usePublishTurn(
    runtimeAgentId,
    turnPhaseOf(drawn, busy),
    thread.epoch !== null,
  );

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

  /** Which of the kept words were for an earlier question, as one value that seldom changes. */
  const earlier = unsent
    .filter((message) => isForEarlier(message, thread.messages))
    .map((message) => message.id)
    .join(" ");
  const answers = useMemo(
    () => ({
      waiting: new Set(thread.waiting),
      answer: async (toolCallId: string, value: unknown) => {
        await answerCard(channel.threadId, toolCallId, value);
      },
      // The words each card shows as its answer before the conversation does (`isOnCard`) —
      // its own, not words kept for an earlier question under the same id (`earlier`).
      inWords: new Map(
        unsent
          .filter(
            (message) =>
              isOnCard(message, offers) &&
              !earlier.split(" ").includes(message.id),
          )
          .map((message) => [message.answerTo ?? "", message.text]),
      ),
    }),
    [thread.waiting, channel.threadId, unsent, offers, earlier],
  );

  /*
   * THE CONVERSATION SO FAR COULD NOT BE READ, SAID WHERE IT WOULD HAVE BEEN. Nothing here used to
   * read `unreadable`: reopened right after the server restarted, the conversation was drawn empty
   * under the Bot's greeting, as though nothing had ever been said (review, 2026-10-02). The store
   * goes on reading it by itself (`thread-store.ts`); this says so meanwhile, with the press that
   * reads it now.
   */
  const historyLine: ReadLine = thread.unreadable
    ? {
        kind: "failed",
        message: t("Could not load this channel."),
        isRetrying: thread.rereading,
      }
    : null;

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
            head={
              <>
                {/* Mounted before it has anything to say, so the line is announced (`ReadNotice`). */}
                <ReadNotice
                  line={historyLine}
                  onRetry={() => {
                    void store.retry();
                  }}
                />
                {/*
                 * The Bot's greeting, at the top of the whole conversation (`greeting.tsx`) — and so
                 * not above one that could not be read, where it says the conversation starts here,
                 * and NOT BEFORE THE CONVERSATION HAS BEEN READ. Until the first page is in nothing
                 * is known to be above, and the greeting was drawn on every open of a conversation
                 * years long: hello again, for as long as the read took, then the history in its
                 * place (pressed 2026-10-02). A first message carried over from the compose screen
                 * is a conversation that starts here, and has its greeting at once.
                 */}
                {thread.loaded || seed ? (
                  <Greeting agentId={runtimeAgentId} mode="head" />
                ) : null}
              </>
            }
            banner={
              <BrowsingBanner
                botId={runtimeAgentId}
                isStoppable={going}
                onStop={handleStop}
              />
            }
            busy={busy}
            isResumed={isResumed}
            waitingForBot={waitingForBot}
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
              await say(
                draft.text,
                instructionsOf(draft.commandIds),
                draft.attachments ?? [],
              );
            }}
            onStop={handleStop}
            placeholder={
              botName ? t("Ask {name}", { name: botName }) : undefined
            }
            pending={busy}
            // Typed while the Bot works: kept on this device, not in the mount (`park`).
            parked={{
              messages: waitingForTurn,
              onPark: (draft) => {
                void answerInWords(draft);
              },
              onRemove: (id) => forgetUnsent(channel.id, [id]),
              isAnswering: openChoice !== null,
            }}
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
