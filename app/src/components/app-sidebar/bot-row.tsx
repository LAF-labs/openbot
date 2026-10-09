import { Link } from "@tanstack/react-router";
import {
  memo,
  type ReactNode,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { openQuestions, watchQuestions } from "@/lib/approvals";
import { focusRing } from "@/components/ui/focus";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * THE MEASURED ROW: 54px tall, 10px corners, 8px gap. (A 36px face led it until 2026-10-09; the Bot
 * has no face now, and the name leads.)
 *
 * Not a padding that happens to add up — a fixed height, because the row holds two lines of text
 * whose lengths vary and a roster whose rows breathe at different heights stops reading as a list.
 * Hover and selected are `--sand-fill-ghost-*`: a #777777 alpha over whatever is behind, which is
 * why the same two values work in both themes.
 *
 * The stacked active+hover variant outranks plain hover by specificity, so hovering the row you are
 * on does not dip it back to the lighter fill.
 *
 * ONE FRAME FOR A COLLEAGUE AND FOR A ROOM. This string used to exist twice, copied into
 * `group-row.tsx`, and the copies had already drifted apart in the part that matters: a Bot row drew
 * name + role + time while a room row drew name + time and nothing else, so two rows in the same
 * list answered different questions. Both rows are now this frame plus `RosterRowLines`.
 *
 * The focus ring is `focusRing`, the house one, because neither row had a ring at all: a keyboard
 * walking the roster moved through five colleagues with nothing on screen saying which one it
 * was on.
 */
/**
 * WHAT A ROSTER ROW IS MADE OF, WRITTEN ONCE.
 *
 * The full row and the rail row differ only in whether the words are there, and both of them used
 * to spell out the whole thing — the height, both ghost fills twice over, and the focus ring. Six
 * raw `--sand-*` variables and a hand-copied ring, duplicated, which is exactly the drift
 * `app/tests/design-tokens.test.ts` exists to stop. Shared here so there is one of each.
 */
const ROSTER_ROW_SHARED = `h-row w-full flex-row items-center rounded-lg border border-transparent bg-clip-padding transition-colors hover:bg-[var(--sand-fill-ghost-hover)] ${focusRing} data-[status=active]:bg-[var(--sand-fill-ghost-selected)] data-[status=active]:hover:bg-[var(--sand-fill-ghost-selected)]`;

export const ROSTER_ROW_CLASS = `flex gap-2 px-2 ${ROSTER_ROW_SHARED}`;

/** The same row with the words taken out: a tile centred in the 64px rail. */
export const ROSTER_RAIL_ROW_CLASS = `flex justify-center ${ROSTER_ROW_SHARED}`;

/**
 * 8px, at a rail tile's bottom-right with a 2px inset — the measured corner marker. The ring is the
 * row's own background so the dot reads as sitting on top of the tile rather than punched into it.
 */
export const RosterUnreadDot = () => (
  <span
    aria-hidden="true"
    className="absolute right-0.5 bottom-0.5 size-2 rounded-full bg-[var(--sand-fill-accent)] ring-2 ring-sidebar"
  />
);

/**
 * NAME · LAST LINE · TIME. The one two-line block every roster row draws, colleague or room.
 *
 * The name takes the space it needs and no more, and the time is pushed out by `ms-auto` rather than
 * by `justify-between` — with space-between a short name parks the timestamp against it in the
 * middle of the row instead of on the right edge where the eye scans for it.
 *
 * The second line is 13/18 with a fixed min-height, so a row whose preview is empty still holds its
 * name on the same baseline as its neighbours.
 *
 * SOLID TEXT, NOT THE SHIMMER. The tool line's shimmer paints its glyphs through `background-clip:
 * text`, so the words exist only while that painting works. Here the label once measured
 * `rgba(0, 0, 0, 0)` and the row simply had a blank second line — the shimmer's gradient was built
 * from a colour its own rule had made transparent, fixed 2026-09-24 (styles.css). The roster, the
 * most read surface in the product, does not depend on a paint trick to say what a Bot is doing.
 */
/**
 * A Bot in the 64px rail, where its name has no room: the name's first letter on the rail's tile.
 *
 * THE NAME, CUT TO WHAT FITS — NOT A PICTURE (2026-10-09). The rail drew the Bot's face here; the
 * Bot has no face now, the profile is a name, and the rail is the one place the whole name cannot
 * stand. The tile is the one the conversation's icon sits on beside it, so the rail stays one row
 * of tiles; the whole name is in the tooltip and in the link's own name.
 */
export function RailNameTile({
  children,
  name,
}: {
  /** A corner marker, drawn over the tile. */
  children?: ReactNode;
  name: string;
}) {
  return (
    <span className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted font-semibold text-base text-muted-foreground">
      <span aria-hidden="true">{Array.from(name.trim())[0] ?? ""}</span>
      {children}
    </span>
  );
}

export const RosterRowLines = ({
  isSubtitleLive = false,
  isUnread = false,
  name,
  subtitle,
  time,
}: {
  /**
   * Draw the preview at full contrast even when the row is read. What a Bot is doing right now is
   * not the same kind of sentence as what it said yesterday.
   */
  isSubtitleLive?: boolean;
  isUnread?: boolean;
  name: string;
  subtitle: string | undefined;
  time: string | undefined;
}) => (
  <span className="flex min-w-0 flex-1 shrink flex-col overflow-hidden">
    <span className="flex min-w-0 flex-row items-center gap-1.5">
      <span
        className={
          isUnread
            ? "min-w-0 shrink truncate font-semibold text-base"
            : "min-w-0 shrink truncate text-base"
        }
      >
        {name}
      </span>
      <span className="ms-auto shrink-0 text-muted-foreground/80 text-xs tabular-nums">
        {time}
      </span>
    </span>
    {/*
     * The preview darkens with the name. The dot says "something happened here" from across the
     * room; the weight is what tells you WHICH of two dotted rows you have not read yet.
     */}
    <span
      className={
        isUnread || isSubtitleLive
          ? "min-h-[18px] min-w-0 shrink truncate text-foreground text-sm"
          : "min-h-[18px] min-w-0 shrink truncate text-muted-foreground text-sm"
      }
    >
      {subtitle}
    </span>
  </span>
);

/**
 * One Bot in the roster: its name, and the last thing said to it.
 *
 * THE ROW IS THE COLLEAGUE, NOT A SESSION WITH THEM. This list used to hold conversations, and
 * because every message from Home minted a fresh one, three Bots filled it with thirteen rows —
 * the same face nine times over. A Bot in this product is a colleague with a standing role, its own
 * routines and its own seat at the account's computer, and every other table in the server is keyed
 * on it. The conversation is now too, so the list is the roster: bounded, stable, and a colleague
 * you return to rather than a pile of sessions you have to choose between.
 *
 * A Bot nobody has spoken to yet still has a row. It leads to the compose screen, which introduces
 * the Bot and creates the conversation on the first message.
 */
export const BotRow = memo(function BotRow({
  agentId,
  isCompact = false,
  name,
  channelId,
  subtitle,
  lastMessageAt,
  unread = false,
  working,
}: {
  agentId: string;
  /** The 64px rail: the name's first letter, the whole name in a tooltip. */
  isCompact?: boolean;
  name: string;
  /** The Bot has said something since this person last opened the room. */
  unread?: boolean;
  /**
   * What this Bot is doing right now, or undefined when it is idle.
   *
   * A sentence rather than a flag, because the interesting half is WHICH work. "Nightly receipts"
   * at 6am is the difference between a Bot that is busy and a Bot you asked to be busy.
   */
  working?: string;
  /** The Bot's conversation, once it has one. */
  channelId: string | undefined;
  /** The last thing said, or the Bot's standing role before anything has been. */
  subtitle: string | undefined;
  lastMessageAt: string | undefined;
}) {
  /*
   * BROUGHT INTO VIEW ONCE, ON THE FIRST PAINT OF THE ROSTER.
   *
   * Open a Bot by link or reload the page and the list scrolls to the top, so the one row saying
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
   * WHETHER THIS BOT HAS STOPPED TO ASK, subscribed per row rather than computed once for the list.
   *
   * The mutations above this row deliberately live at the list level; this does not, because the
   * list is `bot-sidebar.tsx` and the store is a synchronous module-level Map with no network
   * behind it — a subscription costs a closure, and a roster is five colleagues, not five hundred.
   *
   * It is the questions THIS browser is holding open, which is the only per-Bot blocked signal that
   * exists: `/api/approvals` is keyed on one Bot at a time, so a roster-wide poll would be one
   * request per Bot per tick to learn something this tab already knows whenever it is the tab that
   * ran the turn.
   */
  const blocked = useSyncExternalStore(watchQuestions, () =>
    openQuestions().some((question) => question.botId === agentId),
  );
  /*
   * WHAT THE FACE SAID, IN WORDS (2026-10-09). The row led with the Bot's face, whose eyes widened
   * when it had stopped to ask; that was the only place a sighted person was told, and the Bot has
   * no face now. So the preview line says it — the same sentence a screen reader was always given —
   * before what the Bot is doing and before what it last said: a question waiting on the person
   * beats both. Working was already said there.
   */
  const waiting = blocked ? t("Waiting for your answer") : undefined;
  const announced = waiting ?? working ?? (unread ? t("Unread") : undefined);
  const status = announced ? (
    <span className="sr-only" role={blocked || working ? "status" : undefined}>
      {announced}
    </span>
  ) : null;

  /*
   * THE UNREAD DOT HAS A SLOT OF ITS OWN at the start of the row, drawn or not, so a row that is
   * read and one that is not keep their names on the same edge. It sat on the face's corner.
   */
  const mark = (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", unread ? "bg-mark" : null)}
    />
  );

  const body = (
    <>
      {status}
      {mark}
      <RosterRowLines
        isSubtitleLive={Boolean(waiting ?? working)}
        isUnread={unread}
        name={name}
        /*
         * While a Bot works, the preview line says what it is doing instead of what it last said.
         * The last thing it said is still there when it finishes, and a row that keeps showing
         * yesterday's sentence through a live run is a row that never looks like anything happens.
         */
        subtitle={waiting ?? working ?? subtitle}
        time={lastMessageAt}
      />
    </>
  );

  /*
   * In the rail the words are gone, so the link would have no accessible name at all — the tile is
   * one letter and the dot is decorative. The name becomes the label, and whatever the row was
   * announcing is folded into it: `aria-label` replaces the contents of an element, so an `sr-only`
   * span inside would have gone unread. The tooltip says the same, so a question waiting is in
   * words on hover too.
   */
  const compactLabel = announced ? `${name} · ${announced}` : name;
  /*
   * THE TILE'S ONE MARK MEANS "LOOK HERE", for a question as much as for something unread. In the
   * rail the words are gone; a Bot waiting on the person's answer was said by its face's eyes until
   * the face went (2026-10-09), and after that by the label and the tooltip only — so once the
   * question had been read, a tile with somebody waiting behind it looked like an idle one until
   * it was hovered (Codex's read of that change).
   */
  const tile = (
    <RailNameTile name={name}>
      {unread || blocked ? <RosterUnreadDot /> : null}
    </RailNameTile>
  );

  if (isCompact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            channelId ? (
              <Link
                aria-label={compactLabel}
                className={ROSTER_RAIL_ROW_CLASS}
                params={{ channelId }}
                ref={rowRef}
                to="/channel/$channelId"
              />
            ) : (
              <Link
                aria-label={compactLabel}
                className={ROSTER_RAIL_ROW_CLASS}
                ref={rowRef}
                search={{ agent: agentId }}
                to="/channel/new"
              />
            )
          }
        >
          {tile}
        </TooltipTrigger>
        <TooltipContent side="right">{compactLabel}</TooltipContent>
      </Tooltip>
    );
  }

  return channelId ? (
    <Link
      className={ROSTER_ROW_CLASS}
      params={{ channelId }}
      ref={rowRef}
      to="/channel/$channelId"
    >
      {body}
    </Link>
  ) : (
    <Link
      className={ROSTER_ROW_CLASS}
      ref={rowRef}
      search={{ agent: agentId }}
      to="/channel/new"
    >
      {body}
    </Link>
  );
});
