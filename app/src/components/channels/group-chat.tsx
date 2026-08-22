import type { Message } from "@ag-ui/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toAgentOptions } from "@/components/channels/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import { RoomApprovals } from "@/components/channels/room-approvals";
import {
  seedMessage,
  takeFirstMessage,
  transcriptMessages,
} from "@/components/channels/transcript-messages";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { readApprovals } from "@/lib/approvals";
import { setChannelReadMutationOptions } from "@/lib/channels/mutations";
import {
  type AgentChannel,
  messageTimesQueryOptions,
} from "@/lib/channels/queries";
import {
  applyRoomFrame,
  EMPTY_ROOM,
  mergeApprovals,
  mergeStored,
  type RoomState,
  turnLost,
  withoutApproval,
} from "@/lib/channels/room-events";
import type { RoomFrame } from "@/lib/channels/room-frames";
import { normalizeStoredMessages } from "@/lib/channels/thread-history";
import {
  CHANNEL_ACTIVITY,
  type ChannelActivity,
  channelActivity,
  ROOM_FRAME,
  roomFrames,
  SOCKET_RECONNECTED,
  socketState,
} from "@/lib/channels/use-channel-events";
import { t } from "@/lib/i18n";

/**
 * A room with more than one Bot in it, watched rather than driven.
 *
 * The turn runs on the server: this screen posts what the person said and then listens. That is
 * the whole difference from `ChannelChat`, and it is why nothing from CopilotKit is imported here —
 * there is no agent to bind, no run to own, no proxy to re-point at whichever Bot was named. The
 * six defects that shape produced in one session (a swap that sent a message to the wrong Bot, a
 * blanked transcript, a resolver that never reset, a dropped delivery, a stale write, a note that
 * accumulated forever) have no mechanism to occur in.
 *
 * What the screen holds is plain state fed from two places: the thread as the server stores it,
 * and the frames the server sends while a turn runs. Both go through pure functions with their
 * own tests (`room-events.ts`), so what a frame does to the screen is decided in one place.
 */
/**
 * How long the room waits after a message lands before reading the thread again.
 *
 * Long enough that a turn's messages arrive as one burst rather than ten, short enough that a
 * message from somewhere else — another tab, a routine — still appears promptly.
 */
const ACTIVITY_SETTLE_MS = 700;

export function GroupChat({ channel }: { channel: AgentChannel }) {
  const queryClient = useQueryClient();
  const { data: agentProfiles } = useQuery(agentListQueryOptions());
  /*
   * Answering is the owner's alone — `POST /api/approvals/:botId/:approvalId` is admin-only, and
   * deliberately so. Drawn for everybody, the card gave every other member of the room two buttons
   * that could only ever fail, on a question they cannot do anything about.
   */
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const mayAnswer = currentUser?.role === "admin";
  /** Stable across renders, so the effects below do not restart on every parent render. */
  const memberIdsKey = channel.agentIds.join(",");
  const memberIds = useMemo(
    () => (memberIdsKey ? memberIdsKey.split(",") : []),
    [memberIdsKey],
  );
  const memberNames = useMemo(
    () => new Map((agentProfiles ?? []).map((agent) => [agent.id, agent.name])),
    [agentProfiles],
  );
  const marks = useQuery(messageTimesQueryOptions(channel.id));
  const [room, setRoom] = useState<RoomState>(EMPTY_ROOM);
  const [posting, setPosting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Something worth saying that is not a fault — a turn where nobody had anything to add. */
  const [quiet, setQuiet] = useState<string | null>(null);

  /**
   * First-message seed from the compose screen, taken once per mount and shown until the stored
   * thread arrives — a new room joins with an empty screen otherwise.
   */
  const [seed] = useState<Message | null>(() => {
    const pending = takeFirstMessage(channel.id);
    return pending ? seedMessage(pending, crypto.randomUUID()) : null;
  });
  const seedSent = useRef(false);

  /*
   * OPENING A ROOM MARKS IT READ, AND HANDS BACK WHERE THE READING STOPPED.
   *
   * Carried from `ChannelChat` verbatim, guard included: the call reports the mark it replaced, so
   * it is not idempotent, and React runs mount effects twice in development. The second call would
   * answer with the timestamp the first had just written, and the "unread from here" line would
   * have nothing newer than itself to sit above. A ref survives the simulated unmount and is fresh
   * on a real one, because this component is keyed on the channel.
   */
  const setRead = useMutation(setChannelReadMutationOptions(queryClient));
  const markRead = useRef(setRead.mutateAsync);
  markRead.current = setRead.mutateAsync;
  const [readWindow, setReadWindow] = useState<{
    from: string;
    until: string;
  } | null>(null);
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

  /**
   * Fetch the thread and fold it in, keeping whatever is still being typed.
   *
   * `/api/channels/:id/messages`, not the runtime's thread endpoint: that one is answered by our
   * runner only in local mode, and every message in a room is written by the server.
   */
  const catchUp = useCallback(async () => {
    const response = await fetch(
      `/api/channels/${encodeURIComponent(channel.id)}/messages`,
      { credentials: "include" },
    );
    if (!response.ok) return;
    const body = (await response.json().catch(() => null)) as {
      messages?: unknown;
    } | null;
    const stored = normalizeStoredMessages(body?.messages);
    /*
     * FORCED, because the query is pinned `staleTime: Infinity` — a message's stamp and speaker
     * never change once written, so the solo room never needs to ask twice. A room does: every
     * member's reply is a NEW message with a new speaker, and `fetchQuery` against an infinite
     * stale time hands back the map from page load. Measured: five replies landed with the server
     * holding all five speakers, and every bubble drew without a name.
     */
    const fresh = await queryClient.fetchQuery({
      ...messageTimesQueryOptions(channel.id),
      staleTime: 0,
    });
    setRoom((state) =>
      mergeStored(state, stored, {
        speakers: fresh.speakers,
        times: fresh.times,
      }),
    );
  }, [channel.id, queryClient]);
  /**
   * The questions this room's members are waiting on, asked for rather than waited for.
   *
   * A `room.approval` frame only reaches a room that is on screen, on the instance running the
   * turn. Somebody who opened the room after a member stopped at a boundary, or reloaded, or is
   * connected to a different server, has no frame to have missed — so the open set is read on mount
   * and while a turn is in flight. Authoritative: it also takes down a card whose question expired.
   *
   * Nothing is reconciled unless every member answered, because a partial read would take down
   * cards for the members whose request happened to fail.
   */
  const catchUpApprovals = useCallback(async () => {
    const ids = memberIds.length > 0 ? memberIds : [];
    if (ids.length === 0) return;
    const lists = await Promise.all(ids.map((id) => readApprovals(id)));
    if (lists.some((list) => list === null)) return;
    const open = lists.flatMap((list, at) =>
      (list ?? [])
        .filter((approval) => approval.granted === undefined)
        .map((approval) => ({
          approvalId: approval.id,
          memberId: ids[at] ?? approval.botId,
          // Never the raw id: "a4f1c… is waiting for your answer" tells a person nothing.
          memberName: memberNames.get(ids[at] ?? "") ?? t("A coworker"),
          question: approval.question,
          rule: approval.rule,
        })),
    );
    setRoom((state) => mergeApprovals(state, open));
  }, [memberIds, memberNames]);
  const catchUpApprovalsRef = useRef(catchUpApprovals);
  catchUpApprovalsRef.current = catchUpApprovals;

  const catchUpRef = useRef(catchUp);
  catchUpRef.current = catchUp;

  useEffect(() => {
    void catchUpRef.current();
  }, []);

  // On the callback itself, not through the ref: it changes exactly when the members or their names
  // do, which is exactly when the open set has to be read again.
  useEffect(() => {
    void catchUpApprovals();
  }, [catchUpApprovals]);

  /*
   * Two listeners on the one socket. Frames are the turn as it runs; activity is a message that
   * LANDED, which is how a settled copy replaces a provisional one. Activity for this room from a
   * Bot triggers a catch-up, and the room is marked read again because it is on screen.
   */
  useEffect(() => {
    const onFrame = (event: Event) => {
      const frame = (event as CustomEvent<RoomFrame>).detail;
      setRoom((state) => applyRoomFrame(state, frame, channel.id));
      /*
       * A member that could not take its turn at all is not a member with nothing to say, and on
       * screen those are the same thing: nothing appears. Said plainly, once, when the turn ends.
       */
      if (frame.kind === "room.done" && frame.channelId === channel.id) {
        if ((frame.failures ?? 0) > 0) {
          setNotice(
            t("{count} of the coworkers could not answer this time.", {
              count: String(frame.failures ?? 0),
            }),
          );
          return;
        }
        /*
         * A turn where every member chose silence looked exactly like a turn that never happened:
         * the person asked, the room thought, and then nothing — no message, no explanation. Said
         * quietly rather than as a fault, because silence is a first-class answer here.
         */
        if (frame.posted === 0) {
          setQuiet(t("Nobody had anything to add this time."));
        }
      }
    };
    /*
     * COLLAPSED, because a turn arrives as a burst. Every message a member posts raises an activity
     * event, and answering each one meant a transcript fetch, a message-times fetch and a read POST
     * — four requests per reply, up to ten replies a turn, all of them asking for a thread the
     * frames had already delivered. The settled frame is what puts the message on screen; this is
     * the safety net behind it, and a net does not need to be cast forty times.
     */
    let pending: ReturnType<typeof setTimeout> | undefined;
    const onActivity = (event: Event) => {
      const activity = (event as CustomEvent<ChannelActivity>).detail;
      if (activity.channelId !== channel.id) return;
      /*
       * A person's own message is announced with no Bot on it, and skipping those meant a SECOND
       * view of the same room — another window, or the desktop shell beside a browser tab — went
       * busy on `room.turn` without ever fetching the message that started the turn, and watched
       * members answer a question that was not on its screen. The catch-up below is debounced, so
       * answering these too costs one request per burst.
       */
      clearTimeout(pending);
      pending = setTimeout(() => {
        void catchUpRef.current();
        void markRead
          .current({ channelId: channel.id, read: true })
          .catch(() => {});
      }, ACTIVITY_SETTLE_MS);
    };
    const onReconnected = () => {
      // Whatever happened while the socket was away is not replayed, so the turn is let go and the
      // thread and the open questions are read again. A turn that really is still running says so
      // with its next frame.
      setRoom(turnLost);
      void catchUpRef.current();
      void catchUpApprovalsRef.current();
    };
    roomFrames.addEventListener(ROOM_FRAME, onFrame);
    channelActivity.addEventListener(CHANNEL_ACTIVITY, onActivity);
    socketState.addEventListener(SOCKET_RECONNECTED, onReconnected);
    return () => {
      clearTimeout(pending);
      roomFrames.removeEventListener(ROOM_FRAME, onFrame);
      channelActivity.removeEventListener(CHANNEL_ACTIVITY, onActivity);
      socketState.removeEventListener(SOCKET_RECONNECTED, onReconnected);
    };
  }, [channel.id]);

  const post = useCallback(
    async (text: string, addressedAgentIds: string[]) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setNotice(null);
      setQuiet(null);
      setPosting(true);
      try {
        const messageId = crypto.randomUUID();
        // On screen at once, under the id the server will store it as, so catch-up keeps it.
        setRoom((state) => ({
          ...state,
          messages: [
            ...state.messages,
            { id: messageId, role: "user", content: trimmed, pending: true },
          ],
        }));
        /*
         * A network failure is caught HERE and not left to throw. Thrown, the composer would put
         * the draft back in the box while the optimistic bubble stayed on screen with nothing
         * saying why — and from the seed effect it would be an unhandled rejection. And the 202
         * may have been lost AFTER the server stored the message: that is why the bubble is kept
         * under the server's id on a network error and catch-up is asked — if the message is
         * there, it stays; if not, the notice says to try again.
         */
        let response: Response | null = null;
        try {
          response = await fetch(
            `/api/channels/${encodeURIComponent(channel.id)}/room-turn`,
            {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                text: trimmed,
                messageId,
                addressedAgentIds,
              }),
            },
          );
        } catch {
          setNotice(
            t(
              "The room could not be reached. Check the connection and try again.",
            ),
          );
          void catchUpRef.current();
          return;
        }
        /*
         * Acknowledged, so the server has it: the room writes the message and THEN answers 202.
         * Until this point the bubble exists only on screen, and a catch-up in that window would
         * have fetched a thread without it and taken the person's own words away.
         */
        setRoom((state) => ({
          ...state,
          messages: state.messages.map((message) =>
            message.id === messageId && message.pending
              ? { ...message, pending: false }
              : message,
          ),
        }));
        if (!response.ok) {
          /*
           * The server's own sentence is deliberately not read. It is written in English for an
           * operator, and this screen is read in Korean by somebody who wants to know what to do
           * next — which the status says well enough on its own.
           */
          setNotice(
            response.status === 404
              ? t("This room is no longer available.")
              : response.status === 400
                ? t("That message could not be sent. It may be too long.")
                : t("The room could not take that message."),
          );
          setRoom((state) => ({
            ...state,
            messages: state.messages.filter((m) => m.id !== messageId),
          }));
        }
      } finally {
        setPosting(false);
      }
    },
    [channel.id],
  );

  // The compose screen's first message is sent once the screen is up, never twice.
  useEffect(() => {
    if (!seed || seedSent.current) return;
    seedSent.current = true;
    const text = typeof seed.content === "string" ? seed.content : "";
    void post(text, []);
  }, [seed, post]);

  const stop = useCallback(async () => {
    setStopping(true);
    try {
      const response = await fetch(
        `/api/channels/${encodeURIComponent(channel.id)}/room-turn/stop`,
        { method: "POST", credentials: "include" },
      );
      /*
       * Said out loud when it did not work. Stop swallowing its own failure is the worst version of
       * this button: the person presses it, the room carries on, and the only explanation available
       * to them is that the product ignored them.
       */
      if (!response.ok) {
        setNotice(t("The room could not be stopped. Try again."));
      }
    } catch {
      setNotice(t("The room could not be stopped. Try again."));
    } finally {
      setStopping(false);
    }
  }, [channel.id]);

  /** Message id → the NAME of the Bot that said it, which is what the transcript draws. */
  const speakers = useMemo(() => {
    const names = new Map(
      (agentProfiles ?? []).map((profile) => [profile.id, profile.name]),
    );
    const resolved: Record<string, string> = {};
    for (const [messageId, agentId] of Object.entries({
      ...(marks.data?.speakers ?? {}),
      ...room.speakers,
    })) {
      const name = names.get(agentId);
      if (name) resolved[messageId] = name;
    }
    return resolved;
  }, [agentProfiles, marks.data?.speakers, room.speakers]);

  const messageTimes = useMemo(
    () => ({ ...(marks.data?.times ?? {}), ...room.times }),
    [marks.data?.times, room.times],
  );

  const inTurn = room.turnId !== null;

  /*
   * While a turn runs, look again every ten seconds. A question raised on another instance has no
   * frame that reaches this tab, and the member holding for it is not going to say so twice.
   */
  useEffect(() => {
    if (!inTurn) return;
    const timer = setInterval(() => void catchUpApprovalsRef.current(), 10_000);
    return () => clearInterval(timer);
  }, [inTurn]);

  return (
    <ConversationView
      agents={toAgentOptions(agentProfiles, channel.agentIds)}
      busy={posting || inTurn}
      disabled={!channel.active}
      messageTimes={messageTimes}
      messages={transcriptMessages(room.messages, seed)}
      notice={
        <>
          <RoomApprovals
            approvals={mayAnswer ? room.approvals : []}
            onAnswered={(approvalId) =>
              setRoom((state) => withoutApproval(state, approvalId))
            }
          />
          {notice ? (
            <p className="pb-2 text-destructive text-sm" role="alert">
              {notice}
            </p>
          ) : quiet ? (
            <p className="pb-2 text-muted-foreground text-sm" role="status">
              {quiet}
            </p>
          ) : !channel.active ? (
            <p className="pb-2 text-muted-foreground text-sm" role="status">
              {t(
                "This coworker has been deleted. The conversation stays readable, but it can no longer reply.",
              )}
            </p>
          ) : null}
        </>
      }
      onStop={() => void stop()}
      onSubmit={(draft) =>
        post(draft.text, draft.agentId ? [draft.agentId] : [])
      }
      pending={posting || inTurn}
      queueWhileBusy
      {...(readWindow ? { readWindow } : {})}
      speakers={speakers}
      stoppable={inTurn && !stopping}
    />
  );
}
