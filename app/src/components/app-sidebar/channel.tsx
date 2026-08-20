import { Link } from "@tanstack/react-router";
import { memo } from "react";
import { ChannelAvatar, useAgentNames } from "../channels/avatar";

/**
 * The second line of a roster row, which must never repeat the first.
 *
 * A channel is titled by the first thing its owner said, and until somebody says something else that
 * first thing is also the last message — so the row printed the same sentence twice, in two sizes,
 * on the most prominent row in the app. When the preview says nothing the title has not already
 * said, the coworker's name takes the line instead: the row then reads topic over who, which is what
 * the header does, and there is no state where the line is redundant or blank.
 */
function subtitleFor(
  name: string,
  lastMessage: string | undefined,
  coworker: string | undefined,
) {
  const preview = lastMessage?.trim();
  if (!preview) return coworker;
  const title = name.trim();
  // Prefix rather than equality: the title is the message truncated to 60 code points, so a longer
  // opening message leaves a preview that merely starts the same way.
  if (preview.startsWith(title) || title.startsWith(preview)) return coworker;
  return preview;
}

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
  const nameOf = useAgentNames();
  const subtitle = subtitleFor(
    name,
    lastMessage,
    participantIds[0] ? nameOf(participantIds[0]) : undefined,
  );

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
          <span className="truncate text-base tracking-[-1%]">{name}</span>
          <div className="shrink-0 text-xs text-muted-foreground/70 tabular-nums">
            {lastMessageAt}
          </div>
        </div>
        <div className="mt-px flex h-4 items-center gap-1.5">
          {/* 12px is the scale's secondary role; the timestamp above is meta, at the 11px floor. */}
          <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-foreground">
            {subtitle}
          </span>
        </div>
      </div>
    </Link>
  );
});
