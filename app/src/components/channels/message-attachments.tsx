import { type AttachmentPart, attachmentKindOf } from "@shared/attachments";
import { useState } from "react";
import { attachmentAddress } from "@/lib/attachments/upload";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { AttachmentKindIcon } from "./composer/attachment-chips";

/**
 * The files a person's message carried, above their words: a photo as itself, a sheet or a PDF as a
 * chip that saves it again. Drawn from the references the stored message keeps, so a reload shows
 * exactly what was sent — the files come from the server, not from this device's memory.
 */
export function MessageAttachments({
  channelId,
  attachments,
}: {
  /** Absent on a screen with no conversation to fetch from; the chips are then names only. */
  channelId?: string | undefined;
  attachments: readonly AttachmentPart[];
}) {
  return (
    <ul
      aria-label={t("Attached files")}
      className="mb-1 flex flex-wrap justify-end gap-2"
      data-testid="message-attachments"
    >
      {attachments.map((attachment) => {
        const kind = attachmentKindOf(attachment.mimeType) ?? "sheet";
        const address = channelId
          ? attachmentAddress(channelId, attachment.id)
          : null;
        if (kind === "image" && address) {
          return (
            <li key={attachment.id}>
              <Photo address={address} name={attachment.filename} />
            </li>
          );
        }
        const chip = (
          <>
            <AttachmentKindIcon
              className="size-4 shrink-0 text-muted-foreground"
              kind={kind}
            />
            <span className="min-w-0 max-w-[14rem] truncate">
              {attachment.filename}
            </span>
          </>
        );
        return (
          <li key={attachment.id}>
            {address ? (
              <a
                className="flex items-center gap-2 rounded-xl border-[0.5px] border-border bg-background px-3 py-2 text-sm hover:bg-muted"
                download={attachment.filename}
                href={address}
                title={t("Save {name}", { name: attachment.filename })}
              >
                {chip}
              </a>
            ) : (
              <span className="flex items-center gap-2 rounded-xl border-[0.5px] border-border px-3 py-2 text-sm">
                {chip}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A photo in the conversation, which a press makes large enough to read a receipt's small print.
 *
 * IN PLACE, NOT A LINK. A `_blank` link is handed to the person's own browser inside the desktop
 * shell (`lib/notifications/shell-links.ts`), and that browser has no session here: the photo would
 * open as a sign-in refusal. The app is the product, so the photo grows where it is.
 */
function Photo({ address, name }: { address: string; name: string }) {
  const [isLarge, setIsLarge] = useState(false);
  return (
    <button
      aria-expanded={isLarge}
      aria-label={
        isLarge ? t("Shrink {name}", { name }) : t("Open {name}", { name })
      }
      className="block cursor-zoom-in rounded-xl aria-expanded:cursor-zoom-out"
      onClick={() => setIsLarge((large) => !large)}
      type="button"
    >
      <img
        alt={name}
        className={cn(
          "rounded-xl border-[0.5px] border-border object-contain",
          isLarge
            ? "max-h-[80vh] max-w-[min(40rem,85vw)]"
            : "max-h-48 max-w-[min(18rem,70vw)]",
        )}
        loading="lazy"
        src={address}
      />
    </button>
  );
}
