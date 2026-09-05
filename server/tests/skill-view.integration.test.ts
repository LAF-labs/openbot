import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { AuditEventInput } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  pluginGrants,
  skills,
  users,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { credentialVaultStub } from "./support/credentials";
import { TEST_POOL } from "./support/database";

/**
 * A Bot reading one of its skills: the grant is the one guard, and the read leaves a row.
 *
 * The `skill.viewed` row is the whole reason the body goes through the store rather than being
 * read off the grants query the browser already holds — it is the one trace of a skill a Bot chose
 * on its own rather than one a person typed with `/`.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const policy: ActionPolicy = { deny: [], ask: [], allow: ["true"] };
const rows: AuditEventInput[] = [];

const store = createPluginStore({
  database,
  auditStore: {
    insert: async (event) => {
      rows.push(event);
    },
  },
  credentials: credentialVaultStub({ readSecret: async () => null }),
  encryptionKey: "x".repeat(44),
  policy: () => policy,
  approvals: createApprovalRegistry(),
});

const suite = randomUUID().slice(0, 8);
const owner = `user_view_${suite}`;
const heldBot = `agent_holds_${suite}`;
const bareBot = `agent_bare_${suite}`;
const slug = `stock-count-${suite}`;

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test`, name: owner })
    .onConflictDoNothing();
  for (const id of [heldBot, bareBot]) {
    await database
      .insert(agents)
      .values({ id, name: id, type: "remote_ag_ui", configuration: {} })
      .onConflictDoNothing();
    await database
      .insert(agentProfiles)
      .values({
        agentId: id,
        ownerUserId: owner,
        title: id,
        roleDescription: "For a test.",
        avatarSeed: id,
        visibility: "private",
      })
      .onConflictDoNothing();
  }
  await store.installSkill({
    slug,
    title: "재고 정리",
    summary: "창고 재고를 세고 표로 정리한다",
    instructions: "1. 창고 페이지를 연다.\n2. 수량을 표로 적는다.",
    ownerUserId: owner,
    by: owner,
  });
  await store.grant("skill", slug, heldBot, owner);
  rows.length = 0;
});

afterAll(async () => {
  await database
    .delete(pluginGrants)
    .where(inArray(pluginGrants.agentId, [heldBot, bareBot]));
  await database.delete(skills).where(eq(skills.slug, slug));
  await database
    .delete(agentProfiles)
    .where(inArray(agentProfiles.agentId, [heldBot, bareBot]));
  await database.delete(agents).where(inArray(agents.id, [heldBot, bareBot]));
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});

describe("a Bot reading a skill it holds", () => {
  test("gets the body and leaves a skill.viewed row", async () => {
    const viewed = await store.viewSkill({
      slug: `/${slug}`,
      agentId: heldBot,
      actorId: owner,
    });

    expect(viewed).toEqual({
      allowed: true,
      skill: {
        slug,
        title: "재고 정리",
        summary: "창고 재고를 세고 표로 정리한다",
        instructions: "1. 창고 페이지를 연다.\n2. 수량을 표로 적는다.",
      },
    });
    const row = rows.find((event) => event.eventType === "skill.viewed");
    expect(row).toMatchObject({
      targetType: "skill",
      targetId: slug,
      payload: { bot: heldBot, skill: slug, actor: owner },
    });
    // The body itself does not ride the audit row; the trail says WHICH skill, not what it says.
    expect(JSON.stringify(row)).not.toContain("창고 페이지를 연다");
  });

  test("a Bot without the grant is refused with the code, and nothing is written", async () => {
    rows.length = 0;
    const viewed = await store.viewSkill({ slug, agentId: bareBot });

    expect(viewed).toEqual({
      allowed: false,
      reason: "laf:skill_not_granted",
    });
    expect(rows.map((event) => event.eventType)).not.toContain("skill.viewed");
  });

  /**
   * The other half: the prompt's index. The loader is wrapped rather than changed, and the wrapper
   * reads the same `plugin_grants` rows the store just wrote — so a Bot that holds the skill is
   * told its name and one line, and a Bot that holds nothing carries nothing.
   */
  test("the roster loader carries each Bot's skills for the prompt", async () => {
    const { withGrantedSkills } = await import("../src/agents/granted-skills");
    const remote = (id: string) => ({
      id,
      name: id,
      type: "remote_ag_ui" as const,
      endpoint: "http://bots.internal/ag-ui",
      profile: { id, name: id, title: id, roleDescription: "For a test." },
      effort: "balanced" as const,
    });
    const load = withGrantedSkills(
      async () => [remote(heldBot), remote(bareBot)],
      database,
    );

    const loaded = await load({ id: owner, role: "user" });
    const held = loaded.find((agent) => agent.id === heldBot);
    const bare = loaded.find((agent) => agent.id === bareBot);
    if (held?.type !== "remote_ag_ui" || bare?.type !== "remote_ag_ui") {
      throw new Error("expected both remote Bots back");
    }
    expect(held.profile.skills).toEqual([
      { slug, summary: "창고 재고를 세고 표로 정리한다" },
    ]);
    expect(bare.profile.skills).toBeUndefined();
  });

  test("a name nothing is installed under is the same refusal", async () => {
    // Not a separate "unknown" code: the Bot is told about the skills it holds, so a name outside
    // that list is a name it was not given, whichever of the two it is.
    const viewed = await store.viewSkill({
      slug: `nothing-${suite}`,
      agentId: heldBot,
    });
    expect(viewed).toEqual({
      allowed: false,
      reason: "laf:skill_not_granted",
    });
  });
});
