import { Link } from "@tanstack/react-router";
import { memo } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { t } from "@/lib/i18n";

/**
 * A room with more than one Bot in it, on the same 54px row as a colleague.
 *
 * Keyed on the CHANNEL, which is the whole reason it is a separate component: a Bot row is keyed on
 * the Bot and finds its conversation, and a group has no single Bot to hang itself on. Everything
 * else is deliberately identical — same height, same corners, same two lines — because a roster
 * whose rows are built differently reads as two lists stacked on top of each other.
 *
 * The faces are stacked rather than merged into one glyph: who is in the room is the only thing
 * distinguishing two groups whose names are both a list of names.
 */
export const GroupRow = memo(function GroupRow({
  channelId,
  participantIds,
  name,
  subtitle,
  lastMessageAt,
  unread = false,
}: {
  channelId: string;
  participantIds: string[];
  name: string;
  /** The last thing said in the room, or nothing yet. */
  subtitle: string | undefined;
  lastMessageAt: string | undefined;
  /** A Bot has spoken here since this person last opened it. */
  unread?: boolean;
}) {
  return (
    <Link
      className="flex h-[var(--sand-row-height)] w-full flex-row items-center gap-2 rounded-lg px-2 transition-colors hover:bg-[var(--sand-fill-ghost-hover)] data-[status=active]:bg-[var(--sand-fill-ghost-selected)] data-[status=active]:hover:bg-[var(--sand-fill-ghost-selected)]"
      params={{ channelId }}
      to="/channel/$channelId"
    >
      {unread ? <span className="sr-only">{t("Unread")}</span> : null}
      <span className="relative inline-flex shrink-0">
        <ChannelAvatar participantIds={participantIds} size={36} />
        {unread ? (
          <span
            aria-hidden="true"
            className="absolute right-0.5 bottom-0.5 size-2 rounded-full bg-[var(--sand-fill-accent)] ring-2 ring-sidebar"
          />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 shrink flex-col overflow-hidden">
        <span className="flex min-w-0 flex-row items-center gap-1.5">
          <span
            className={
              unread
                ? "min-w-0 shrink truncate font-semibold text-base"
                : "min-w-0 shrink truncate text-base"
            }
          >
            {name}
          </span>
          <span className="ms-auto shrink-0 text-muted-foreground/80 text-xs tabular-nums">
            {lastMessageAt}
          </span>
        </span>
        <span
          className={
            unread
              ? "min-h-[18px] min-w-0 shrink truncate text-foreground text-sm"
              : "min-h-[18px] min-w-0 shrink truncate text-muted-foreground text-sm"
          }
        >
          {subtitle}
        </span>
      </span>
    </Link>
  );
});
