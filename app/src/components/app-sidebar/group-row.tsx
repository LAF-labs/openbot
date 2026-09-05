import { Link } from "@tanstack/react-router";
import { memo } from "react";
import {
  ROSTER_RAIL_ROW_CLASS,
  ROSTER_ROW_CLASS,
  RosterRowLines,
  RosterUnreadDot,
} from "@/components/app-sidebar/bot-row";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";

/**
 * A room with more than one Bot in it, on the same 54px row as a colleague.
 *
 * Keyed on the CHANNEL, which is the whole reason it is a separate component: a Bot row is keyed on
 * the Bot and finds its conversation, and a group has no single Bot to hang itself on.
 *
 * EVERYTHING ELSE IS NOW LITERALLY THE SAME MARKUP, not a copy that agrees. It was a copy, and it
 * had drifted: a Bot row drew name + role + time and a room row drew name + time, so the second line
 * of the roster meant one thing above the groups and nothing below them. The frame and the two lines
 * come from `bot-row.tsx` — one layout, name · last line · time, whoever is in the row.
 */
export const GroupRow = memo(function GroupRow({
  channelId,
  isCompact = false,
  participantIds,
  name,
  subtitle,
  lastMessageAt,
  unread = false,
}: {
  channelId: string;
  /** The 64px rail: the faces alone, the room's name in a tooltip. */
  isCompact?: boolean;
  participantIds: string[];
  name: string;
  /** The last thing said in the room, or who is in it before anybody has. */
  subtitle: string | undefined;
  lastMessageAt: string | undefined;
  /** A Bot has spoken here since this person last opened it. */
  unread?: boolean;
}) {
  /*
   * The faces are stacked rather than merged into one glyph: who is in the room is the only thing
   * distinguishing two groups whose names are both a list of names.
   */
  const faces = (
    <span className="relative inline-flex size-9 shrink-0">
      <ChannelAvatar participantIds={participantIds} size={36} />
      {unread ? <RosterUnreadDot /> : null}
    </span>
  );

  if (isCompact) {
    /*
     * `aria-label` replaces the contents of an element, so the unread `sr-only` span the full row
     * carries would go unread here. It is folded into the label instead.
     */
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label={unread ? `${name} · ${t("Unread")}` : name}
              className={ROSTER_RAIL_ROW_CLASS}
              params={{ channelId }}
              to="/channel/$channelId"
            />
          }
        >
          {faces}
        </TooltipTrigger>
        <TooltipContent side="right">{name}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Link
      className={ROSTER_ROW_CLASS}
      params={{ channelId }}
      to="/channel/$channelId"
    >
      {unread ? <span className="sr-only">{t("Unread")}</span> : null}
      {faces}
      <RosterRowLines
        isUnread={unread}
        name={name}
        subtitle={subtitle}
        time={lastMessageAt}
      />
    </Link>
  );
});
