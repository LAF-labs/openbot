import { IconWorld } from "@tabler/icons-react";
import { type Ref, useEffect, useRef, useState } from "react";
import { siteNameOf } from "@/components/computer/task-title";
import { focusRing } from "@/components/ui/focus";
import { t } from "@/lib/i18n";
import type { Source } from "./sources";

/**
 * One pill's look, the link's and the "+n"'s alike: 24px high, the small size, a hairline round it
 * — which is also what the focus ring recolours (`focus.ts`). `min-w-0 max-w-full`, so a host
 * longer than a phone is wide is cut off inside its pill and does not push the conversation
 * sideways.
 *
 * BOTH SAY `tabIndex={0}`, WHICH LOOKS LIKE IT SAYS NOTHING. WebKit — the installed app's engine
 * on a Mac — leaves a link and a bare button out of Tab's path unless they name a place in it.
 * Pressed in headless WebKit against the running app, 2026-10-04: Tab from the first pill went
 * past the "+4" beside it to 복사, which is one of the app's own buttons and carries the
 * attribute (Base UI writes it). A pill drawn like a control and passed over like a word in a
 * sentence is neither.
 */
const pill = `inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-full border border-border px-2 text-muted-foreground transition-colors hover:border-ring/40 hover:text-foreground ${focusRing}`;

/** The row the pills stand in; what each part of it is for is said where it is drawn. */
const row = "mt-1.5 flex w-full max-w-170 items-center gap-1 pb-2 text-xs";

/**
 * WHERE AN ANSWER CAME FROM: A PILL AT THE END OF ITS WORDS, AND "+n" BESIDE IT FOR THE REST.
 *
 * It was "출처 N개", a fold that opened to a list of links — the site, the page's title and an
 * arrow on a line each. The owner, 2026-10-04, of an app that shows far too many words: "출처를
 * 그렇게 표시하지 마. 그냥 글 마지막에 pill형태로 표시하는거로 해. 출처가 여럿이면 첫번째 항목+n
 * 식으로 표시하고 클릭 시 새 탭에서 연다." So the first source is the pill, and it is the link: one
 * press and the page is open, where the fold took one to count the sources and a second to reach
 * one.
 *
 * THE REST OPEN IN PLACE. "+2" draws the other two as pills of the same kind in the same row and
 * goes: nothing is left to count. In place, and not in a menu or a popover, because a row that
 * grows needs no layer over the conversation, and nothing to put away afterwards.
 *
 * NAMED AS PEOPLE NAME THE SITE, as a browsing task is (`siteNameOf`): 네이버 뉴스, not
 * news.naver.com, and the host where nobody has a name for it. The page's own title is what a
 * pointer is told on hover, where the browser reported one — it often does not: measured, a
 * navigation hands back an empty title.
 *
 * A PILL IS A PAGE, NOT A SITE, so one site read three times is one name three times, with only
 * the title on hover to tell them apart — seen at once in the first conversation this was pressed
 * in (토스증권, 토스증권, …, 토스증권). Left so on purpose: one pill a site would have to choose
 * which of its pages to open and which to drop, and that is a decision about what a source is
 * (`sources.ts`), not about how one is drawn.
 *
 * NO FAVICON. A site's own icon would be fetched from the site: every source's host called from
 * the person's device for a page they have not chosen to open. One globe, drawn here, for all.
 *
 * REAL LINKS, IN A NEW WINDOW: the conversation is where the person is working, and the installed
 * app has no Back to come home by. The shell hands a `_blank` link to the system's browser by a
 * listener on the document (`lib/notifications/shell-links.ts`) that looks for an anchor and
 * nothing else, so a pill that opened its page from a press handler would open nothing there.
 */
export function SourcesRow({ sources }: { sources: readonly Source[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const firstOpened = useRef<HTMLAnchorElement>(null);

  /*
   * THE PRESS THAT OPENS THE REST REMOVES THE BUTTON IT WAS MADE ON, and a control that goes while
   * it has the focus hands the focus to the page: the next Tab would begin at the top of the app.
   * So the focus goes to the first pill the press drew — which is also where a screen reader is
   * told what the press did.
   */
  useEffect(() => {
    if (isOpen) firstOpened.current?.focus();
  }, [isOpen]);

  if (sources.length === 0) return null;
  const shown = isOpen ? sources : sources.slice(0, 1);
  const more = sources.length - shown.length;

  return (
    /*
     * UNDER THE LAST LINE, FROM THE WORDS' LEFT EDGE, AND NO WIDER THAN THE WORDS (`max-w-170`, the
     * answer's own measure). Closed, it is one line: "first +n" is read as one thing, so the pill
     * gives way — it is cut off inside itself — and the "+n" stays beside it. A host longer than a
     * phone is wide sent the "+7" to a line of its own until this was so. Opened, the pills wrap
     * where a sentence would.
     *
     * THE 8px UNDER THE PILLS IS THE REPLY ACTIONS' ROOM. They hang from the foot of the answer's
     * wrapper, pulled 6px up into it (`ReplyActions`), and they are there whether or not they are
     * drawn: `opacity: 0` takes nothing out of the way of a press. Laid out in headless Chromium,
     * 2026-10-04 (a static copy of the mounted conversation with the built stylesheet): the
     * fold's "출처 3개", 23px high, lost its lowest 6px across its first 52px to 복사 and 더 보기 —
     * a press at its foot copied the answer, or opened the menu. The first pill stands on that
     * very stretch, and a quarter of its height would have been theirs. With this room, in
     * Chromium and in WebKit, the actions begin 2px under the pills and no point of a pill is
     * anybody else's (asked of the engine every 2px across and every 1px down); where a finger
     * has the actions in the flow (`pointer-coarse:`) they stand 10px under the pills, not 2px.
     */
    <div
      className={isOpen ? `${row} flex-wrap` : row}
      data-testid="answer-sources"
    >
      {shown.map((source, index) => (
        <SourcePill
          key={source.url}
          // The first one "+n" draws: the second in the row.
          ref={index === 1 ? firstOpened : undefined}
          source={source}
        />
      ))}
      {more > 0 ? (
        <button
          aria-label={t("{count} more sources", { count: more })}
          className={`${pill} shrink-0`}
          onClick={() => setIsOpen(true)}
          tabIndex={0}
          // "+2" is not a word: a pointer is told what it counts, as a screen reader is.
          title={t("{count} more sources", { count: more })}
          type="button"
        >
          +{more}
        </button>
      ) : null}
    </div>
  );
}

/** One source: the site's name, and the page behind it in a new window. */
function SourcePill({
  ref,
  source,
}: {
  ref: Ref<HTMLAnchorElement> | undefined;
  source: Source;
}) {
  const site = siteNameOf(source.host);
  return (
    <a
      /*
       * WHAT IT IS AND WHAT A PRESS DOES, since the pill shows neither: a site's name alone could
       * be anything, and nothing drawn says the app is about to be left. The page's title is the
       * description under that name, for a screen reader as for a pointer.
       */
      aria-label={t("Source: {site}, opens in a new tab", { site })}
      className={pill}
      href={source.url}
      ref={ref}
      rel="noopener noreferrer"
      tabIndex={0}
      target="_blank"
      title={source.title || undefined}
    >
      <IconWorld aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{site}</span>
    </a>
  );
}
