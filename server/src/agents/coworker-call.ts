import { randomUUID } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import type { AuditStore } from "../audit";
import type { RunLedger } from "../runner/run-ledger";
import type { AgentActor } from "./profile-types";

/**
 * One Bot asking another, on the server, with nothing else in the room.
 *
 * The product decision (2026-08-20): an account's Bots share one computer but can brief each other.
 * This is the briefing path. The caller's run is out in the app driving tools; the coworker it asks
 * runs HERE, from a fresh agent instance, with its standing role and the one question — and with no
 * tools at all, because a server-side run has no browser to hand tools to. That absence is also the
 * recursion guard: a coworker answering a question cannot ask a third coworker, because ask_coworker
 * is a frontend tool and there is no frontend in this room. One hop, by construction.
 *
 * What stays separate stays separate: the coworker's answer comes from its own role and knowledge,
 * the caller's approvals and policy identity are not lent to it, and the exchange writes one audit
 * row whichever way it ends.
 */

export class CoworkerCallError extends Error {
  constructor(
    message: string,
    /** Mirrors HTTP so the route does not re-derive it from prose. */
    readonly status: 400 | 404 | 502 | 504,
  ) {
    super(message);
    this.name = "CoworkerCallError";
  }
}

/**
 * How long a coworker gets to answer.
 *
 * Long enough for a model round trip with a long answer; short enough that the caller's own run —
 * which is holding a tool call open in somebody's browser — does not sit there for the length of a
 * coffee. A coworker that needs longer than this is doing work, and work is a channel of its own.
 */
export const COWORKER_ANSWER_TIMEOUT_MS = 90_000;

/**
 * The most a Bot may say to a coworker in one question, and the most it gets back.
 *
 * Every other thing that crosses into a model's context on this deployment is bounded — a webhook
 * payload rides in cut, an MCP result is truncated visibly at 20,000 characters, a recorded failure
 * at 400 — and this path was the one that was not. The question is written by a model, which is
 * exactly the writer that will one day paste a whole page into it, and the answer is a second Bot's
 * unbounded prose landing in the caller's window. Two different treatments on purpose: a question
 * that is too long is REFUSED, because the caller can ask again more briefly and nothing has been
 * spent yet; an answer that is too long is TRUNCATED, because the work is already done and throwing
 * it away would be worse than handing back most of it with a mark saying so.
 */
export const COWORKER_QUESTION_MAX_CHARS = 8_000;
export const COWORKER_ANSWER_MAX_CHARS = 20_000;

/**
 * One server-side run: the message in, the assistant's text out, or a timeout.
 *
 * A Bot running once from a fresh instance with no tools in the room. This is still what a
 * coworker being ASKED gets — the one-hop guarantee above depends on it. It is no longer what a
 * routine gets: a routine runs the tool loop in runner/unattended.ts, because a scheduled Bot that
 * can only think and never look answers "check the supplier's prices" with confident fiction. This
 * stays as the fallback for a deployment that wires the routine service without tools.
 */
export async function runAgentOnce(
  target: AbstractAgent,
  message: string,
  timeoutMs: number,
): Promise<string> {
  target.setMessages([{ id: randomUUID(), role: "user", content: message }]);

  const outcome = await Promise.race([
    target.runAgent(),
    new Promise<never>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new CoworkerCallError("The coworker did not answer in time.", 504),
          ),
        timeoutMs,
      ).unref?.();
    }),
  ]);

  return outcome.newMessages
    .filter((entry) => entry.role === "assistant")
    .map((entry) => (typeof entry.content === "string" ? entry.content : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export type CoworkerCallOptions = {
  /**
   * Fresh instances per call, keys resolved per load, exactly as the runtime builds them — and
   * loaded for the actor, so a private coworker the person cannot see is a coworker their Bot
   * cannot ask either.
   */
  resolveAgents: (actor: AgentActor) => Promise<Record<string, AbstractAgent>>;
  auditStore?: AuditStore;
  /**
   * The run ledger, so a Bot answering another Bot reads as busy while it does.
   *
   * The audit row below records that the exchange HAPPENED; this records that it is happening. A
   * handoff can take a minute and a half, and for that minute and a half the roster was silent.
   */
  ledger?: RunLedger;
  /**
   * Where the exchange is written down, in the answering Bot's own conversation.
   *
   * WHAT THIS FIXES. A handoff used to exist in exactly two places: the caller's window, where the
   * person watched it, and one audit row saying it happened. The Bot that ANSWERED kept nothing —
   * ask it tomorrow what it told its colleague and it has never heard of it, because its answer
   * went into somebody else's context and nowhere else. A colleague who cannot remember what they
   * were asked is not a colleague.
   *
   * Optional and always `.catch`ed by the caller below, exactly like the audit row and the ledger:
   * losing the record must not lose the answer.
   */
  recordExchange?: (exchange: {
    /** The person who set this off. Whose conversation with the answering Bot gets the record. */
    actorId: string;
    callerId: string;
    targetId: string;
    question: string;
    answer: string;
    at: Date;
  }) => Promise<void>;
  timeoutMs?: number;
};

export function createCoworkerCall(options: CoworkerCallOptions) {
  const timeoutMs = options.timeoutMs ?? COWORKER_ANSWER_TIMEOUT_MS;

  /**
   * The trail row for one exchange.
   *
   * `actor` is the authenticated person and `caller` is the Bot the REQUEST said was asking — the
   * route's own comment is explicit that the second one is not authorisation. Recording only the
   * claim left the trail unable to answer "who set this off" on a deployment with more than one
   * person in it, which is the question a trail exists for. Both, so a reader can see the claim
   * and who made it.
   */
  async function record(
    actor: string,
    caller: string,
    target: string,
    payload: Record<string, unknown>,
  ) {
    // An observation, never a veto: losing the row must not lose the answer.
    try {
      await options.auditStore?.insert({
        eventType: "coworker.asked",
        targetType: "agent",
        targetId: target,
        payload: { actor, caller, ...payload },
      });
    } catch {
      // The audit store being down is its own incident; this exchange is not it.
    }
  }

  return {
    /** The coworker's answer, as text. Throws CoworkerCallError with the reason otherwise. */
    async ask(
      actor: AgentActor,
      callerId: string,
      targetId: string,
      message: string,
    ): Promise<string> {
      const question = message.trim();
      if (!question) {
        throw new CoworkerCallError("Ask the coworker something.", 400);
      }
      if (question.length > COWORKER_QUESTION_MAX_CHARS) {
        // Says what to do instead. A refusal a model cannot act on is a refusal it will retry
        // unchanged, which spends the turn twice and ends in the same place.
        throw new CoworkerCallError(
          `That question is ${question.length} characters, and a coworker takes at most ${COWORKER_QUESTION_MAX_CHARS}. Ask for what you actually need, and point at the rest rather than pasting it.`,
          400,
        );
      }
      if (callerId === targetId) {
        throw new CoworkerCallError(
          "That is you. Ask a different coworker.",
          400,
        );
      }

      const agents = await options.resolveAgents(actor);
      const target = agents[targetId];
      if (!target) {
        throw new CoworkerCallError(
          `There is no coworker with the id "${targetId}".`,
          404,
        );
      }

      // Opened before the run and closed in both exits below; never allowed to fail the exchange.
      const runId = await options.ledger
        ?.begin({
          agentId: targetId,
          userId: actor.id,
          origin: "handoff",
          label: null,
        })
        .catch(() => null);

      let answer: string;
      try {
        answer = await runAgentOnce(target, question, timeoutMs);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (runId) await options.ledger?.finish(runId, reason).catch(() => {});
        await record(actor.id, callerId, targetId, { ok: false, reason });
        if (error instanceof CoworkerCallError) throw error;
        // An UnavailableAgent's refusal and a dead endpoint both land here: the coworker exists in
        // the roster and could not answer, which is the upstream's failure, not the request's.
        throw new CoworkerCallError(reason, 502);
      }

      if (runId) await options.ledger?.finish(runId).catch(() => {});
      if (answer.length > 0) {
        await options
          .recordExchange?.({
            actorId: actor.id,
            callerId,
            targetId,
            question,
            answer,
            at: new Date(),
          })
          .catch(() => {
            // The record is the point of this call and still not worth the answer. A person who
            // asked and got an answer must not be told it failed because a second write did.
          });
      }
      await record(actor.id, callerId, targetId, {
        ok: true,
        answered: answer.length > 0,
      });
      if (answer.length === 0) {
        return "The coworker finished without saying anything.";
      }
      /*
       * Cut where it is read, and visibly. The same shape an MCP result takes for the same reason:
       * a second Bot's answer is somebody else's prose deciding how much of this run's window to
       * spend, and a model handed a silent truncation reports the missing half as absent rather
       * than as cut off.
       */
      return answer.length > COWORKER_ANSWER_MAX_CHARS
        ? `${answer.slice(0, COWORKER_ANSWER_MAX_CHARS)}\n\n[truncated: the coworker answered with ${answer.length} characters]`
        : answer;
    },
  };
}

export type CoworkerCall = ReturnType<typeof createCoworkerCall>;
