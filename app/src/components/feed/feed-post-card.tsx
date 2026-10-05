import type { FeedPost } from "@shared/feed";
import {
  IconHeart,
  IconHeartFilled,
  IconMessage2,
  IconX,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { focusRing } from "@/components/ui/focus";
import { activeLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * ONE 소식 POST: its label, title and three or four lines, the pages it came from — and the three
 * presses (muse-shape plan §3.2; teardown §2 for the shape).
 *
 * 좋아요 and 숨기기 reach the next run: its instruction carries the titles pressed
 * (`server/src/routines/feed.ts`, `reactionsFor`). 이야기하기 opens the conversation with the post
 * attached by its id, not its title pasted.
 *
 * THE PRESSES ARE ICONS, EACH NAMED FOR ITS POST (2026-10-04). A heart, a speech bubble and the ×
 * this app already draws to put a thing away say what 좋아요, 이야기하기 and 숨기기 said in words
 * under every post; the words are in `aria-label` and the tooltip. 숨기기 sits where a card is put
 * away — its top corner — and the line that follows it still says what hiding does, with 되돌리기.
 *
 * "왜 이 소식" IS NOT DRAWN. It named the routine, the topic and the sites — and the topic is the
 * card's first word, the sites are the links above where it stood, and the routine is 소식. A line
 * that repeats the card says nothing a person can use.
 */
export function FeedPostCard({
  isNew,
  onDiscuss,
  onHide,
  onLike,
  post,
}: {
  /** Not seen before this visit: marked, once. */
  isNew: boolean;
  onDiscuss: () => void;
  onHide: () => void;
  onLike: () => void;
  post: FeedPost;
}) {
  const when = new Date(post.createdAt).toLocaleString(activeLocale, {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <article
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4"
      data-feed-post={post.id}
    >
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        {isNew ? (
          <span
            className="size-2 shrink-0 rounded-full bg-mark"
            data-feed-new
          />
        ) : null}
        <span className="font-medium text-foreground/80">{post.topic}</span>
        <span aria-hidden="true">·</span>
        <span>{when}</span>
        <Button
          aria-label={t("Hide “{title}”", { title: post.title })}
          className="-my-1.5 -mr-1.5 ml-auto text-muted-foreground"
          data-feed-hide
          onClick={onHide}
          size="icon-sm"
          title={t("Hide")}
          variant="ghost"
        >
          <IconX aria-hidden="true" />
        </Button>
      </div>
      <h3 className="font-semibold text-base leading-6">{post.title}</h3>
      <p className="whitespace-pre-line text-sm leading-6">{post.body}</p>
      {post.sources.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-sm">
          {post.sources.map((source) => (
            <li className="min-w-0 truncate" key={source.url}>
              <a
                className={cn(
                  "text-link underline-offset-4 hover:underline",
                  focusRing,
                )}
                href={source.url}
                rel="noreferrer"
                target="_blank"
              >
                {source.title}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="-mx-1.5 flex items-center gap-1">
        <Button
          aria-label={t("Like “{title}”", { title: post.title })}
          aria-pressed={post.liked}
          className={cn(post.liked && "text-destructive")}
          data-feed-like
          onClick={onLike}
          size="icon-sm"
          title={t("Like")}
          variant="ghost"
        >
          {post.liked ? (
            <IconHeartFilled aria-hidden="true" />
          ) : (
            <IconHeart aria-hidden="true" />
          )}
        </Button>
        <Button
          aria-label={t("Talk about “{title}”", { title: post.title })}
          data-feed-discuss
          onClick={onDiscuss}
          size="icon-sm"
          title={t("Talk about it")}
          variant="ghost"
        >
          <IconMessage2 aria-hidden="true" />
        </Button>
      </div>
    </article>
  );
}
