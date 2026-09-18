import { describe, expect, test } from "bun:test";
import { canManageAgent } from "../src/agents/profile-policy";
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

/*
 * Who may SEE a Bot is a WHERE clause (`visibleToActor`) and is measured against the database in
 * `agent-profile-store.integration.test.ts` — an administrator included, and a package's Bot.
 */
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
