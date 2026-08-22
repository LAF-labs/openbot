import type { Message } from "@ag-ui/core";
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
import { setChannelReadMutationOptions } from "@/lib/channels/mutations";
import {
  type AgentChannel,
  messageTimesQueryOptions,
} from "@/lib/channels/queries";
import {
  applyRoomFrame,
  EMPTY_ROOM,
  mergeStored,
  type RoomState,
} from "@/lib/channels/room-events";
import type { RoomFrame } from "@/lib/channels/room-frames";
import { normalizeStoredMessages } from "@/lib/channels/thread-history";
import {
  CHANNEL_ACTIVITY,
  type ChannelActivity,
  channelActivity,
  ROOM_FRAME,
  roomFrames,
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
export function GroupChat({ channel }: { channel: AgentChannel }) {
  const queryClient = useQueryClient();
  const { data: agentProfiles } = useQuery(agentListQueryOptions());
  const marks = useQuery(messageTimesQueryOptions(channel.id));
  const [room, setRoom] = useState<RoomState>(EMPTY_ROOM);
  const [posting, setPosting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
  const catchUpRef = useRef(catchUp);
  catchUpRef.current = catchUp;

  useEffect(() => {
    void catchUpRef.current();
  }, []);

  /*
   * Two listeners on the one socket. Frames are the turn as it runs; activity is a message that
   * LANDED, which is how a settled copy replaces a provisional one. Activity for this room from a
   * Bot triggers a catch-up, and the room is marked read again because it is on screen.
   */
  useEffect(() => {
    const onFrame = (event: Event) => {
      const frame = (event as CustomEvent<RoomFrame>).detail;
      setRoom((state) => applyRoomFrame(state, frame, channel.id));
    };
    const onActivity = (event: Event) => {
      const activity = (event as CustomEvent<ChannelActivity>).detail;
      if (activity.channelId !== channel.id) return;
      if (!activity.lastMessageAgentId) return;
      void catchUpRef.current();
      void markRead
        .current({ channelId: channel.id, read: true })
        .catch(() => {});
    };
    roomFrames.addEventListener(ROOM_FRAME, onFrame);
    channelActivity.addEventListener(CHANNEL_ACTIVITY, onActivity);
    return () => {
      roomFrames.removeEventListener(ROOM_FRAME, onFrame);
      channelActivity.removeEventListener(CHANNEL_ACTIVITY, onActivity);
    };
  }, [channel.id]);

  const post = useCallback(
    async (text: string, addressedAgentIds: string[]) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setNotice(null);
      setPosting(true);
      try {
        const messageId = crypto.randomUUID();
        // On screen at once, under the id the server will store it as, so catch-up keeps it.
        setRoom((state) => ({
          ...state,
          messages: [
            ...state.messages,
            { id: messageId, role: "user", content: trimmed },
          ],
        }));
        const response = await fetch(
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
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          setNotice(body?.error ?? t("The room could not take that message."));
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
      await fetch(
        `/api/channels/${encodeURIComponent(channel.id)}/room-turn/stop`,
        { method: "POST", credentials: "include" },
      );
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

  return (
    <ConversationView
      agents={toAgentOptions(agentProfiles, channel.agentIds)}
      busy={posting || inTurn}
      disabled={!channel.active}
      messageTimes={messageTimes}
      messages={transcriptMessages(room.messages, seed)}
      notice={
        notice ? (
          <p className="pb-2 text-destructive text-sm" role="alert">
            {notice}
          </p>
        ) : !channel.active ? (
          <p className="pb-2 text-muted-foreground text-sm" role="status">
            {t(
              "This coworker has been deleted. The conversation stays readable, but it can no longer reply.",
            )}
          </p>
        ) : null
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
