import { Link } from "@tanstack/react-router";
import { memo, useEffect, useRef } from "react";
import { Mascot } from "@/components/agents/mascot";

/**
 * One Bot in the rail: its face, its name, and the last thing said to it.
 *
 * THE ROW IS THE COLLEAGUE, NOT A SESSION WITH THEM. This rail used to list conversations, and
 * because every message from Home minted a fresh one, three Bots filled it with thirteen rows —
 * the same face nine times over. A Bot in this product is a colleague with a standing role, its own
 * routines and its own seat at the account's computer, and every other table in the server is keyed
 * on it. The conversation is now too, so the rail is the roster: bounded, stable, and a face you
 * return to rather than a pile of sessions you have to choose between.
 *
 * A Bot nobody has spoken to yet still has a row. It leads to the compose screen, which introduces
 * the Bot and creates the conversation on the first message.
 */
export const BotRow = memo(function BotRow({
  agentId,
  avatarSeed,
  name,
  channelId,
  subtitle,
  lastMessageAt,
}: {
  agentId: string;
  avatarSeed: string;
  name: string;
  /** The Bot's conversation, once it has one. */
  channelId: string | undefined;
  /** The last thing said, or the Bot's standing role before anything has been. */
  subtitle: string | undefined;
  lastMessageAt: string | undefined;
}) {
  /*
   * BROUGHT INTO VIEW ONCE, ON THE FIRST PAINT OF THE ROSTER.
   *
   * Open a Bot by link or reload the page and the rail scrolls to the top, so the one row saying
   * which conversation you are in can sit below the fold. Only on mount, and only for the row that
   * is already active: scrolling on every activation would yank the list under somebody who just
   * clicked a row they could see.
   */
  const rowRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const row = rowRef.current;
    if (row?.dataset.status !== "active") return;
    row.scrollIntoView({ block: "center", behavior: "auto" });
  }, []);

  const shared = {
    ref: rowRef,
    // The stacked active+hover variant outranks plain hover by specificity, so hovering the row you
    // are on does not dip it back to the lighter fill.
    className:
      "flex flex-row py-2 px-2 gap-2 items-center w-full rounded-lg hover:bg-foreground/5 data-[status=active]:bg-foreground/8 data-[status=active]:hover:bg-foreground/8",
  };

  const body = (
    <>
      <span className="inline-flex size-8 shrink-0 overflow-hidden rounded-full ring-1 ring-border">
        <Mascot
          className="size-full object-cover"
          seed={avatarSeed}
          size={32}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-row items-center justify-between gap-2">
          <span className="truncate text-base tracking-[-1%]">{name}</span>
          <span className="shrink-0 text-xs text-muted-foreground/70 tabular-nums">
            {lastMessageAt}
          </span>
        </span>
        {/* 12px is the scale's secondary role; the timestamp above is meta, at the 11px floor. */}
        <span className="mt-px flex h-4 items-center">
          <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-foreground">
            {subtitle}
          </span>
        </span>
      </span>
    </>
  );

  return channelId ? (
    <Link {...shared} params={{ channelId }} to="/channel/$channelId">
      {body}
    </Link>
  ) : (
    <Link {...shared} search={{ agent: agentId }} to="/channel/new">
      {body}
    </Link>
  );
});
