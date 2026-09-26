/**
 * The two doors a file goes through: in, from the composer, and back out, to the chip that shows it.
 *
 * Under the CHANNEL, like a browsing task's picture (`channels/transcript-routes.ts`), because the
 * channel is where membership is enforced and it names the Bot whose computer a file is filed on.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  ATTACHMENT_MAX_BYTES,
  isAttachmentId,
} from "../../../shared/attachments";
import type { AppVariables } from "../auth/guards";
import type { ChannelStore } from "../channels/types";
import type { AttachmentRefusal, AttachmentService } from "./service";

/** A refusal's status. A code and no sentence, as every channel refusal is answered. */
const STATUS: Record<AttachmentRefusal, 400 | 413 | 415 | 422 | 503> = {
  "laf:attachment_empty": 400,
  "laf:attachment_too_large": 413,
  "laf:attachment_type_unsupported": 415,
  "laf:attachment_image_unsupported": 415,
  "laf:attachment_unreadable": 422,
  // The file is fine; nothing here may read it right now (no converter). Not the person's doing.
  "laf:attachment_converter_unavailable": 503,
};

/** Room for the multipart envelope around the largest file allowed. */
const ENVELOPE_BYTES = 256 * 1024;

/** RFC 6266/5987: the stored name is Korean more often than not, so it goes percent-encoded. */
function dispositionOf(kind: "inline" | "attachment", name: string): string {
  return `${kind}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function createAttachmentRoutes(
  service: AttachmentService,
  channels: Pick<ChannelStore, "get">,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post(
    "/:channelId/attachments",
    requireUser,
    /*
     * BEFORE THE BODY IS READ. A size checked after `parseBody` has already held the whole upload in
     * memory; this stops reading at the limit, whatever `content-length` claimed.
     */
    bodyLimit({
      maxSize: ATTACHMENT_MAX_BYTES + ENVELOPE_BYTES,
      onError: (context) =>
        context.json(
          {
            error: "laf:attachment_too_large",
            code: "laf:attachment_too_large",
          },
          413,
        ),
    }),
    async (context) => {
      const actor = context.var.actor;
      const channel = await channels.get(actor, context.req.param("channelId"));
      const botId = channel?.active ? channel.agentIds[0] : undefined;
      if (!channel || !botId) {
        return context.json(
          { error: "laf:channel_not_found", code: "laf:channel_not_found" },
          404,
        );
      }
      const form = await context.req.parseBody().catch(() => null);
      const file = form?.file;
      if (!(file instanceof File)) {
        return context.json(
          { error: "laf:attachment_empty", code: "laf:attachment_empty" },
          400,
        );
      }
      const received = await service.receive({
        userId: actor.id,
        channelId: channel.id,
        botId,
        claimedName: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      if (!received.ok) {
        return context.json(
          { error: received.code, code: received.code },
          STATUS[received.code],
        );
      }
      return context.json({ attachment: received.attachment }, 201);
    },
  );

  routes.get(
    "/:channelId/attachments/:attachmentId",
    requireUser,
    async (context) => {
      const id = context.req.param("attachmentId");
      const channel = isAttachmentId(id)
        ? await channels.get(context.var.actor, context.req.param("channelId"))
        : null;
      const file = channel
        ? await service.file(context.var.actor.id, channel.id, id)
        : null;
      if (!file) {
        return context.json(
          {
            error: "laf:attachment_not_found",
            code: "laf:attachment_not_found",
          },
          404,
        );
      }
      const isImage = file.mimeType.startsWith("image/");
      return context.body(new Uint8Array(file.data), 200, {
        "content-type": file.mimeType,
        // A photo is drawn in the chat; anything else is saved, never rendered by this origin.
        "content-disposition": dispositionOf(
          isImage ? "inline" : "attachment",
          file.name,
        ),
        "x-content-type-options": "nosniff",
        // Nothing this origin serves from here may run: a file is data even when it is opened.
        "content-security-policy": "default-src 'none'; sandbox",
        // Never changes once kept. Private: it is somebody's receipt.
        "cache-control": "private, max-age=86400",
      });
    },
  );

  return routes;
}
