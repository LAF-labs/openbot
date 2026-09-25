import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, pluginGrants, skills } from "../src/db/schema";
import { createBuiltInSkills } from "../src/plugins/built-in-skill-sync";
import { createPluginRoutes, SKILL_BUILT_IN } from "../src/plugins/routes";
import {
  BUILT_IN_ORIGIN,
  type BuiltInSkill,
} from "../src/plugins/built-in-skills";
import { createPluginStore } from "../src/plugins/store";
import { credentialVaultStub } from "./support/credentials";
import { TEST_POOL } from "./support/database";

/**
 * The package's skills on a real deployment's tables (`built-in-skill-sync.ts`): written at boot,
 * handed to every Bot once, kept as shipped, and never allowed to take a name somebody here holds.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const policy: ActionPolicy = { deny: [], ask: [], allow: ["true"] };
const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: credentialVaultStub({ readSecret: async () => null }),
  encryptionKey: "x".repeat(44),
  policy: () => policy,
  approvals: createApprovalRegistry(),
});

const suite = randomUUID().slice(0, 8);
const botA = `agent_builtin_a_${suite}`;
const botB = `agent_builtin_b_${suite}`;
const later = `agent_builtin_later_${suite}`;
const shipped = `쇼핑가격${suite}`;
const second = `네이버뉴스${suite}`;
const taken = `taken-${suite}`;
const bots = [botA, botB, later];

const skill = (
  slug: string,
  body = "가격은 가격비교에서 찾는다.",
): BuiltInSkill => ({
  slug,
  title: slug,
  summary: `${slug} 한 줄`,
  instructions: body,
});

let shipping: BuiltInSkill[] = [];
const sync = createBuiltInSkills({
  packageDir: "",
  skills: async () => shipping,
  listBots: async () => [botA, botB],
});

async function granted(bot: string): Promise<string[]> {
  const rows = await database
    .select({ ref: pluginGrants.ref })
    .from(pluginGrants)
    .where(and(eq(pluginGrants.agentId, bot), eq(pluginGrants.kind, "skill")));
  return rows.map((row) => row.ref).sort();
}

async function row(slug: string) {
  const [found] = await database
    .select()
    .from(skills)
    .where(eq(skills.slug, slug));
  return found;
}

beforeAll(async () => {
  for (const id of bots) {
    await database
      .insert(agents)
      .values({ id, name: id, type: "remote_ag_ui", configuration: {} })
      .onConflictDoNothing();
    await database
      .insert(agentProfiles)
      .values({ agentId: id, roleDescription: "For a test.", avatarSeed: id })
      .onConflictDoNothing();
  }
  // Somebody here wrote a skill under a name a later package also ships.
  await store.installSkill({
    slug: taken,
    title: "사장님 것",
    summary: "",
    instructions: "사장님이 쓴 것.",
    ownerUserId: null,
    by: "an administrator",
  });
});

afterAll(async () => {
  await database
    .delete(pluginGrants)
    .where(inArray(pluginGrants.agentId, bots));
  await database
    .delete(skills)
    .where(inArray(skills.slug, [shipped, second, taken]));
  await database.delete(agents).where(inArray(agents.id, bots));
});

describe("the package's skills at boot", () => {
  test("are written as the package's and handed to every Bot", async () => {
    shipping = [skill(shipped)];
    await sync.reconcile(store, "deployment");

    expect((await row(shipped))?.origin).toBe(BUILT_IN_ORIGIN);
    expect((await row(shipped))?.ownerUserId).toBeNull();
    expect(await granted(botA)).toEqual([shipped]);
    expect(await granted(botB)).toEqual([shipped]);
  });

  test("a skill taken off a Bot stays off after the next boot", async () => {
    await store.revoke("skill", shipped, botA, "the person");
    await sync.reconcile(store, "deployment");
    expect(await granted(botA)).toEqual([]);
    expect(await granted(botB)).toEqual([shipped]);
  });

  test("a changed body is rewritten, and a new skill reaches every Bot", async () => {
    shipping = [skill(shipped, "새 본문."), skill(second)];
    await sync.reconcile(store, "deployment");
    expect((await row(shipped))?.instructions).toBe("새 본문.");
    expect(await granted(botA)).toEqual([second]);
    expect(await granted(botB)).toEqual([second, shipped].sort());
  });

  test("a name somebody here holds is left to them", async () => {
    shipping = [skill(shipped, "새 본문."), skill(second), skill(taken)];
    await sync.reconcile(store, "deployment");
    expect((await row(taken))?.instructions).toBe("사장님이 쓴 것.");
    expect((await row(taken))?.origin).not.toBe(BUILT_IN_ORIGIN);
    expect(await granted(botB)).not.toContain(taken);
  });

  test("a Bot made after boot holds them all", async () => {
    await sync.offerTo(store, later, "deployment");
    expect(await granted(later)).toEqual([second, shipped].sort());
  });

  test("a skill the package stops shipping goes", async () => {
    shipping = [skill(shipped, "새 본문.")];
    await sync.reconcile(store, "deployment");
    expect(await row(second)).toBeUndefined();
    expect(await row(taken)).toBeDefined();
  });
});

describe("the plugin routes", () => {
  const asAdmin = () =>
    createPluginRoutes(store as never, async (context, next) => {
      context.set("actor", {
        id: `admin_${suite}`,
        email: "admin@example.test",
        role: "admin",
      } as never);
      await next();
    });

  test("refuse to edit or delete a built-in skill, an administrator included", async () => {
    const edit = await asAdmin().request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: shipped,
        title: "고침",
        instructions: "고친 본문.",
        global: true,
      }),
    });
    const remove = await asAdmin().request(
      `/skills/${encodeURIComponent(shipped)}`,
      { method: "DELETE" },
    );
    expect(edit.status).toBe(403);
    expect(((await edit.json()) as { code?: string }).code).toBe(
      SKILL_BUILT_IN,
    );
    expect(remove.status).toBe(403);
    expect((await row(shipped))?.instructions).toBe("새 본문.");
  });
});
