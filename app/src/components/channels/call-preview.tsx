import { type CallPreview, previewLines } from "@/lib/call-preview";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * What an outward call will send, drawn under the question that asks about it.
 *
 * Shared by the line-level card and the room's card, for the reason the sentence above it is: one
 * press has to mean the same thing on both, and a person deciding about a mail or an 알림톡 is
 * deciding about who it reaches and what it says. The answer they give is bound to exactly this
 * call (the server's fingerprint), so this is the call they are shown.
 *
 * The text keeps its line breaks — an 알림톡 is laid out in lines — and scrolls inside the card
 * past a few of them rather than pushing the buttons off the screen.
 */
export const CallPreviewList = ({
  preview,
  toolRef,
}: {
  preview: CallPreview | undefined;
  /** `<server>/<tool>`, so a vendor's own codes can be named. */
  toolRef?: string | undefined;
}) => {
  if (!preview || preview.length === 0) return null;
  return (
    <dl
      aria-label={t("What it will send")}
      className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md bg-muted/60 px-2.5 py-2 text-xs"
    >
      {previewLines(preview, toolRef).map((line) => (
        <div className="contents" key={line.field}>
          <dt className="whitespace-nowrap text-muted-foreground">
            {line.label}
          </dt>
          <dd
            className={cn(
              "min-w-0 wrap-break-word",
              line.field === "text" &&
                "max-h-40 overflow-y-auto whitespace-pre-line",
            )}
          >
            {line.value}
            {line.note ? (
              <span className="text-muted-foreground">{` ${line.note}`}</span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
};
