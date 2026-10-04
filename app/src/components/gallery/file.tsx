import { FILE_CARD, GALLERY_CONFIRMATIONS } from "@shared/tools/gallery";
import { fileNameOf, rasterImageTypeOf } from "@shared/workspace-files";
import { IconDownload } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Button, buttonVariants } from "@/components/ui/button";
import { sizeLabel } from "@/lib/attachments/upload";
import {
  fileAddress,
  fileCardSaid,
  fileOnHandQueryOptions,
} from "@/lib/computer/files";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { t } from "@/lib/i18n";
import { GalleryFrame } from "./frame";

export const FileCardProps = z.object({
  path: z
    .string()
    .describe(
      "The file's path in your workspace, exactly as you wrote or listed it, e.g. reports/sales.csv",
    ),
  note: z
    .string()
    .optional()
    .describe("One short line in the person's language: what this file is"),
});

type FileArgs = z.infer<typeof FileCardProps>;

/** How long a path has to stop changing before the card asks about it. */
const SETTLE_MS = 400;

/**
 * A value once it has stopped changing.
 *
 * A card is drawn while its call is still being written, and `path` arrives a few characters at a
 * time: `re`, `reports/`, `reports/sal`… Asked about as it came, every one of those is a request to
 * the Bot's computer for a file that does not exist — and a card that says "gone" twenty times
 * before it says "12KB". A card drawn from a stored conversation has its whole path at once, and
 * that one is not made to wait: the first value is taken as it is.
 */
function useSettled<T>(value: T): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}

/**
 * A file from the Bot's folder, handed to the person: its name, its size, and 내려받기.
 *
 * THE CARD ASKS FOR ITSELF. The turn looks for the file before it tells the Bot the card is on
 * screen (`server/src/turns/chat-tools.ts`), but the card cannot lean on that: a file that was
 * there on Tuesday can be gone on Friday — written over, or emptied with the account — and a card
 * drawn by a turn from before 2026-10-05 may be one a window confirmed without looking. So what is
 * drawn is what the folder says now, and a file that is not there gets a sentence and no button: a
 * control that does nothing is not drawn.
 *
 * THE BUTTON IS A PLAIN LINK to the server's download route, which answers every file as an
 * attachment whatever asks — a press saves the file and never opens it. Not `_blank`: inside the
 * desktop shell that hands the address to the person's own browser, which has no session here.
 *
 * A PICTURE IS SHOWN, for the four kinds a browser paints from bytes alone. The server decides
 * that for itself from the bytes (`?inline=1` is only asking); one it will not draw is a broken
 * image here, and is taken down rather than left as the browser's torn-page glyph.
 */
export function FileCard({ path, note }: Partial<FileArgs>) {
  const botId = useDeclaredBotId();
  const written = path?.trim() ?? "";
  const asked = useSettled(written);
  const isSettling = asked !== written;
  const file = useQuery({
    ...fileOnHandQueryOptions(botId ?? "", asked),
    enabled: Boolean(botId && asked),
  });
  const [brokenPicture, setBrokenPicture] = useState<string | null>(null);

  if (!written) {
    return (
      <GalleryFrame title={t("File")}>
        <p className="text-muted-foreground text-sm">
          {t("Finding the file…")}
        </p>
      </GalleryFrame>
    );
  }

  const name = fileNameOf(written);
  // What the folder said about THIS path: an answer for a path still being written is not one.
  const found = !isSettling && botId ? file.data : undefined;
  // Asked and not answered — or drawn where no Bot is in front of the person, so nothing was asked.
  const isUnchecked = !botId || (!isSettling && !found && file.isError);
  const there = found?.is === "there" ? found : null;
  const address = botId && there ? fileAddress(botId, asked) : null;
  const picture =
    botId && there && rasterImageTypeOf(name)
      ? fileAddress(botId, asked, { inline: true })
      : null;
  const handleRetry = () => void file.refetch();

  return (
    <GalleryFrame
      action={
        address ? (
          <a
            className={buttonVariants({ size: "sm", variant: "outline" })}
            data-file-download
            download={name}
            href={address}
            title={t("Save {name}", { name })}
          >
            <IconDownload aria-hidden="true" />
            {t("Download")}
          </a>
        ) : undefined
      }
      caption={note}
      title={name}
    >
      {picture && brokenPicture !== picture ? (
        <img
          alt={name}
          className="mb-2 max-h-64 max-w-full rounded-lg border-[0.5px] border-border object-contain"
          loading="lazy"
          onError={() => setBrokenPicture(picture)}
          src={picture}
        />
      ) : null}
      {found?.is === "there" ? (
        <p className="text-muted-foreground text-sm tabular-nums">
          {sizeLabel(found.bytes)}
        </p>
      ) : found?.is === "too_large" ? (
        <p
          className="text-muted-foreground text-sm"
          data-file-state="too_large"
        >
          <span className="tabular-nums">{sizeLabel(found.bytes)}</span>
          {" · "}
          {fileCardSaid("laf:file_too_large")}
        </p>
      ) : found?.is === "missing" ? (
        <p className="text-muted-foreground text-sm" data-file-state="missing">
          {fileCardSaid(found.code)}
        </p>
      ) : isUnchecked ? (
        <div
          className="flex flex-wrap items-center gap-2"
          data-file-state="unchecked"
        >
          <p className="text-muted-foreground text-sm">{fileCardSaid(null)}</p>
          {botId ? (
            <Button onClick={handleRetry} size="xs" variant="outline">
              {t("Try again")}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          {t("Checking the file…")}
        </p>
      )}
    </GalleryFrame>
  );
}

export const GALLERY: GalleryComponent[] = [
  {
    name: FILE_CARD,
    title: "File",
    kind: "card",
    description:
      "Hand the person a file from your workspace: a card with its name, its size and a download button, and the picture itself if it is one. Use it for a file you wrote or downloaded that they asked for, instead of pasting what is in it. The file must already be in your workspace.",
    parameters: FileCardProps,
    Component: FileCard as GalleryComponent["Component"],
    confirmation: GALLERY_CONFIRMATIONS[FILE_CARD],
  },
];
