import { randomUUID } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import type { AuditStore } from "../audit";
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

export type CoworkerCallOptions = {
  /**
   * Fresh instances per call, keys resolved per load, exactly as the runtime builds them — and
   * loaded for the actor, so a private coworker the person cannot see is a coworker their Bot
   * cannot ask either.
   */
  resolveAgents: (actor: AgentActor) => Promise<Record<string, AbstractAgent>>;
  auditStore?: AuditStore;
  timeoutMs?: number;
};

export function createCoworkerCall(options: CoworkerCallOptions) {
  const timeoutMs = options.timeoutMs ?? COWORKER_ANSWER_TIMEOUT_MS;

  async function record(
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
        payload: { caller, ...payload },
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

      target.setMessages([
        { id: randomUUID(), role: "user", content: question },
      ]);

      let outcome: Awaited<ReturnType<AbstractAgent["runAgent"]>>;
      try {
        outcome = await Promise.race([
          target.runAgent(),
          new Promise<never>((_, reject) => {
            setTimeout(
              () =>
                reject(
                  new CoworkerCallError(
                    "The coworker did not answer in time.",
                    504,
                  ),
                ),
              timeoutMs,
            ).unref?.();
          }),
        ]);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await record(callerId, targetId, { ok: false, reason });
        if (error instanceof CoworkerCallError) throw error;
        // An UnavailableAgent's refusal and a dead endpoint both land here: the coworker exists in
        // the roster and could not answer, which is the upstream's failure, not the request's.
        throw new CoworkerCallError(reason, 502);
      }

      const answer = outcome.newMessages
        .filter((entry) => entry.role === "assistant")
        .map((entry) =>
          typeof entry.content === "string" ? entry.content : "",
        )
        .filter(Boolean)
        .join("\n\n")
        .trim();

      await record(callerId, targetId, {
        ok: true,
        answered: answer.length > 0,
      });
      return answer.length > 0
        ? answer
        : "The coworker finished without saying anything.";
    },
  };
}

export type CoworkerCall = ReturnType<typeof createCoworkerCall>;
