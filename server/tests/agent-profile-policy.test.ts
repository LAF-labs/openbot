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
    visibility: "private",
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

describe("agent profile permissions", () => {
  test("allows only the creator and admins to manage active user profiles", () => {
    for (const visibility of ["public", "private"] as const) {
      const agent = profile({ visibility });

      expect(canManageAgent(creator, agent)).toBe(true);
      expect(canManageAgent(otherUser, agent)).toBe(false);
      expect(canManageAgent(admin, agent)).toBe(true);
    }
  });

  test("lets nobody manage a system profile", () => {
    const agent = profile({
      visibility: "public",
      ownerUserId: null,
      systemOwned: true,
    });

    for (const actor of [creator, otherUser, admin]) {
      expect(canManageAgent(actor, agent)).toBe(false);
    }
  });

  test("denies management of deleted profiles", () => {
    const agent = profile({
      visibility: "public",
      deletedAt: new Date("2026-08-14T00:00:00.000Z"),
    });

    for (const actor of [creator, otherUser, admin]) {
      expect(canManageAgent(actor, agent)).toBe(false);
    }
  });
});
