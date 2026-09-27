import type { FeedQuotePart } from "@shared/feed";
import { IconLayoutList, IconX } from "@tabler/icons-react";
import { focusRing } from "@/components/ui/focus";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * A 소식 post a message is about (이야기하기), drawn as a chip: above the box while it is being
 * written, with a way to take it off, and above the person's words once sent. The title is the
 * part's own — the model is shown the post itself (`server/src/feed/quote.ts`).
 */
export function FeedQuoteChip({
  onRemove,
  part,
}: {
  onRemove?: () => void;
  part: FeedQuotePart;
}) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-muted/60 py-1 pr-1 pl-2 text-muted-foreground text-xs"
      data-feed-quote
    >
      <IconLayoutList aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="shrink-0">{t("About this update")}</span>
      <span className="min-w-0 truncate font-medium text-foreground">
        {part.filename}
      </span>
      {onRemove ? (
        <button
          aria-label={t("Remove “{title}”", { title: part.filename })}
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-foreground",
            focusRing,
          )}
          onClick={onRemove}
          type="button"
        >
          <IconX aria-hidden="true" className="size-3.5" />
        </button>
      ) : (
        <span className="w-1" />
      )}
    </span>
  );
}
