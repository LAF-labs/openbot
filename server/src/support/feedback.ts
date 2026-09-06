/**
 * 문의·의견: what a person wrote to the people who run this product, and the door it leaves by.
 *
 * WHY THIS EXISTS. Everything else in this repository tells the person something; nothing let the
 * person tell the operator anything. The first customers are business owners who will not open a
 * GitHub issue, and the plan's fallback — a `mailto:` — leaves the message in a mail client that
 * the installed shell may not have and the operator may not read. So: a box in the app, a row on
 * the deployment, and the same alert webhook the fleet already watches (laf-control's `laf watch`
 * posts its transitions there), so a message arrives where the operator is already looking.
 *
 * THE ROW IS THE MESSAGE; THE OUTBOX ROW IS THE TELLING. `laf_feedback` is written first and stays
 * until the person leaves. The outbox row (`support.feedback`) is what records whether the webhook
 * took it, and the retention tick removes it after thirty days as it does every other notification.
 * A deployment with no `LAF_ALERT_WEBHOOK_URL` still keeps the row, and the route's answer says
 * honestly that nobody was told (`told: []`).
 *
 * THE SAME BODY SHAPE AS THE FLEET'S ALERTS (`laf-control/core/alerts.ts`): `text` for Slack and
 * Telegram, `content` with the same sentence for Discord, and a structured object beside them for
 * anything that parses. Korean, from a server that otherwise sends no prose, for the reason
 * `notifications/notify.ts` gives: there is no surface on the other end of a webhook to own the
 * words, and the person reading this one is the fleet's operator.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "../db/client";
import { lafFeedback } from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import type {
  NotificationAdapter,
  NotificationRecord,
  SupportFacts,
} from "../notifications/outbox";

/**
 * How much one message may hold. The launch plan's figure.
 *
 * Enforced on the route rather than in the column, so the refusal is a code the box can say
 * (`laf:feedback_too_long`) and not a database error somebody reads as "it broke".
 */
export const FEEDBACK_MAX_LENGTH = 2_000;

/** What goes into `delivered_via` when the alert webhook took a message. */
export const SUPPORT_DOOR = "support-webhook";

export type FeedbackInput = {
  userId: string;
  text: string;
  route?: string;
  failureCode?: string;
};

/** The two facts the route answers with, and the box says as 보냈습니다. */
export type FeedbackReceipt = {
  id: string;
  createdAt: Date;
};

export type FeedbackStore = {
  record: (input: FeedbackInput) => Promise<FeedbackReceipt>;
};

export function createFeedbackStore(database: Database): FeedbackStore {
  return {
    record: async (input) => {
      const [row] = await database
        .insert(lafFeedback)
        .values({
          id: randomUUID(),
          userId: input.userId,
          text: input.text,
          ...(input.route ? { route: input.route } : {}),
          ...(input.failureCode ? { failureCode: input.failureCode } : {}),
        })
        .returning({ id: lafFeedback.id, createdAt: lafFeedback.createdAt });
      if (!row) throw new Error("laf:feedback_not_recorded");
      return row;
    },
  };
}

/** The body the alert webhook receives. The same three-part shape as a fleet alert. */
export type SupportAlertBody = {
  text: string;
  content: string;
  feedback: {
    id: string;
    origin: string;
    text: string;
    route: string | null;
    failureCode: string | null;
    at: string;
  };
};

/**
 * The sentence, in the fleet alert's register: a `[LAF]` prefix, the fact, the origin.
 *
 * The message is on its own line under the heading so a chat client shows it whole, and the two
 * screen facts — when the person attached them — sit on one line after it, as facts: a path and a
 * code, which is all there is.
 */
export function supportAlertBody(
  facts: SupportFacts,
  origin: string,
  at: string,
): SupportAlertBody {
  const where = [
    facts.route ? `화면: ${facts.route}` : null,
    facts.failureCode ? `마지막 실패: ${facts.failureCode}` : null,
  ].filter((part): part is string => part !== null);
  const text = [
    `[LAF] 문의·의견 · ${origin || "(origin unset)"}`,
    facts.text,
    ...(where.length > 0 ? [where.join(" · ")] : []),
  ].join("\n");
  return {
    text,
    content: text,
    feedback: {
      id: facts.feedbackId,
      origin,
      text: facts.text,
      route: facts.route ?? null,
      failureCode: facts.failureCode ?? null,
      at,
    },
  };
}

/**
 * Bounded lower than the buzz webhook's ten seconds, because the route AWAITS this: the person
 * who pressed 보내기 is watching a spinner for as long as the operator's chat server takes to
 * answer, and a dead webhook must not hold them for ten seconds to say what it could say in five.
 */
const SEND_TIMEOUT_MS = 5_000;

export type SupportWebhookOptions = {
  webhookUrl: string;
  /** `PUBLIC_ORIGIN`: what the fleet knows this deployment by. Goes into the sentence. */
  origin: string;
  /** Injected in tests. Production passes neither. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/**
 * The alert webhook, as the one door a support row goes through.
 *
 * `accepts` is what keeps it away from every other row: a fleet operator's channel must not get
 * "a Bot is waiting on you" for every approval on every deployment. And it answers `ok` only on a
 * 2xx, unlike the buzz webhook, because this receiver is one the fleet's own tool already treats
 * that way (`livePostWebhook` in laf-control): a 404 from Slack is a message Slack did not take,
 * and a row that said otherwise would tell the operator they had been told when they had not.
 */
export function createSupportWebhookAdapter(
  options: SupportWebhookOptions,
): NotificationAdapter {
  const send = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  return {
    name: SUPPORT_DOOR,
    accepts: (kind) => kind === "support.feedback",
    deliver: async (record: NotificationRecord) => {
      if (!record.support) return false;
      try {
        const response = await send(options.webhookUrl, {
          method: "POST",
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            supportAlertBody(
              record.support,
              options.origin,
              now().toISOString(),
            ),
          ),
        });
        return response.ok;
      } catch (error) {
        // One fact for the operator's log, and never the message: the row has it.
        log.warn("support_webhook_failed", {
          feedback: record.support.feedbackId,
          reason: describeFailure(error),
        });
        return false;
      }
    },
  };
}
