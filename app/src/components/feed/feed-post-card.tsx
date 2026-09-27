import { IconHeart, IconHeartFilled, IconMessage2 } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { focusRing } from "@/components/ui/focus";
import { type FeedPost, whyLine } from "@/lib/feed/queries";
import { activeLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * ONE 소식 POST: its label, title and three or four lines, the pages it came from, why it is here —
 * and the three presses (muse-shape plan §3.2; teardown §2 for the shape).
 *
 * 좋아요 and 숨기기 reach the next run: its instruction carries the titles pressed
 * (`server/src/routines/feed.ts`, `reactionsFor`). 이야기하기 opens the conversation with the post
 * attached by its id, not its title pasted.
 */
export function FeedPostCard({
  isNew,
  onDiscuss,
  onHide,
  onLike,
  post,
  routineName,
}: {
  /** Not seen before this visit: marked, once. */
  isNew: boolean;
  onDiscuss: () => void;
  onHide: () => void;
  onLike: () => void;
  post: FeedPost;
  routineName: string | null;
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
      <p className="flex items-center gap-2 text-muted-foreground text-xs">
        {isNew ? (
          <span
            className="size-2 shrink-0 rounded-full bg-mark"
            data-feed-new
          />
        ) : null}
        <span className="font-medium text-foreground/80">{post.topic}</span>
        <span aria-hidden="true">·</span>
        <span>{when}</span>
      </p>
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
      <p className="text-muted-foreground text-xs" data-feed-why>
        {whyLine(post, routineName)}
      </p>
      <div className="-mx-2 mt-1 flex flex-wrap items-center gap-1">
        <Button
          aria-pressed={post.liked}
          className={cn(post.liked && "text-destructive")}
          data-feed-like
          onClick={onLike}
          size="sm"
          variant="ghost"
        >
          {post.liked ? (
            <IconHeartFilled aria-hidden="true" />
          ) : (
            <IconHeart aria-hidden="true" />
          )}
          {t("Like")}
        </Button>
        <Button data-feed-discuss onClick={onDiscuss} size="sm" variant="ghost">
          <IconMessage2 aria-hidden="true" />
          {t("Talk about it")}
        </Button>
        <Button
          className="ml-auto text-muted-foreground"
          data-feed-hide
          onClick={onHide}
          size="sm"
          variant="ghost"
        >
          {t("Hide")}
        </Button>
      </div>
    </article>
  );
}
