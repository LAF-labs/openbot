/**
 * HOURLY CURATION — every new line a Bot wrote is checked against the owner's own words.
 *
 * A Bot's `remember` is the model deciding what is true about somebody's business, from a turn that
 * may have been reading a web page. Until this, whatever it wrote stood until the owner noticed it on
 * 수첩. Now, once an hour and behind every conversation, each line the Bot wrote since the last run
 * is put to a judge beside the owner messages around the one it was learning from
 * (`evidence_message_id`, taken by the server when the line was written):
 *
 *   - said by the owner (or asked by the owner to be kept) → CONFIRMED BY EVIDENCE: the support is
 *     kept as its confidence, and the evidence moves to the message that actually says it. Not the
 *     owner's confirmation (`confirmed_at`), which only the owner gives on 수첩.
 *   - not said → DROPPED, on record (`forgotten_by = curation`, `unsupported`).
 *   - a restatement of a line the owner forgot, learned from words the owner said BEFORE forgetting
 *     it → DROPPED (`restated_forgotten`): `remember` refuses the forgotten line word for word, and
 *     this catches it reworded. Said again after the forgetting, it is the owner telling it anew.
 *   - a newer statement of something an older Bot line said → the older one is SUPERSEDED
 *     (`replaced_by`, `supersedes`). Never an owner's line: the owner's word is changed on 수첩.
 *
 * THE JUDGE is compaction's: Jev when the privacy switch is on, the server model in Jev's shape when
 * it is off or cannot answer (`computer/decision-askers.ts`). A run whose judge cannot answer decides
 * nothing and drops nothing; the lines wait for the next hour. A line with nothing to check against
 * (written before evidence existed, or in a thread no longer held) is marked checked and left as the
 * Bot's inference — unverifiable is not the same as unsupported.
 *
 * OFF THE CRITICAL PATH, AND QUIET. What it drops leaves the prompt at the next epoch, not now: the
 * epoch logic reads a curation's drop as "gone quietly" (`CarriedMemories.retired`), so a background
 * job never costs a running conversation its cache. Every run leaves a receipt per Bot
 * (`memory-receipts.ts`), and 오늘 shows the ones that changed something.
 */
import { and, asc, eq, isNull, lt } from "drizzle-orm";
import {
  EVIDENCE_EXCERPT_LENGTH,
  EVIDENCE_KEEP,
} from "../../../shared/notebook";
import type { StampedMessage } from "../context/day-close";
import { redactText } from "../context/judge-redaction";
import type { JevAsker } from "../context/vendor/fast-jev-compaction/index";
import type { Database } from "../db/client";
import { agentMemories } from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import { recordMemoryReceipt } from "./memory-receipts";
import { type MemoryEvidenceInput, ownerForgottenRows } from "./memory-store";

/** A line is left alone this long after it was written: the turn that wrote it may still be going. */
export const CURATION_SETTLE_MS = 10 * 60_000;
/** The most lines one run looks at. More wait for the next hour. */
export const CURATION_BATCH = 40;
/** The owner messages a line is checked against: the one it was learned from and three before it. */
const OWNER_MESSAGES = 4;
/** An older line is superseded only when the judge is this sure. Retiring a true line costs more. */
export const SUPERSEDE_AT = 0.7;
/** A line restating a forgotten one is dropped at this. */
const RESTATED_AT = 0.5;
/** The older lines one check may name as superseded. */
const OLDER_LINES = 30;
/** How much of one owner message the judge reads. */
const MESSAGE_CHARS = 600;

export type CurationRun = {
  agentId: string;
  checked: number;
  confirmed: number;
  dropped: number;
  superseded: number;
  unchecked: number;
  arm: string;
};

export type MemoryCurator = { runOnce(): Promise<CurationRun[]> };

type Candidate = {
  id: string;
  agentId: string;
  ownerUserId: string;
  content: string;
  createdAt: Date;
  evidenceThreadId: string | null;
  evidenceMessageId: string | null;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text"
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

/** The owner's words as evidence keeps them: redacted, on one line, short. */
export function excerptOf(text: string): string | null {
  const one = redactText(text).replace(/\s+/g, " ").trim();
  if (!one) return null;
  return one.length > EVIDENCE_EXCERPT_LENGTH
    ? `${one.slice(0, EVIDENCE_EXCERPT_LENGTH - 1)}…`
    : one;
}

/**
 * The owner messages up to and including `messageId`, newest last, with when each was first seen
 * (null for a message from before stamps). Null when the thread does not hold `messageId`.
 */
export function ownerMessagesTo(
  history: readonly StampedMessage[],
  messageId: string,
  count = OWNER_MESSAGES,
): Array<{ id: string; text: string; at: number | null }> | null {
  const at = history.findIndex((message) => message.id === messageId);
  if (at < 0) return null;
  return history
    .slice(0, at + 1)
    .filter((message) => message.role === "user")
    .map((message) => {
      const stamp = (message as { lafAt?: unknown }).lafAt;
      return {
        id: message.id,
        text: textOf(message.content),
        at: typeof stamp === "string" ? new Date(stamp).getTime() : null,
      };
    })
    .filter((message) => message.text.trim())
    .slice(-count);
}

const probability = (
  answers: Record<string, unknown>,
  name: string,
): number => {
  const answer = answers[name] as { noul?: unknown } | undefined;
  return typeof answer?.noul === "number" && Number.isFinite(answer.noul)
    ? answer.noul
    : 0;
};

export function createMemoryCurator(options: {
  database: Database;
  /** Jev with the server model behind it, or the server model alone. Null: nothing is judged. */
  asker: JevAsker | null;
  /** The thread as the store holds it (`runner/thread-store.ts messagesFor`). */
  history: (threadId: string) => Promise<readonly StampedMessage[]>;
  now?: () => Date;
}): MemoryCurator {
  const { database, asker } = options;
  const now = options.now ?? (() => new Date());

  return {
    async runOnce() {
      if (!asker) return [];
      const candidates: Candidate[] = await database
        .select({
          id: agentMemories.id,
          agentId: agentMemories.agentId,
          ownerUserId: agentMemories.ownerUserId,
          content: agentMemories.content,
          createdAt: agentMemories.createdAt,
          evidenceThreadId: agentMemories.evidenceThreadId,
          evidenceMessageId: agentMemories.evidenceMessageId,
        })
        .from(agentMemories)
        .where(
          and(
            eq(agentMemories.source, "bot"),
            isNull(agentMemories.forgottenAt),
            isNull(agentMemories.confirmedAt),
            isNull(agentMemories.curatedAt),
            lt(
              agentMemories.createdAt,
              new Date(now().getTime() - CURATION_SETTLE_MS),
            ),
          ),
        )
        .orderBy(asc(agentMemories.createdAt))
        .limit(CURATION_BATCH);
      if (candidates.length === 0) return [];

      const groups = new Map<string, Candidate[]>();
      for (const row of candidates) {
        const key = `${row.agentId}\u0000${row.ownerUserId}`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      const threads = new Map<string, readonly StampedMessage[]>();
      const historyOf = async (threadId: string) => {
        const held = threads.get(threadId);
        if (held) return held;
        const read = await options.history(threadId);
        threads.set(threadId, read);
        return read;
      };

      const runs: CurationRun[] = [];
      for (const rows of groups.values()) {
        const first = rows[0];
        if (!first) continue;
        const run: CurationRun = {
          agentId: first.agentId,
          checked: 0,
          confirmed: 0,
          dropped: 0,
          superseded: 0,
          unchecked: 0,
          arm: "none",
        };
        const forgottenRows = await ownerForgottenRows(
          database,
          first.agentId,
          first.ownerUserId,
        );
        for (const row of rows) {
          const stamp = new Date();
          const messages =
            row.evidenceThreadId && row.evidenceMessageId
              ? ownerMessagesTo(
                  await historyOf(row.evidenceThreadId),
                  row.evidenceMessageId,
                )
              : null;
          if (!messages || messages.length === 0) {
            // Nothing to check it against: checked, and left as the Bot's inference.
            await database
              .update(agentMemories)
              .set({ curatedAt: stamp, updatedAt: stamp })
              .where(eq(agentMemories.id, row.id));
            run.unchecked += 1;
            continue;
          }
          // Older Bot lines it might replace; never an owner's, never a line confirmed by the owner.
          const older = await database
            .select({ id: agentMemories.id, content: agentMemories.content })
            .from(agentMemories)
            .where(
              and(
                eq(agentMemories.agentId, row.agentId),
                eq(agentMemories.ownerUserId, row.ownerUserId),
                eq(agentMemories.source, "bot"),
                isNull(agentMemories.forgottenAt),
                isNull(agentMemories.confirmedAt),
                lt(agentMemories.createdAt, row.createdAt),
              ),
            )
            .orderBy(asc(agentMemories.createdAt))
            .limit(OLDER_LINES);

          /*
           * Only the forgettings that came after the oldest message read here can make this line a
           * resurrection; one forgotten before all of them was told again by the owner since.
           */
          const oldest = Math.min(
            ...messages.map((message) => message.at ?? 0),
          );
          const forgotten = forgottenRows.filter(
            (row) => row.at.getTime() > oldest,
          );
          const questions: Record<
            string,
            { type: "noul"; instructions: string }
          > = {};
          messages.forEach((_, at) => {
            questions[`m${at}`] = {
              type: "noul",
              instructions: `Owner message m${at} in \`owner_messages\` states the fact in \`claim\`, or asks the assistant to keep something that \`claim\` records.`,
            };
          });
          forgotten.forEach((_, at) => {
            questions[`f${at}`] = {
              type: "noul",
              instructions: `\`claim\` states, restates or paraphrases forgotten fact f${at} in \`forgotten\`, which the owner told the assistant to forget.`,
            };
          });
          older.forEach((_, at) => {
            questions[`o${at}`] = {
              type: "noul",
              instructions: `\`claim\` is a newer statement about the same thing as older line o${at} in \`older_lines\` and contradicts or replaces it, so o${at} is no longer true.`,
            };
          });

          let answers: Record<string, unknown>;
          try {
            const response = await asker.ask(
              {
                claim: redactText(row.content),
                owner_messages: Object.fromEntries(
                  messages.map((message, at) => [
                    `m${at}`,
                    redactText(message.text).slice(0, MESSAGE_CHARS),
                  ]),
                ),
                ...(forgotten.length > 0
                  ? {
                      forgotten: Object.fromEntries(
                        forgotten.map((row, at) => [
                          `f${at}`,
                          redactText(row.line),
                        ]),
                      ),
                    }
                  : {}),
                ...(older.length > 0
                  ? {
                      older_lines: Object.fromEntries(
                        older.map((line, at) => [
                          `o${at}`,
                          redactText(line.content),
                        ]),
                      ),
                    }
                  : {}),
              },
              questions,
            );
            answers = response.answers as Record<string, unknown>;
            run.arm = /jev/i.test(response.model ?? "") ? "jev" : "model";
          } catch (error) {
            // No judge, no decision: the line waits for the next hour.
            log.warn("memory_curation_unjudged", {
              bot: row.agentId,
              reason: describeFailure(error),
            });
            continue;
          }
          run.checked += 1;

          let best = -1;
          let support = 0;
          messages.forEach((_, at) => {
            const p = probability(answers, `m${at}`);
            if (p > support) {
              support = p;
              best = at;
            }
          });
          // Learned from words said before the owner forgot the fact: the forgetting, undone.
          const saidAt = messages[best]?.at ?? 0;
          const restated = forgotten.some(
            (row, at) =>
              probability(answers, `f${at}`) >= RESTATED_AT &&
              row.at.getTime() > saidAt,
          );

          if (restated || support < EVIDENCE_KEEP) {
            await database
              .update(agentMemories)
              .set({
                forgottenAt: stamp,
                forgottenBy: "curation",
                forgetReason: restated ? "restated_forgotten" : "unsupported",
                curatedAt: stamp,
                confidence: support,
                updatedAt: stamp,
              })
              .where(
                and(
                  eq(agentMemories.id, row.id),
                  isNull(agentMemories.forgottenAt),
                ),
              );
            run.dropped += 1;
            continue;
          }

          const evidence = messages[best];
          const replaced = older.filter(
            (_, at) => probability(answers, `o${at}`) >= SUPERSEDE_AT,
          );
          await database.transaction(async (tx) => {
            await tx
              .update(agentMemories)
              .set({
                curatedAt: stamp,
                confidence: support,
                ...(evidence
                  ? {
                      evidenceMessageId: evidence.id,
                      evidenceExcerpt: excerptOf(evidence.text),
                    }
                  : {}),
                ...(replaced.length > 0
                  ? { supersedes: replaced[replaced.length - 1]?.id ?? null }
                  : {}),
                updatedAt: stamp,
              })
              .where(eq(agentMemories.id, row.id));
            for (const line of replaced) {
              await tx
                .update(agentMemories)
                .set({
                  forgottenAt: stamp,
                  forgottenBy: "curation",
                  forgetReason: "superseded",
                  replacedBy: row.id,
                  updatedAt: stamp,
                })
                .where(
                  and(
                    eq(agentMemories.id, line.id),
                    isNull(agentMemories.forgottenAt),
                  ),
                );
            }
          });
          run.confirmed += 1;
          run.superseded += replaced.length;
        }
        if (run.checked + run.unchecked > 0) {
          await recordMemoryReceipt(database, {
            agentId: first.agentId,
            ownerUserId: first.ownerUserId,
            job: "curation",
            checked: run.checked,
            confirmed: run.confirmed,
            dropped: run.dropped,
            superseded: run.superseded,
            arm: run.arm,
          });
        }
        runs.push(run);
      }
      return runs;
    },
  };
}

/**
 * Where a `remember` is being learned, read from the conversation store: the Bot's kept conversation
 * and the owner message it is answering, with a redacted excerpt of the owner's words. The
 * memory store's `evidenceFor` hook (`memory-store.ts`).
 */
export function evidenceFromConversations(conversations: {
  questionOf(
    botId: string,
  ): { threadId: string; messageId: string; text: string } | null;
}): (agentId: string) => MemoryEvidenceInput | null {
  return (agentId) => {
    const question = conversations.questionOf(agentId);
    return question
      ? {
          threadId: question.threadId,
          messageId: question.messageId,
          excerpt: excerptOf(question.text),
        }
      : null;
  };
}
