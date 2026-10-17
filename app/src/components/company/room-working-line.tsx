import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { workingQueryOptions } from "@/lib/agents/working";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { type CompanyMember, memberName } from "@/lib/hub/company";
import {
  nextWorkingChange,
  type RoomLine,
  roomConversationOf,
  workingInRoom,
} from "@/lib/hub/room-working";
import { t } from "@/lib/i18n";
import { useNow } from "@/lib/use-now";

/**
 * Under a team room's messages: "○○의 라피가 알아보는 중" for each member whose 라피 is answering a
 * question in this room now, read off the room (`lib/hub/room-working.ts`). For the asker, a way to
 * their own conversation for the room, where their 라피 works it and where an approval it needs is.
 *
 * The line ends by itself when its window passes, at that moment rather than on the next minute:
 * the clock is read when the room changes and again when the soonest line runs out.
 */
export function RoomWorkingLine({
  roomId,
  lines,
  meId,
  members,
}: {
  roomId: string;
  lines: readonly RoomLine[] | undefined;
  meId: string | undefined;
  members: readonly CompanyMember[] | undefined;
}) {
  const minute = useNow();
  const [now, setNow] = useState<number | null>(null);
  const working = useQuery(workingQueryOptions());
  const channels = useQuery(channelListQueryOptions());
  const myRoomRun = working.data?.some((run) => run.origin === "room") === true;
  const options = { me: meId, myRoomRun };
  const clock = now ?? minute.getTime();
  const shown = workingInRoom(lines ?? [], clock, options);
  const next = nextWorkingChange(lines ?? [], shown, options);

  // The clock, read again whenever the room or the runs change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are what make the clock worth reading again
  useEffect(() => {
    setNow(Date.now());
  }, [lines, myRoomRun]);

  // And once more when the soonest line's window runs out.
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, next - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [next]);

  if (shown.length === 0) return null;
  const isMineAsked = shown.some(({ member }) => member === meId);
  const conversation = isMineAsked
    ? roomConversationOf(roomId, channels.data)
    : undefined;

  return (
    <div
      aria-live="polite"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm"
      data-room-working
      role="status"
    >
      {shown.map(({ member }) => (
        <span
          className="animate-pulse"
          data-room-working-member={member}
          key={member}
        >
          {member === meId
            ? t("My Lafi is looking into it")
            : t("{name}'s Lafi is looking into it", {
                name: memberName(member, members),
              })}
        </span>
      ))}
      {conversation ? (
        <Link
          className="text-link underline-offset-2 hover:underline"
          data-room-working-conversation
          params={{ channelId: conversation.id }}
          to="/channel/$channelId"
        >
          {t("See it in my Lafi's conversation")}
        </Link>
      ) : null}
    </div>
  );
}
