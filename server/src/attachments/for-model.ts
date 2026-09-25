/**
 * A message's attachments, turned into what the model reads, on the way to the endpoint.
 *
 * The transcript keeps a reference per file (an AG-UI `binary` part, `shared/attachments.ts`); the
 * endpoint is handed the file's text, or the photo itself as an AG-UI `image` part, in its place.
 * The same bytes on every turn — the row's `model_text` never changes and neither does the photo —
 * so a conversation with a receipt in it is served from the provider's cache like any other.
 *
 * ON THE FETCH, NOT IN THE MIDDLEWARE, for the reason the trial's day is judged there
 * (`copilot.ts`): finding a file reads the database, and the middleware answers synchronously.
 * A run with no attachment in it is passed through untouched — the body is not even parsed.
 */
import {
  type AttachmentPart,
  isAttachmentPart,
} from "../../../shared/attachments";
import { missingAttachmentText } from "../../../shared/prompt/attachments.ko";
import type { AgentFetch } from "../channels/stall-guard";
import type { AttachmentForModel, AttachmentService } from "./service";

type Part = Record<string, unknown> & { type: string };

/** One message's parts, each attachment replaced by its text — and, for a photo, the photo. */
export function expandAttachments(
  content: readonly Part[],
  found: ReadonlyMap<string, AttachmentForModel>,
): Part[] {
  return content.flatMap((part): Part[] => {
    if (!isAttachmentPart(part)) return [part];
    const file = found.get(part.id);
    if (!file) {
      return [{ type: "text", text: missingAttachmentText(part.filename) }];
    }
    const text: Part = { type: "text", text: file.modelText };
    if (!file.image) return [text];
    return [
      text,
      {
        type: "image",
        source: { type: "data", value: file.image, mimeType: file.mimeType },
      },
    ];
  });
}

type RunBody = { messages?: Array<{ role?: string; content?: unknown }> };

function attachmentsIn(body: RunBody): AttachmentPart[] {
  return (body.messages ?? []).flatMap((message) =>
    message.role === "user" && Array.isArray(message.content)
      ? message.content.filter(isAttachmentPart)
      : [],
  );
}

export function withAttachments(
  service: Pick<AttachmentService, "forModel">,
  botId: string,
  inner: AgentFetch,
): AgentFetch {
  return async (url, requestInit) => {
    const raw = requestInit.body;
    // The cheap test first: a run whose body never mentions a binary part carries no attachment.
    if (typeof raw !== "string" || !raw.includes('"binary"')) {
      return inner(url, requestInit);
    }
    let body: RunBody;
    try {
      body = JSON.parse(raw) as RunBody;
    } catch {
      return inner(url, requestInit);
    }
    const parts = attachmentsIn(body);
    if (parts.length === 0) return inner(url, requestInit);
    const found = await service.forModel(botId, [
      ...new Set(parts.map((part) => part.id)),
    ]);
    const messages = (body.messages ?? []).map((message) =>
      message.role === "user" && Array.isArray(message.content)
        ? {
            ...message,
            content: expandAttachments(message.content as Part[], found),
          }
        : message,
    );
    return inner(url, {
      ...requestInit,
      body: JSON.stringify({ ...body, messages }),
    });
  };
}
