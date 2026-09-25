import type { InputContent } from "@ag-ui/core";
import type { AttachmentPart } from "@shared/attachments";

/**
 * A person's message as it goes into the thread: the words alone, exactly as before, unless files
 * ride with it — then the files first, the way a photo is handed across a counter before the
 * question about it, and the words after.
 *
 * A plain string whenever there is no file, so every message without one is byte for byte what it
 * always was: the provider's cache holds those bytes, and the transcript's readers expect a string.
 */
export function contentOf(
  text: string,
  attachments: readonly AttachmentPart[],
): string | InputContent[] {
  if (attachments.length === 0) return text;
  return [...attachments, ...(text ? [{ type: "text" as const, text }] : [])];
}
