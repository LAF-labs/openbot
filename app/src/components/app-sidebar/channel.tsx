import { Link } from "@tanstack/react-router";
import { memo } from "react";
import { ChannelAvatar } from "../channels/avatar";

/**
 * Memoized roster row. `use-channel-events` preserves unchanged row identity, and
 * `content-visibility` keeps off-screen rows cheap without virtualization.
 */
export const Channel = memo(function Channel({
  channelId,
  participantIds,
  name,
  lastMessage,
  lastMessageAt,
}: {
  channelId: string;
  participantIds: string[];
  name: string;
  lastMessage?: string;
  lastMessageAt?: string;
}) {
  return (
    <Link
      to="/channel/$channelId"
      params={{ channelId }}
      // The stacked active+hover variant outranks the plain hover by specificity, so hovering the
      // active row does not dip it back to the lighter hover fill.
      className="flex flex-row py-2 px-2 gap-2 items-center w-full rounded-lg hover:bg-foreground/5 data-[status=active]:bg-foreground/8 data-[status=active]:hover:bg-foreground/8 [contain-intrinsic-size:auto_3.25rem] [content-visibility:auto]"
    >
      <div className="shrink-0">
        <ChannelAvatar participantIds={participantIds} size={32} />
      </div>
      <div className="flex-col min-w-0 flex-1">
        <div className="flex flex-row items-center justify-between gap-2">
          <span className="text-[14px] tracking-[-1%] truncate">{name}</span>
          <div className="shrink-0 text-[12px] text-muted-foreground/70 tabular-nums">
            {lastMessageAt}
          </div>
        </div>
        <div className="mt-px flex h-4 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-foreground">
            {lastMessage}
          </span>
        </div>
      </div>
    </Link>
  );
});
