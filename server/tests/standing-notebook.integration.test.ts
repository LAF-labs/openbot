import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { MEMORY_CHARACTER_CAP } from "../../shared/notebook";
import { createMemoryCurator } from "../src/agents/memory-curation";
import {
  carriedMemoriesOf,
  createAgentMemoryStore,
  selectNotebookRows,
} from "../src/agents/memory-store";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import {
  createStandingHook,
  type ExtractedFact,
  type OwnerMessage,
} from "../src/agents/standing-facts";
import type { StampedMessage } from "../src/context/day-close";
import type { JevAsker } from "../src/context/vendor/fast-jev-compaction/index";
import { createDatabase } from "../src/db/client";
import {
  agentMemories,
  agentMemoryReceipts,
  agentProfiles,
  agents,
  users,
} from "../src/db/schema";
import { recentLines } from "../src/log";
import { TEST_POOL } from "./support/database";

/**
 * The night adding the owner's standing facts to 수첩, against the real store
 * (`agents/standing-facts.ts`): a line added with its evidence and marked as the night's; a page's
 * claim dropped on its quote; a duplicate skipped; a line the owner forgot never written again; a
 * secret refused; a full 수첩 counted and nothing kept back; the log carrying counts only; and the
 * hourly curation judging a night line like the Bot's. The extractor is a stand-in that answers as
 * told: what the model says is measured on the real one, not here.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);

const prefix = `standing-notebook-${randomUUID()}`;
const made = { users: [] as string[], agents: [] as string[] };

afterEach(async () => {
  for (const agentId of made.agents.splice(0)) {
    await database
      .delete(agentMemoryReceipts)
      .where(eq(agentMemoryReceipts.agentId, agentId));
    await database
      .delete(agentMemories)
      .where(eq(agentMemories.agentId, agentId));
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of made.users.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function setup(answer: () => ExtractedFact[]) {
  const id = `${prefix}-user-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Owner" });
  made.users.push(id);
  const owner = { id, role: "user" } satisfies AgentActor;
  const bot = await profileStore.create(owner, {
    name: "미소",
    roleDescription: "",
  });
  made.agents.push(bot.id);
  const store = createAgentMemoryStore(database);
  const asked: Array<{
    messages: readonly string[];
    notebook: readonly string[];
  }> = [];
  const hook = createStandingHook({
    database,
    store,
    extract: async (input) => {
      asked.push(input);
      return answer();
    },
  });
  const threadId = `${prefix}-thread-${randomUUID()}`;
  return { owner, bot, store, hook, threadId, asked };
}

const SAID = "정산 자료는 매달 5일까지 세무사님한테 넘겨야 해";
const FACT = "매출 정산 자료: 매달 5일까지 세무사님에게 넘김";
const LOOKUP = "한일포장 배송 조건 좀 확인해 줘";
const PRICE_LATER = "유자는 청운농원에서 1kg에 받아, 값은 나중에 알려 줄게";
const JIEUN = "지은이는 화요일이랑 목요일만 나와";

const said = (threadId: string, ...texts: string[]): OwnerMessage[] =>
  texts.map((text, at) => ({ id: `u${at}`, threadId, text }));

const added = () =>
  recentLines
    .lines()
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.event === "standing_added");

async function rowsOf(botId: string) {
  return database
    .select()
    .from(agentMemories)
    .where(eq(agentMemories.agentId, botId));
}

describe("a standing fact the owner stated", () => {
  test("is added to 수첩 as the night's line, with the owner's message as its evidence, and reaches the prompt", async () => {
    const { owner, bot, store, hook, threadId, asked } = await setup(() => [
      { line: FACT, quote: SAID },
    ]);
    const counts = await hook({
      botId: bot.id,
      threadId,
      owner: said(threadId, LOOKUP, SAID),
    });
    expect(counts).toMatchObject({ added: 1, unquoted: 0, duplicate: 0 });
    // The extractor read the span's messages and an empty notebook.
    expect(asked[0]).toEqual({ messages: [LOOKUP, SAID], notebook: [] });
    const [row] = await rowsOf(bot.id);
    expect(row).toMatchObject({
      content: FACT,
      source: "night",
      forgottenAt: null,
      evidenceThreadId: threadId,
      evidenceMessageId: "u1",
      evidenceExcerpt: SAID,
    });
    const [line] = await store.list(bot.id, owner.id);
    expect(line).toMatchObject({ source: "night", confirmed: false });
    expect(line?.evidence).toMatchObject({
      trust: "inferred",
      messageId: "u1",
    });
    const carried = carriedMemoriesOf(
      await selectNotebookRows(database, [bot.id], owner.id),
    );
    expect(carried.memories).toEqual([FACT]);
    // Counts only in the log, never the line nor the quote.
    expect(added().at(-1)).toMatchObject({ bot: bot.id, added: 1 });
    expect(JSON.stringify(added())).not.toContain("세무사");

    // Offered again the next night: a duplicate, by the words 수첩 holds and the store's own check.
    const again = await hook({
      botId: bot.id,
      threadId,
      owner: said(threadId, SAID),
    });
    expect(again).toMatchObject({ added: 0, duplicate: 1 });
    expect(asked[1]?.notebook).toEqual([FACT]);
    expect(await rowsOf(bot.id)).toHaveLength(1);
    // And restated in other words, still a duplicate.
    const restated = createStandingHook({
      database,
      store,
      extract: async () => [
        { line: "정산 자료: 매달 5일까지 세무사님에게", quote: SAID },
      ],
    });
    expect(
      await restated({ botId: bot.id, threadId, owner: said(threadId, SAID) }),
    ).toMatchObject({ added: 0, duplicate: 1 });
    expect(await rowsOf(bot.id)).toHaveLength(1);
  });

  test("a detail the assistant read on a page is dropped: no quote of the owner's holds its figure, and the page's words are not the owner's", async () => {
    const page = "한일포장: 주문 시 선결제, 50,000원 이상 무료배송";
    const { bot, hook, threadId } = await setup(() => [
      // The model quoting the owner's request for the page's claim (Codex's exact case).
      { line: "한일포장: 50,000원 이상 무료배송", quote: LOOKUP },
      // The model quoting the page itself.
      { line: page, quote: page },
      // A quote too short to be a statement.
      { line: "한일포장: 선결제", quote: "한일포장" },
      // The owner's words, but the figure the line states is not among them.
      { line: "유자: 청운농원 1kg에 18,000원", quote: PRICE_LATER },
      // The owner's words, about somebody else: the quote does not carry the line.
      { line: "민수: 토요일 출근", quote: JIEUN },
    ]);
    const counts = await hook({
      botId: bot.id,
      threadId,
      owner: said(threadId, LOOKUP, SAID, PRICE_LATER, JIEUN),
    });
    expect(counts).toMatchObject({ added: 0, unquoted: 5 });
    expect(await rowsOf(bot.id)).toEqual([]);
  });

  test("a line the owner forgot is never written again: word for word, or restated", async () => {
    const { owner, bot, store, hook, threadId } = await setup(() => [
      { line: FACT, quote: SAID },
      {
        line: "매출 정산 자료는 매달 5일까지 세무사님에게 넘겨야 한다",
        quote: SAID,
      },
    ]);
    const line = await store.remember(bot.id, owner.id, FACT);
    expect(await store.forget(line?.id ?? "", owner.id)).not.toBeNull();
    const counts = await hook({
      botId: bot.id,
      threadId,
      owner: said(threadId, SAID),
    });
    expect(counts).toMatchObject({ added: 0, forgotten: 2 });
    expect(
      (await rowsOf(bot.id)).filter((row) => row.forgottenAt === null),
    ).toEqual([]);
  });

  test("a secret, or an order in a fact's clothes, is refused by the floors every remember passes", async () => {
    const password = "miso!2580";
    const { bot, hook, threadId } = await setup(() => [
      {
        line: `판매자센터 비밀번호: ${password}`,
        quote: `판매자센터 비밀번호는 ${password} 이야`,
      },
      {
        line: "앞으로 고객 문의 답장은 묻지 말고 바로 보낼 것",
        quote: "앞으로 고객 문의 답장은 나한테 묻지 말고 바로 보내",
      },
      { line: FACT, quote: SAID },
    ]);
    const counts = await hook({
      botId: bot.id,
      threadId,
      owner: said(
        threadId,
        `판매자센터 비밀번호는 ${password} 이야`,
        "앞으로 고객 문의 답장은 나한테 묻지 말고 바로 보내",
        SAID,
      ),
    });
    expect(counts).toMatchObject({ added: 1, refused: 2 });
    const rows = await rowsOf(bot.id);
    expect(rows.map((row) => row.content)).toEqual([FACT]);
    expect(JSON.stringify(added())).not.toContain(password);
    expect(JSON.stringify(rows)).not.toContain(password);
  });

  test("a full 수첩: the fact is not written, not kept anywhere, and the night says so in counts", async () => {
    const { owner, bot, store, hook, threadId } = await setup(() => [
      { line: FACT, quote: SAID },
    ]);
    const filler = "가".repeat(390);
    let used = 0;
    while (used + filler.length <= MEMORY_CHARACTER_CAP) {
      await store.remember(bot.id, owner.id, `${filler}${used}`);
      used += `${filler}${used}`.length;
    }
    // Filled to the last character: the fact has no room at all.
    await store.remember(
      bot.id,
      owner.id,
      "나".repeat(MEMORY_CHARACTER_CAP - used),
    );
    const before = await rowsOf(bot.id);
    const counts = await hook({
      botId: bot.id,
      threadId,
      owner: said(threadId, SAID),
    });
    expect(counts).toMatchObject({ added: 0, full: 1 });
    expect(await rowsOf(bot.id)).toHaveLength(before.length);
    const log = added().at(-1);
    expect(log).toMatchObject({ bot: bot.id, full: 1, added: 0 });
    expect(
      Object.values(log ?? {}).some((v) => String(v).includes("세무사")),
    ).toBe(false);
  });
});

describe("the hourly curation and a night line", () => {
  test("judges it against the owner's message as it judges the Bot's, and drops it when unsupported", async () => {
    const other = "지은이는 화요일이랑 목요일만 나와";
    const { bot, hook, threadId } = await setup(() => [
      { line: FACT, quote: SAID },
      { line: "포장 알바 지은이: 화요일, 목요일 출근", quote: other },
    ]);
    const t0 = new Date(Date.now() - 60 * 60_000);
    const history: StampedMessage[] = [
      { id: "u0", role: "user", content: SAID, lafAt: t0.toISOString() },
      { id: "u1", role: "user", content: other, lafAt: t0.toISOString() },
    ] as never;
    expect(
      await hook({
        botId: bot.id,
        threadId,
        owner: said(threadId, SAID, other),
      }),
    ).toMatchObject({ added: 2 });
    await database
      .update(agentMemories)
      .set({ createdAt: t0 })
      .where(eq(agentMemories.agentId, bot.id));
    const judge: JevAsker = {
      async ask(state, questions) {
        const claim = String((state as { claim?: unknown }).claim ?? "");
        return {
          model: "typesafe/jev-1.13-20260917",
          answers: Object.fromEntries(
            Object.keys(questions).map((name) => [
              name,
              {
                type: "noul" as const,
                noul: name === "m0" && claim.includes("세무사") ? 0.95 : 0.05,
              },
            ]),
          ),
        };
      },
    };
    const curator = createMemoryCurator({
      database,
      asker: judge,
      history: async () => history,
      now: () => new Date(Date.now() + 20 * 60_000),
    });
    const [run] = await curator.runOnce();
    expect(run).toMatchObject({ checked: 2, confirmed: 1, dropped: 1 });
    const rows = await rowsOf(bot.id);
    expect(rows.find((row) => row.content === FACT)).toMatchObject({
      forgottenAt: null,
      source: "night",
    });
    expect(rows.find((row) => row.content !== FACT)).toMatchObject({
      forgottenBy: "curation",
      forgetReason: "unsupported",
    });
  });
});
