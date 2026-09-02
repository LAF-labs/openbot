/**
 * What is worth interrupting somebody for: a Bot that is blocked on them.
 *
 * The field's rule, adopted whole: a Bot blocked on you is worth a buzz, a Bot
 * that finished is worth one if you asked, and everything else a Bot does
 * while it works is not. This file carries the first clause — the moment a
 * boundary opens a question, one frame goes out.
 *
 * Delivery is a separate concern. The frame is a webhook today and the
 * AlimTalk gateway once that channel clears review; a deployment with neither
 * gets a log line and loses nothing else, because the question itself still
 * waits on the approvals surface.
 */
import type { ApprovalRegistry, AskSubject } from "../computer/approvals";

const SEND_TIMEOUT_MS = 10_000;

export type NotifyOptions = {
  /** POSTed `{kind, headline, botId, approvalId, subject}` as JSON. */
  webhookUrl?: string;
};

/** One line, short enough for a lock screen: newlines and fences flattened. */
function lockScreenLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The registry, with the buzz attached to `request`.
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
    subject: AskSubject;
  }): void => {
    /*
     * THE HEADLINE NAMES NO ACTION, AND THAT IS THE HONEST VERSION.
     *
     * It used to interpolate the approval's `question`, which was an English sentence assembled by
     * the policy — so a lock screen said "봇이 당신을 기다립니다 — The Bot wants to press “출금 승인”".
     * That sentence no longer exists: the server sends facts and each surface says them in its own
     * words (docs/laf/redesign-2026-09.md §4-2). A webhook is a surface this repository does not
     * own, so it gets the facts in `subject` and writes its own line. What is safe to say from here
     * is the part that is true of every one of these, which is that somebody is being waited on.
     */
    const headline = lockScreenLine("[LAF] 봇이 당신을 기다립니다");
    if (!options.webhookUrl) {
      console.info(`[notify] ${headline}`);
      return;
    }
    void fetch(options.webhookUrl, {
      method: "POST",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "approval.requested",
        headline,
        botId: pending.botId,
        approvalId: pending.id,
        subject: pending.subject,
      }),
    }).catch((error: unknown) => {
      console.error(
        "[notify] approval buzz failed:",
        error instanceof Error ? error.message : error,
      );
    });
  };

  return {
    ...registry,
    async request(input) {
      const pending = await registry.request(input);
      notify({
        id: pending.id,
        botId: input.botId,
        subject: input.subject,
      });
      return pending;
    },
  };
}
