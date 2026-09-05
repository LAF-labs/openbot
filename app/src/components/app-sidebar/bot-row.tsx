import { IconPin } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import {
  memo,
  type ReactNode,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useBotMood } from "@/lib/agents/bot-mood";
import { openQuestions, watchQuestions } from "@/lib/approvals";
import { t } from "@/lib/i18n";

/**
 * THE MEASURED ROW: 54px tall, 10px corners, 8px gap, a 36px face.
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
 * `focus-visible:*` and the transparent border it paints are lifted verbatim from
 * `components/ui/button.tsx`, because neither row had a focus ring at all: a keyboard walking the
 * roster moved through five colleagues with nothing on screen saying which one it was on.
 */
export const ROSTER_ROW_CLASS =
  "flex h-[var(--sand-row-height)] w-full flex-row items-center gap-2 rounded-lg border border-transparent bg-clip-padding px-2 outline-none transition-colors hover:bg-[var(--sand-fill-ghost-hover)] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-[status=active]:bg-[var(--sand-fill-ghost-selected)] data-[status=active]:hover:bg-[var(--sand-fill-ghost-selected)]";

/** The same row with the words taken out: a face centred in the 64px rail. */
export const ROSTER_RAIL_ROW_CLASS =
  "flex h-[var(--sand-row-height)] w-full flex-row items-center justify-center rounded-lg border border-transparent bg-clip-padding outline-none transition-colors hover:bg-[var(--sand-fill-ghost-hover)] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-[status=active]:bg-[var(--sand-fill-ghost-selected)] data-[status=active]:hover:bg-[var(--sand-fill-ghost-selected)]";

/**
 * 8px, at the face's bottom-right with a 2px inset — the measured corner marker. The ring is the
 * row's own background so the dot reads as sitting on top of the face rather than punched into it.
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
 * SOLID TEXT, NOT THE SHIMMER. The tool line's shimmer paints its glyphs with `background-clip:
 * text` over a transparent colour, so the words exist only while the animation is being drawn. On a
 * backgrounded tab the label measured `rgba(0, 0, 0, 0)` and the row simply had a blank second line.
 * That is an acceptable trade for a decorative tool line and not for the roster, which is the most
 * read surface in the product.
 */
export const RosterRowLines = ({
  afterName,
  isSubtitleLive = false,
  isUnread = false,
  name,
  subtitle,
  time,
}: {
  /** Sits on the name's baseline — in practice the pin glyph. */
  afterName?: ReactNode;
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
      {afterName}
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
 * One Bot in the roster: its face, its name, and the last thing said to it.
 *
 * THE ROW IS THE COLLEAGUE, NOT A SESSION WITH THEM. This list used to hold conversations, and
 * because every message from Home minted a fresh one, three Bots filled it with thirteen rows —
 * the same face nine times over. A Bot in this product is a colleague with a standing role, its own
 * routines and its own seat at the account's computer, and every other table in the server is keyed
 * on it. The conversation is now too, so the list is the roster: bounded, stable, and a face you
 * return to rather than a pile of sessions you have to choose between.
 *
 * A Bot nobody has spoken to yet still has a row. It leads to the compose screen, which introduces
 * the Bot and creates the conversation on the first message.
 */
export const BotRow = memo(function BotRow({
  agentId,
  avatarSeed,
  isCompact = false,
  name,
  channelId,
  pinned = false,
  subtitle,
  lastMessageAt,
  unread = false,
  working,
}: {
  agentId: string;
  avatarSeed: string;
  /** The 64px rail: the face alone, its name in a tooltip. */
  isCompact?: boolean;
  name: string;
  /** Kept at the top of the roster by this person. Marked, or the order looks arbitrary. */
  pinned?: boolean;
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
   * THE FACE'S MOOD, from the three things this row knows: a question waiting, a turn running,
   * and when the Bot last said anything. Asleep after half an hour of quiet, glad for a moment when
   * a turn ends — see `bot-mood.ts` for the order those win in.
   */
  const mood = useBotMood({
    working: Boolean(working),
    blocked,
    lastMessageAt,
  });

  /*
   * A dot, a posture and a weight are not announced. This is — and blocked is announced even though
   * the face says it loudly, because a widened eye is exactly the kind of signal a screen reader
   * cannot pass on.
   */
  const announced = blocked
    ? t("Waiting for your answer")
    : (working ?? (unread ? t("Unread") : undefined));
  const status = announced ? (
    <span className="sr-only" role={blocked || working ? "status" : undefined}>
      {announced}
    </span>
  ) : null;

  /*
   * `relative` and NOT `overflow-hidden` on the outer span: the dot overhangs the face by design,
   * and clipping the wrapper would slice it in half. The face is not clipped at all any more — its
   * silhouette IS the identity now, and a squircle inside a `rounded-xl` window is a squircle with
   * its corners taken off.
   *
   * THE SPINNING RING IS GONE, AND THE FACE CARRIES WORK INSTEAD. The ring existed because the old
   * avatar was a photograph that could not react to anything, so "busy" had to be welded to its
   * corner. This face looks up and breathes while a turn runs and widens its eyes when the Bot has
   * stopped to ask, which leaves the corner free for the one thing that is about the CONVERSATION
   * rather than about the Bot.
   */
  const face = (
    <span className="relative inline-flex size-9 shrink-0">
      <BotAvatar
        className="size-full"
        seed={avatarSeed}
        size={36}
        state={mood}
      />
      {unread ? <RosterUnreadDot /> : null}
    </span>
  );

  const body = (
    <>
      {status}
      {face}
      <RosterRowLines
        afterName={
          /*
           * A pin that moves a row without saying so reads as a list that shuffles itself. The
           * glyph is the only thing on the row explaining why this one is above a Bot that spoke
           * more recently.
           */
          pinned ? (
            <IconPin
              aria-label={t("Pinned")}
              className="size-3 shrink-0 text-muted-foreground"
            />
          ) : undefined
        }
        isSubtitleLive={Boolean(working)}
        isUnread={unread}
        name={name}
        /*
         * While a Bot works, the preview line says what it is doing instead of what it last said.
         * The last thing it said is still there when it finishes, and a row that keeps showing
         * yesterday's sentence through a live run is a row that never looks like anything happens.
         */
        subtitle={working ?? subtitle}
        time={lastMessageAt}
      />
    </>
  );

  /*
   * In the rail the words are gone, so the link would have no accessible name at all — the face is
   * an SVG and the dot is decorative. The name becomes the label, and whatever the row was
   * announcing is folded into it: `aria-label` replaces the contents of an element, so an `sr-only`
   * span inside would have gone unread.
   */
  const compactLabel = announced ? `${name} · ${announced}` : name;

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
          {face}
        </TooltipTrigger>
        <TooltipContent side="right">{name}</TooltipContent>
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
