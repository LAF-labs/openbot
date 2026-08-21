import { IconPin } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { memo, useEffect, useRef } from "react";
import { Mascot } from "@/components/agents/mascot";
import { t } from "@/lib/i18n";

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
  pinned = false,
  subtitle,
  lastMessageAt,
}: {
  agentId: string;
  avatarSeed: string;
  name: string;
  /** Kept at the top of the roster by this person. Marked, or the order looks arbitrary. */
  pinned?: boolean;
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

  /*
   * THE MEASURED ROW: 54px tall, 10px corners, 8px gap, a 36px face.
   *
   * Not a padding that happens to add up — a fixed height, because the row holds two lines of text
   * whose lengths vary and a roster whose rows breathe at different heights stops reading as a
   * list. Hover and selected are `--sand-fill-ghost-*`: a #777777 alpha over whatever is behind,
   * which is why the same two values work in both themes.
   *
   * The stacked active+hover variant outranks plain hover by specificity, so hovering the row you
   * are on does not dip it back to the lighter fill.
   */
  const shared = {
    ref: rowRef,
    className:
      "flex h-[var(--sand-row-height)] w-full flex-row items-center gap-2 rounded-lg px-2 transition-colors hover:bg-[var(--sand-fill-ghost-hover)] data-[status=active]:bg-[var(--sand-fill-ghost-selected)] data-[status=active]:hover:bg-[var(--sand-fill-ghost-selected)]",
  };

  const body = (
    <>
      <span className="inline-flex size-9 shrink-0 overflow-hidden rounded-xl">
        <Mascot
          className="size-full object-cover"
          seed={avatarSeed}
          size={36}
        />
      </span>
      <span className="flex min-w-0 flex-1 shrink flex-col overflow-hidden">
        <span className="flex min-w-0 flex-row items-center gap-1.5">
          {/*
           * The name takes the space it needs and no more, and the time is pushed out by `ms-auto`
           * rather than by `justify-between` — with space-between a short name parks the timestamp
           * against it in the middle of the row instead of on the right edge where the eye scans
           * for it.
           */}
          <span className="min-w-0 shrink truncate text-base">{name}</span>
          {/*
           * A pin that moves a row without saying so reads as a list that shuffles itself. The
           * glyph is the only thing on the row explaining why this one is above a Bot that spoke
           * more recently.
           */}
          {pinned ? (
            <IconPin
              aria-label={t("Pinned")}
              className="size-3 shrink-0 text-muted-foreground"
            />
          ) : null}
          <span className="ms-auto shrink-0 text-muted-foreground/80 text-xs tabular-nums">
            {lastMessageAt}
          </span>
        </span>
        {/* 13/18 — the scale's second body size, and a fixed min-height so an empty preview
         * still holds the name on the same baseline as its neighbours. */}
        <span className="min-h-[18px] min-w-0 shrink truncate text-muted-foreground text-sm">
          {subtitle}
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
