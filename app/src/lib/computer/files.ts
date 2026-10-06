import { HANDOFF_MAX_BYTES } from "@shared/workspace-files";
import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { own } from "@/lib/own";
import { RequestRefusedError } from "@/lib/refusals";

/**
 * A file in the Bot's folder, as the person's own screens ask about it and take it (phase 8, first
 * slice, 2026-10-02).
 *
 * Two addresses on the server (`server/src/computer/routes.ts`): one that says whether a path is a
 * file and how big, and one that IS the file. The second is never fetched from here — it is what a
 * link points at and what an `<img>` draws, and the server sends everything but the four pictures
 * as a download whatever asks for it.
 */

const folderOf = (botId: string) =>
  `/api/computers/${encodeURIComponent(botId)}/files`;

/** Where the file itself is: a download, or — `inline` — the picture a card draws of it. */
export function fileAddress(
  botId: string,
  path: string,
  options: { inline?: boolean } = {},
): string {
  const search = new URLSearchParams({ path });
  if (options.inline) search.set("inline", "1");
  return `${folderOf(botId)}/download?${search}`;
}

/**
 * What a card knows about its file once it has asked.
 *
 * `missing` is an ANSWER, not a failure: the path holds no file a button could hand over, and
 * asking again will say the same. That is what lets the card draw no button and stop, where a
 * computer that could not be reached is thrown instead — and offered again.
 */
export type FileOnHand =
  | { is: "there"; bytes: number }
  /** There, and more than one download hands over. The size is still worth saying. */
  | { is: "too_large"; bytes: number }
  | { is: "missing"; code: string };

/**
 * Why there is nothing to download, by the fact the server answered (the computer's own —
 * `agent-computer/src/codes.ts`). `t()` on a variable: `file-card.test.tsx` walks this table.
 */
export const FILE_CARD_SAID: Readonly<Record<string, string>> = {
  "laf:file_not_found": "This file is no longer in the Bot's folder.",
  "laf:file_wrong_kind": "This is a folder, not a file.",
  "laf:file_path_refused": "This path is outside the Bot's folder.",
  "laf:file_too_large": "This file is too large to download from here.",
};

/** The same, for a card: its own sentence for a code it knows, else that it could not be checked. */
export function fileCardSaid(code: string | null | undefined): string {
  const known = own(FILE_CARD_SAID, code);
  return known ? t(known) : t("The file could not be checked just now.");
}

/** The answers that are final: no file is at that path, and none will be on a second asking. */
const SETTLED = new Set([
  "laf:file_not_found",
  "laf:file_wrong_kind",
  "laf:file_path_refused",
]);

async function readFileOnHand(
  botId: string,
  path: string,
): Promise<FileOnHand> {
  const response = await fetch(
    `${folderOf(botId)}/info?${new URLSearchParams({ path })}`,
    { credentials: "include" },
  );
  const body = (await response.json().catch(() => null)) as {
    bytes?: unknown;
    code?: unknown;
  } | null;
  if (response.ok && typeof body?.bytes === "number") {
    return body.bytes > HANDOFF_MAX_BYTES
      ? { is: "too_large", bytes: body.bytes }
      : { is: "there", bytes: body.bytes };
  }
  const code = typeof body?.code === "string" ? body.code : null;
  if (code && SETTLED.has(code)) return { is: "missing", code };
  throw new RequestRefusedError(fileCardSaid(code), response.status, code);
}

export function fileOnHandQueryOptions(botId: string, path: string) {
  return queryOptions({
    queryKey: ["computer", botId, "file", path] as const,
    queryFn: () => readFileOnHand(botId, path),
    // A Bot can write the same path again, and the folder is emptied when an account leaves: a
    // card on screen for an afternoon should not go on saying what was true when it was drawn.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    // One more try is the difference between a computer that was restarting and one that is away;
    // the card offers the rest by hand.
    retry: 1,
  });
}
