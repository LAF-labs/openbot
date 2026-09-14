import type { Database } from "../db/client";
import { appendToSoloConversation } from "../routines/deliver";
import type { CoworkerCallOptions } from "./coworker-call";
import type { AgentProfileStore } from "./profile-store";

/**
 * The answering Bot's own copy of what it was asked, written where that person reads it.
 *
 * The names are looked up rather than passed through, because the heading is what a person sees
 * and an id is not a name. Both Bots are in this person's roster by construction — the call
 * resolved the target from it — and `get` is scoped to the actor, so a Bot they cannot see is a
 * Bot this cannot name.
 */
export function recordCoworkerExchange(
  database: Database,
  profiles: Pick<AgentProfileStore, "get">,
): NonNullable<CoworkerCallOptions["recordExchange"]> {
  return async (exchange) => {
    const actor = { id: exchange.actorId, role: "user" as const };
    const [caller, target] = await Promise.all([
      profiles.get(actor, exchange.callerId).catch(() => null),
      profiles.get(actor, exchange.targetId).catch(() => null),
    ]);
    await appendToSoloConversation(database, {
      agentId: exchange.targetId,
      userId: exchange.actorId,
      // Two names and an arrow: a fact, not a sentence. See appendToSoloConversation.
      heading: `${caller?.name ?? exchange.callerId} → ${target?.name ?? exchange.targetId}`,
      // The question quoted line by line, so a multi-line ask stays one block rather than
      // becoming a quote and then loose prose.
      body: `${exchange.question
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n${exchange.answer}`,
      at: exchange.at,
    });
  };
}
