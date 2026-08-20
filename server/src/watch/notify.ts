/**
 * What is worth interrupting somebody for: a Bot that is blocked on them.
 *
 * The field's rule, adopted whole: a Bot blocked on you is worth a buzz, a Bot
 * that finished is worth one if you asked, and everything else a Bot does
 * while it works is not. This file carries the first clause — the moment a
 * boundary opens a question, one frame goes out — and the digest carries the
 * rest.
 *
 * Delivery is a separate concern. The frame is a webhook today and the
 * AlimTalk gateway once that channel clears review; a deployment with neither
 * gets a log line and loses nothing else, because the question itself still
 * waits on the approvals surface.
 */
import type { ApprovalRegistry } from "../computer/approvals";
import { lockScreenLine } from "./digest";

const SEND_TIMEOUT_MS = 10_000;

export type NotifyOptions = {
  /** POSTed `{kind, headline, botId, approvalId, question}` as JSON. */
  webhookUrl?: string;
};

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
    question: string;
  }): void => {
    const headline = lockScreenLine(
      `[LAF] 봇이 당신을 기다립니다 — ${pending.question}`,
    );
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
        question: pending.question,
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
    request(input) {
      const pending = registry.request(input);
      notify({
        id: pending.id,
        botId: input.botId,
        question: input.question,
      });
      return pending;
    },
  };
}
