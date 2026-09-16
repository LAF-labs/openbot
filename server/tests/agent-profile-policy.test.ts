import { describe, expect, test } from "bun:test";
import { canManageAgent, canSeeAgent } from "../src/agents/profile-policy";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";

const creator: AgentActor = { id: "user-1", role: "user" };
const otherUser: AgentActor = { id: "user-2", role: "user" };
const admin: AgentActor = { id: "admin-1", role: "admin" };

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agent-1",
    name: "Researcher",
    title: "Research Assistant",
    roleDescription: "Finds and summarizes information.",
    avatarSeed: "researcher",
    effort: "balanced",
    autoReview: "",
    ownerUserId: creator.id,
    systemOwned: false,
    hidden: false,
    pinnedAt: null,
    notify: true,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    ...overrides,
  };
}

/**
 * Seeing a Bot, which is a different question from managing one.
 *
 * The role decides the second and has nothing to do with the first. Asserted here as a predicate
 * as well as in SQL (`agent-profile-store.integration.test.ts`), because the rule is written twice
 * on purpose — once as a WHERE clause for the reads, once as an answer for the doors that never
 * load a profile — and two spellings of one rule that disagree is the failure to watch for.
 */
describe("who can see a Bot at all", () => {
  test("a Bot belongs to the account that made it, and to nobody else", () => {
    const agent = profile();

    expect(canSeeAgent(creator, agent)).toBe(true);
    expect(canSeeAgent(otherUser, agent)).toBe(false);
    // No role exception. This returned true until 2026-09-16, and the roster read behind it
    // showed an administrator every private Bot on the deployment.
    expect(canSeeAgent(admin, agent)).toBe(false);
  });

  test("a Bot the deployment itself ships is everybody's", () => {
    // Null owner: a package's Bot belongs to no person, and it is the one thing on a roster that
    // is not somebody's. The same case `actorMayDriveBot` has always made for a Bot nobody made.
    const agent = profile({ ownerUserId: null });

    for (const actor of [creator, otherUser, admin]) {
      expect(canSeeAgent(actor, agent)).toBe(true);
    }
  });
});

describe("agent profile permissions", () => {
  test("allows only the creator and admins to manage active user profiles", () => {
    const agent = profile();

    expect(canManageAgent(creator, agent)).toBe(true);
    expect(canManageAgent(otherUser, agent)).toBe(false);
    /*
     * STILL TRUE FOR AN ADMINISTRATOR, and deliberately unchanged. Managing is asked second: every
     * verb loads the profile through the access filter first, so an administrator is only ever
     * asked this about a Bot they can already see — their own, or the deployment's. See
     * `agent-profile-store.integration.test.ts` for that ordering measured end to end.
     */
    expect(canManageAgent(admin, agent)).toBe(true);
  });

  test("lets nobody manage a system profile", () => {
    const agent = profile({
      ownerUserId: null,
      systemOwned: true,
    });

    for (const actor of [creator, otherUser, admin]) {
      expect(canManageAgent(actor, agent)).toBe(false);
    }
  });

  test("denies management of deleted profiles", () => {
    const agent = profile({
      deletedAt: new Date("2026-08-14T00:00:00.000Z"),
    });

    for (const actor of [creator, otherUser, admin]) {
      expect(canManageAgent(actor, agent)).toBe(false);
    }
  });
});
