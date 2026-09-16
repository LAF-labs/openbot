import { eq, isNull, or, type SQL } from "drizzle-orm";
import { agentProfiles } from "../db/schema";
import type { AgentActor, AgentProfile } from "./profile-types";

/**
 * May this actor SEE this Bot at all — its name, its title, the words it was given?
 *
 * A BOT BELONGS TO THE ACCOUNT THAT MADE IT, AND THAT IS THE WHOLE OF THE RULE. No role exception,
 * no visibility field, no way to publish one. The owner's words, 2026-09-16: "모든 봇은 해당 계정
 * 소유인 거고 다른 계정이랑은 전혀 관계없는건데? 남이 만든 봇을 다른 계정이 볼 수 있는 구조라는거
 * 자체가 잘못된 거임."
 *
 * HOW IT GOT HERE, because the shape it replaced is the instructive part. `agent_profiles` carried
 * a `visibility` column beside `owner_user_id` — two answers to one question, and the second could
 * contradict the first: a Bot marked `public` was readable by every account on the deployment. On
 * top of that the filter stepped aside entirely for an administrator, measured on the rehearsal
 * deployment the same day: signing in as the deployment's administrator listed three Bots, every
 * one of them private and two of them somebody else's, with the titles and roles their owners had
 * written. The column is gone (migration 0042); ownership is the only thing left to ask.
 *
 * A NULL OWNER IS THE DEPLOYMENT'S OWN. A Bot a package shipped belongs to nobody in particular
 * and is everybody's — the rule `actorMayDriveBot` (auth/guards.ts) has always used for a Bot
 * nobody made, now the one exception here and the only one there is.
 *
 * WHAT THIS IS NOT. It is not permission to act — that is {@link canManageAgent}, which refuses a
 * package's Bot outright — and it is not permission to drive the browser a Bot holds, which is
 * `actorMayDriveBot` and reads ownership on its own terms. Seeing a Bot and using one are two
 * questions and are kept apart on purpose.
 */
export function canSeeAgent(
  actor: AgentActor,
  agent: Pick<AgentProfile, "ownerUserId">,
): boolean {
  return agent.ownerUserId === null || agent.ownerUserId === actor.id;
}

/**
 * The same rule as a WHERE clause, for the reads that must never fetch the row in the first place.
 *
 * In the query and not in JavaScript afterwards: "we read it and then did not show it" is the shape
 * most accidental disclosures take, and every one of these reads feeds something — a roster, a
 * prompt header, an AG-UI registry — that has already forgotten who asked by the time it renders.
 *
 * Every caller joins `agentProfiles`, so the clause names that table's columns directly.
 */
export function visibleToActor(actor: AgentActor): SQL | undefined {
  return or(
    isNull(agentProfiles.ownerUserId),
    eq(agentProfiles.ownerUserId, actor.id),
  );
}

export function canManageAgent(
  actor: AgentActor,
  agent: AgentProfile,
): boolean {
  if (agent.systemOwned || agent.deletedAt !== null) return false;

  return agent.ownerUserId === actor.id || actor.role === "admin";
}

/**
 * The Bots this actor may manage, as a WHERE clause: who {@link canManageAgent} lets through,
 * narrowed to the Bots they can actually see.
 *
 * Which comes to the same thing as ownership now, for everybody. An administrator manages a Bot in
 * front of them and no longer has any of somebody else's in front of them; and the one kind they
 * CAN still see that is not theirs — a package's — `canManageAgent` refuses outright. Written as a
 * rule rather than as `eq(owner, actor)` at the call site so that the next person to widen either
 * half has one place to read about the other.
 *
 * The OWNERSHIP half only: `canManageAgent` also refuses a deleted Bot, and this clause says
 * nothing about that — its one caller (`routines/ownership.ts`) adds the `deleted_at` check
 * itself, and that half never turned on the actor's identity.
 */
export function manageableByActor(actor: AgentActor): SQL | undefined {
  return eq(agentProfiles.ownerUserId, actor.id);
}
