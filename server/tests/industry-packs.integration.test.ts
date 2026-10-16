import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { composePrompt } from "../../shared/prompt/index";
import type { BusinessKindId } from "../../shared/shop/catalogue";
import { withGrantedSkills } from "../src/agents/granted-skills";
import { createAuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, pluginGrants, skills } from "../src/db/schema";
import { createBuiltInSkills } from "../src/plugins/built-in-skill-sync";
import {
  BUILT_IN_ORIGIN,
  type BuiltInSkill,
} from "../src/plugins/built-in-skills";
import {
  type IndustryPack,
  packFor,
  readIndustryPacks,
} from "../src/plugins/industry-packs";
import { createPluginStore } from "../src/plugins/store";
import { ROUTINE_SUGGESTIONS } from "../src/routines/suggestion-catalog";
import { credentialVaultStub } from "./support/credentials";
import { TEST_POOL } from "./support/database";

/**
 * A person's VM following their business kind (`built-in-skill-sync.ts` with the packs of
 * `tenant/laf/profiles`), on a real deployment's tables: the kind's pack arrives, a changed kind
 * swaps it, a skill the person wrote is never touched, and the prompt a Bot is composed with is the
 * same bytes for as long as the kind is the same.
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
const bot = `agent_pack_${suite}`;
/** A package skill every deployment carries, kind or none. */
const everyones = `세금노무${suite}`;
/** A skill the person wrote themselves, under no pack's name. */
const theirs = `우리가게메뉴${suite}`;
const packageSkill: BuiltInSkill = {
  slug: everyones,
  title: "세금·노무 답하기",
  summary: "세금과 노무는 공식 누리집을 읽고 답한다",
  instructions: "공식 누리집을 열어 읽은 글로만 답한다.",
};

let packs: IndustryPack[] = [];
let kind: BusinessKindId | null = null;
const sync = createBuiltInSkills({
  packageDir: "",
  skills: async () => [packageSkill],
  packSkills: async () => packFor(packs, kind)?.own ?? [],
  listBots: async () => [bot],
  hasTool: () => true,
});
/** The same deployment before this change: the package's skills and no pack. */
const withoutPacks = createBuiltInSkills({
  packageDir: "",
  skills: async () => [packageSkill],
  listBots: async () => [bot],
  hasTool: () => true,
});

async function granted(): Promise<string[]> {
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

/** The whole system prompt this Bot is composed with — static layer and context layer — as bytes. */
async function head(shopKind: BusinessKindId | null): Promise<string> {
  const load = withGrantedSkills(
    async () => [
      {
        id: bot,
        name: bot,
        type: "remote_ag_ui" as const,
        endpoint: "http://bots.internal/ag-ui",
        profile: { id: bot, name: "미소", roleDescription: "For a test." },
      },
    ],
    database,
  );
  const [loaded] = await load({ id: "a-person", role: "user" });
  if (loaded?.type !== "remote_ag_ui") throw new Error("expected the Bot");
  return composePrompt({
    mode: "chat",
    now: new Date("2026-10-16T01:00:00Z"),
    timeZone: "Asia/Seoul",
    bot: { id: bot, name: "미소" },
    shop: { kind: shopKind, places: [] },
    skills: loaded.profile.skills ?? [],
  });
}

const packSlugs = () => packs.flatMap((pack) => pack.own.map((s) => s.slug));

beforeAll(async () => {
  packs = await readIndustryPacks(join(import.meta.dir, "../../tenant/laf"), {
    suggestions: ROUTINE_SUGGESTIONS,
  });
  await database
    .insert(agents)
    .values({ id: bot, name: bot, type: "remote_ag_ui", configuration: {} })
    .onConflictDoNothing();
  await database
    .insert(agentProfiles)
    .values({ agentId: bot, roleDescription: "For a test.", avatarSeed: bot })
    .onConflictDoNothing();
});

afterAll(async () => {
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, bot));
  await database
    .delete(skills)
    .where(inArray(skills.slug, [everyones, theirs, ...packSlugs()]));
  await database.delete(agents).where(eq(agents.id, bot));
});

describe("a person's VM follows their business kind", () => {
  test("with no kind answered, it carries exactly what it did before packs, and the prompt is the same bytes", async () => {
    kind = null;
    await withoutPacks.reconcile(store, "deployment");
    const before = await head(null);
    expect(await granted()).toEqual([everyones]);

    await sync.reconcile(store, "deployment");
    expect(await granted()).toEqual([everyones]);
    expect(await head(null)).toBe(before);
  });

  test("음식점·카페 installs its pack's skill as the package's and hands it to the Bot", async () => {
    kind = "food";
    await sync.reconcile(store, "deployment");
    expect(await granted()).toEqual([everyones, "음식점카페"].sort());
    const food = await row("음식점카페");
    expect(food?.origin).toBe(BUILT_IN_ORIGIN);
    expect(food?.ownerUserId).toBeNull();
  });

  test("while the kind stays 음식점·카페, the prompt is the same bytes request after request", async () => {
    const first = await head("food");
    expect(first).toContain("/음식점카페 — ");
    // A boot, or a save that changed only the places: the reconcile runs again on the same kind.
    await sync.reconcile(store, "deployment");
    expect(await head("food")).toBe(first);
  });

  test("음식점·카페 → 온라인 판매: the old pack goes, the new one arrives, and the person's skills stay theirs", async () => {
    // While on 음식점·카페 the person writes two skills of their own: one under the name the online
    // pack's skill has, and one under no pack's name.
    for (const slug of ["온라인판매", theirs]) {
      await store.installSkill({
        slug,
        title: `${slug}, 내가 쓴 것`,
        summary: "내가 고쳐 쓴 한 줄",
        instructions: "내가 쓴 본문.",
        ownerUserId: null,
        by: "the person",
      });
      await store.grant("skill", slug, bot, "the person");
    }

    kind = "online";
    await sync.reconcile(store, "deployment");

    expect(await row("음식점카페")).toBeUndefined();
    // The online pack's own skill is named 온라인판매, which the person already wrote: theirs wins.
    const kept = await row("온라인판매");
    expect(kept?.origin).not.toBe(BUILT_IN_ORIGIN);
    expect(kept?.title).toBe("온라인판매, 내가 쓴 것");
    expect(kept?.instructions).toBe("내가 쓴 본문.");
    const other = await row(theirs);
    expect(other?.instructions).toBe("내가 쓴 본문.");
    expect(await granted()).toEqual([everyones, theirs, "온라인판매"].sort());

    const now = await head("online");
    expect(now).not.toContain("/음식점카페 — ");
    expect(now).toContain("/온라인판매 — 내가 고쳐 쓴 한 줄");
  });

  test("온라인 판매 → 미용·뷰티 and back to none: each pack's skill arrives and leaves; the person's never do", async () => {
    kind = "beauty";
    await sync.reconcile(store, "deployment");
    expect(await granted()).toEqual(
      [everyones, theirs, "온라인판매", "미용뷰티"].sort(),
    );
    kind = null;
    await sync.reconcile(store, "deployment");
    expect(await granted()).toEqual([everyones, theirs, "온라인판매"].sort());
    expect((await row("온라인판매"))?.instructions).toBe("내가 쓴 본문.");
  });
});
