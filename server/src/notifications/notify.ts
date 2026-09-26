/**
 * What is worth interrupting somebody for: a Bot that is blocked on them.
 *
 * The field's rule, adopted whole: a Bot blocked on you is worth a buzz, a Bot
 * that finished is worth one if you asked, and everything else a Bot does
 * while it works is not. This file carries the first clause — the moment a
 * boundary opens a question, one row goes into the outbox.
 *
 * IT USED TO BE THE DELIVERY TOO. The decorator below held a `fetch` at the webhook, and that was
 * the whole of "somebody has been told": no record, no second door, and nothing that could answer
 * whether the question ever reached a person. Delivery now belongs to `outbox.ts`, which writes the
 * row and offers it to every door; the webhook is one of those doors and lives at the bottom of
 * this file, unchanged in what it sends except for the outbox id.
 *
 * A DEPLOYMENT WITH NO OUTBOX STILL BUZZES. Called without one — a test, an embedding that wired
 * only the registry — the decorator posts the webhook itself, exactly as it did before. That is not
 * a legacy path kept out of politeness: the alternative is that adding a table silently turned off
 * the only notification a deployment had.
 */
import type { ApprovalRegistry, AskSubject } from "../computer/approvals";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import type {
  NotificationAdapter,
  NotificationKind,
  NotificationOutbox,
  NotificationRecord,
} from "./outbox";

const SEND_TIMEOUT_MS = 10_000;

export type NotifyOptions = {
  /** POSTed `{kind, headline, botId, approvalId, subject}` as JSON. */
  webhookUrl?: string;
  /**
   * The outbox, when this deployment has one.
   *
   * Given one, the decorator writes a row and the outbox's own adapters deliver it — the webhook
   * among them. Absent, the webhook above is posted from here. Never both: a deployment that did
   * both would buzz twice for one question.
   */
  outbox?: NotificationOutbox;
};

/** One line, short enough for a lock screen: newlines and fences flattened. */
function lockScreenLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/*
 * THE HEADLINE NAMES NO ACTION, AND THAT IS THE HONEST VERSION.
 *
 * It used to interpolate the approval's `question`, which was an English sentence assembled by
 * the policy — so a lock screen said "봇이 당신을 기다립니다 — The Bot wants to press “출금 승인”".
 * That sentence no longer exists: the server sends facts and each surface says them in its own
 * words (docs/laf/redesign-2026-09.md §4-2). A webhook is a surface this repository does not
 * own, so it gets the facts in `subject` and writes its own line. What is safe to say from here
 * is the part that is true of every one of these, which is that somebody is being waited on.
 *
 * Korean, from a server that otherwise sends no prose at all, for the same reason: there is no
 * surface on the other end of a webhook to own the words.
 */
const HEADLINES: Record<NotificationKind, string> = {
  "approval.requested": "[LAF] 봇이 사장님 승인을 기다려요",
  "approval.expired": "[LAF] 승인 요청이 시간이 지나 닫혔습니다",
  "run.needs_you": "[LAF] 봇이 사장님 도움을 기다려요",
  "run.finished": "[LAF] 봇이 일을 마쳤습니다",
  "run.failed": "[LAF] 봇이 끝내지 못했습니다",
  "routine.paused": "[LAF] 결과를 한동안 보지 않은 루틴을 멈췄습니다",
  // Never posted from here: a support or fleet row goes only to the door that asked for it
  // (`outbox.ts` `deliver`), and this door did not. The entries keep the table total.
  "support.feedback": "[LAF] 문의·의견",
  "support.answer_rating": "[LAF] 답변이 아쉬워요",
  "fleet.account_deleted": "[LAF] 계정 삭제",
};

export function headlineFor(kind: NotificationKind): string {
  return lockScreenLine(HEADLINES[kind] ?? HEADLINES["approval.requested"]);
}

/**
 * The registry, with the outbox attached to `request`.
 *
 * A decorator rather than a change to the registry, because the registry is
 * deliberately pure bookkeeping — what is pending and what a yes covers — and
 * whether anybody's phone vibrates is a deployment concern layered on top.
 * Fire-and-forget: a notification that fails must never fail the question.
 */
export function withApprovalNotifications(
  registry: ApprovalRegistry,
  options: NotifyOptions,
): ApprovalRegistry {
  const notify = (pending: {
    id: string;
    botId: string;
    actor: string;
    subject: AskSubject;
  }): void => {
    if (options.outbox) {
      void options.outbox
        .enqueue({
          kind: "approval.requested",
          botId: pending.botId,
          // Who was driving when the boundary stopped. In this deployment that is the person the
          // question is for; routing a question to somebody other than the owner is the later,
          // multi-person feature the answering route already says it is not.
          userId: pending.actor,
          approvalId: pending.id,
          subject: pending.subject,
        })
        .catch(() => undefined);
      return;
    }
    const headline = headlineFor("approval.requested");
    if (!options.webhookUrl) {
      console.info(`[notify] ${headline}`);
      return;
    }
    void postWebhook(options.webhookUrl, {
      kind: "approval.requested",
      headline,
      botId: pending.botId,
      approvalId: pending.id,
      subject: pending.subject,
    });
  };

  return {
    ...registry,
    async request(input) {
      const pending = await registry.request(input);
      notify({
        id: pending.id,
        botId: input.botId,
        actor: input.actor,
        subject: input.subject,
      });
      return pending;
    },
  };
}

/**
 * The webhook, as one door of the outbox.
 *
 * The same body it has always sent, plus `notificationId` so that whatever is on the other end can
 * say which row it was reacting to — the one thing a receiver could not do before, because there
 * was no row.
 *
 * It reports success on a 2xx and on nothing else. It used to report success on any answer at all,
 * a 500 included, on the argument that the frame had left this process — but a 500 is not silence
 * about what the receiver did, it is the receiver saying it did not take it, and the row then said
 * `deliveredVia: ["webhook"]` about a buzz nobody got (review 2026-09-26). What happened AFTER a 2xx
 * is still not knowable from here and is not claimed; the fleet and 알림톡 doors already read the
 * answer the same way.
 */
export function createWebhookAdapter(webhookUrl: string): NotificationAdapter {
  return {
    name: "webhook",
    deliver: async (record: NotificationRecord) =>
      postWebhook(webhookUrl, {
        kind: record.kind,
        headline: headlineFor(record.kind),
        botId: record.botId,
        ...(record.approvalId ? { approvalId: record.approvalId } : {}),
        ...(record.channelId ? { channelId: record.channelId } : {}),
        ...(record.subject ? { subject: record.subject } : {}),
        // A `run.failed` row's facts: which routine, and the same code the transcript line uses.
        ...(record.run ? { run: record.run } : {}),
        // A `routine.paused` row's facts: which routines stopped, why, and how much was unread.
        ...(record.pause ? { pause: record.pause } : {}),
        notificationId: record.id,
      }),
  };
}

async function postWebhook(
  webhookUrl: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      // The status, never the body: a receiver's error page is somebody else's words.
      log.warn("webhook_refused", { status: response.status });
    }
    return response.ok;
  } catch (error) {
    console.error("[notify] approval buzz failed:", describeFailure(error));
    return false;
  }
}
