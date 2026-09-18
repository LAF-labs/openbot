import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAccountExport } from "../src/account/export";
import { createShopStore } from "../src/account/shop";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { withShopProfile } from "../src/agents/shop-context";
import { botPromptMessage } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, users } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * The shop answers against a real database: where they are kept, what every Bot's run is composed
 * from, and what leaves with the person.
 *
 * Kept on the person's own row (`users.business_kind`, `users.daily_places`) — one account per
 * deployment, and the answers are that account's — so deleting the account takes them with the
 * row, and the export reads them off it.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);
const shops = createShopStore(database);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const loadAgents = withShopProfile(
  createRuntimeAgentLoader(database),
  shops.read,
);

const suite = `shop-${randomUUID().slice(0, 8)}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];

// The test database is shared between files: only what this file made is removed, by id.
afterEach(async () => {
  const agentIds = createdAgentIds.splice(0);
  if (agentIds.length > 0) {
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, agentIds));
    await database.delete(agents).where(inArray(agents.id, agentIds));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function person(): Promise<AgentActor> {
  const id = `${suite}-${randomUUID().slice(0, 8)}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "사장님" });
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function botOf(owner: AgentActor, name: string) {
  const profile = await profileStore.create(owner, {
    name,
    title: "",
    roleDescription: "",
  });
  createdAgentIds.push(profile.id);
  return profile;
}

async function promptFor(owner: AgentActor, agentId: string) {
  const loaded = await loadAgents(owner);
  const agent = loaded.find((candidate) => candidate.id === agentId);
  if (agent?.type !== "remote_ag_ui") return "";
  return botPromptMessage(agent.profile, {
    mode: "chat",
    now: new Date(),
    timeZone: "Asia/Seoul",
  }).content;
}

describe("the store", () => {
  test("reads nothing for somebody who has answered nothing", async () => {
    const owner = await person();
    expect(await shops.read(owner.id)).toEqual({ kind: null, places: [] });
  });

  test("keeps an answer whole, in the order the places were picked, and replaces it whole", async () => {
    const owner = await person();

    expect(
      await shops.save(owner.id, {
        kind: "food",
        places: ["naver-smartplace", "baemin-ceo"],
      }),
    ).toEqual({ kind: "food", places: ["naver-smartplace", "baemin-ceo"] });
    expect(await shops.read(owner.id)).toEqual({
      kind: "food",
      places: ["naver-smartplace", "baemin-ceo"],
    });

    await shops.save(owner.id, { kind: null, places: ["gmail"] });
    expect(await shops.read(owner.id)).toEqual({
      kind: null,
      places: ["gmail"],
    });
  });

  test("writes the one person it was given and nobody else", async () => {
    const one = await person();
    const other = await person();
    await shops.save(other.id, { kind: "office", places: ["notion"] });

    await shops.save(one.id, { kind: "beauty", places: ["instagram"] });

    expect(await shops.read(other.id)).toEqual({
      kind: "office",
      places: ["notion"],
    });
  });

  test("reads past a place the catalogue has since dropped", async () => {
    const owner = await person();
    // Written straight to the row, the way an older build's answer would still be sitting there.
    await database
      .update(users)
      .set({ businessKind: "retired-kind", dailyPlaces: ["gone", "hometax"] })
      .where(eq(users.id, owner.id));

    expect(await shops.read(owner.id)).toEqual({
      kind: null,
      places: ["hometax"],
    });
  });
});

describe("every Bot's run", () => {
  test("carries the person's answers, on every Bot they have", async () => {
    const owner = await person();
    const first = await botOf(owner, "초롱");
    const second = await botOf(owner, "보리");
    await shops.save(owner.id, {
      kind: "food",
      places: ["baemin-ceo", "gmail"],
    });

    for (const bot of [first, second]) {
      expect(await promptFor(owner, bot.id)).toContain(
        "이 사람이 하는 일: 음식점·카페. 매일 쓰는 곳: 배달의민족(ceo.baemin.com), 지메일.",
      );
    }
  });

  test("carries nothing for somebody who answered nothing", async () => {
    const owner = await person();
    const bot = await botOf(owner, "초롱");
    expect(await promptFor(owner, bot.id)).not.toContain("이 사람이 하는 일");
    expect(await promptFor(owner, bot.id)).not.toContain("매일 쓰는 곳");
  });

  test("reads the answer again on the next run, so a change in Settings applies at once", async () => {
    const owner = await person();
    const bot = await botOf(owner, "초롱");
    await shops.save(owner.id, { kind: "food", places: [] });
    expect(await promptFor(owner, bot.id)).toContain("음식점·카페");

    await shops.save(owner.id, { kind: "online", places: [] });
    const after = await promptFor(owner, bot.id);
    expect(after).toContain("온라인 판매");
    expect(after).not.toContain("음식점·카페");
  });
});

describe("leaving with it", () => {
  test("the export carries the answers on the person's profile", async () => {
    const owner = await person();
    await shops.save(owner.id, {
      kind: "education",
      places: ["kakao-channel", "google-calendar"],
    });

    const text = await new Response(
      createAccountExport(database).stream(owner.id),
    ).text();
    const document = JSON.parse(text) as {
      profile: Record<string, unknown>;
    };

    expect(document.profile.shop).toEqual({
      kind: "education",
      places: ["kakao-channel", "google-calendar"],
    });
  });
});
