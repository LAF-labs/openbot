import type { AttachmentKind, AttachmentPart } from "@shared/attachments";
import {
  IconFileSpreadsheet,
  IconFileTypePdf,
  IconLoader2,
  IconPhoto,
  IconX,
} from "@tabler/icons-react";
import { sizeLabel } from "@/lib/attachments/upload";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** A file in the composer, from the moment it is picked until the message it rides in is sent. */
export type PendingAttachment = {
  localId: string;
  name: string;
  kind: AttachmentKind;
  bytes: number;
  status: "uploading" | "ready";
  /** Set once the server kept it: what the message carries. */
  part?: AttachmentPart;
  /** A photo's own pixels, from this device, while it is only in the composer. */
  preview?: string;
};

export function AttachmentKindIcon({
  kind,
  className,
}: {
  kind: AttachmentKind;
  className?: string;
}) {
  if (kind === "image") return <IconPhoto className={className} />;
  if (kind === "pdf") return <IconFileTypePdf className={className} />;
  return <IconFileSpreadsheet className={className} />;
}

/**
 * The files waiting to be sent, one chip each: a photo's thumbnail or a file's kind, the name, and a
 * way to take it back out. An upload still running says so, and holds the send button until it lands.
 */
export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: readonly PendingAttachment[];
  onRemove: (localId: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul
      aria-label={t("Attached files")}
      className="mb-2 flex flex-wrap gap-2"
      data-testid="composer-attachments"
    >
      {attachments.map((attachment) => (
        <li
          className={cn(
            "flex max-w-full items-center gap-2 rounded-xl border-[0.5px] border-border bg-background py-1 pr-1 pl-1.5 text-sm",
            attachment.status === "uploading" && "opacity-70",
          )}
          key={attachment.localId}
        >
          {attachment.preview ? (
            <img
              alt=""
              className="size-8 shrink-0 rounded-md object-cover"
              src={attachment.preview}
            />
          ) : (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground/5">
              <AttachmentKindIcon
                className="size-4 text-muted-foreground"
                kind={attachment.kind}
              />
            </span>
          )}
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="max-w-[12rem] truncate">{attachment.name}</span>
            <span className="text-muted-foreground text-xs">
              {attachment.status === "uploading"
                ? t("Attaching…")
                : sizeLabel(attachment.bytes)}
            </span>
          </span>
          {attachment.status === "uploading" ? (
            <IconLoader2
              aria-hidden
              className="size-4 shrink-0 animate-spin text-muted-foreground"
            />
          ) : null}
          <button
            aria-label={t("Remove {name}", { name: attachment.name })}
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            onClick={() => onRemove(attachment.localId)}
            title={t("Remove {name}", { name: attachment.name })}
            type="button"
          >
            <IconX className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}
