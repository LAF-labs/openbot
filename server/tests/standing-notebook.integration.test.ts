import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { MEMORY_CHARACTER_CAP } from "../../shared/notebook";
import { createMemoryCurator } from "../src/agents/memory-curation";
import {
  carriedMemoriesOf,
  createAgentMemoryStore,
  MemoryForgottenError,
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
 * The night adding the owner's standing facts to 수첩, against the real store and the real hook
 * (`agents/standing-facts.ts`), with a stubbed extractor and a stubbed judge: the floor on the
 * quote (found whole, every figure in the quote itself, folded digits), the judge deciding support
 * and supersession before the write (a correction written and the old value retired; another
 * person's days not swallowed; a line about 민수 under 지은's sentence, a dropped negation, a
 * changed recurrence, 10시 read as 10만 — refused), the store's own floors, a full 수첩 counted and
 * nothing kept back, a conversation dropped during the call, two closes at once, the judge down,
 * and the hourly pass superseding a night line. What the real extractor and judge say is measured
 * on the real models, not here.
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

type Asked = {
  claim: string;
  messages: string[];
  older: string[];
  forgotten: string[];
};

/**
 * A judge that answers by a table: for a claim, how sure it is of the best message, and which
 * older lines (by their words) it replaces. Records what it was asked.
 */
function judgeOf(
  rule: (asked: Asked) => { support: number; replaces?: string[] },
) {
  const asked: Asked[] = [];
  const asker: JevAsker = {
    async ask(state, questions) {
      const s = state as {
        claim?: string;
        owner_messages?: Record<string, string>;
        older_lines?: Record<string, string>;
        forgotten?: Record<string, string>;
      };
      const item: Asked = {
        claim: s.claim ?? "",
        messages: Object.values(s.owner_messages ?? {}),
        older: Object.values(s.older_lines ?? {}),
        forgotten: Object.values(s.forgotten ?? {}),
      };
      asked.push(item);
      const verdict = rule(item);
      const answers: Record<string, { type: "noul"; noul: number }> = {};
      const mKeys = Object.keys(questions).filter((k) => k.startsWith("m"));
      const last = mKeys.at(-1);
      for (const key of Object.keys(questions)) {
        let p = 0.05;
        if (key === last) p = verdict.support;
        if (key.startsWith("o")) {
          const line = s.older_lines?.[key] ?? "";
          p = verdict.replaces?.some((words) => line.includes(words))
            ? 0.9
            : 0.05;
        }
        answers[key] = { type: "noul", noul: p };
      }
      return { model: "typesafe/jev-1.13-20260917", answers };
    },
  };
  return { asker, asked };
}

const supportive = () => judgeOf(() => ({ support: 0.9 }));

async function setup(
  answer: () => ExtractedFact[] | Promise<ExtractedFact[]>,
  judge: ReturnType<typeof judgeOf> | null = supportive(),
) {
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
  const extracted: Array<{
    messages: readonly string[];
    notebook: readonly string[];
  }> = [];
  const hook = createStandingHook({
    database,
    store,
    extract: async (input) => {
      extracted.push(input);
      return answer();
    },
    asker: judge?.asker ?? null,
  });
  const threadId = `${prefix}-thread-${randomUUID()}`;
  return { owner, bot, store, hook, threadId, extracted, judge };
}

const SAID = "정산 자료는 매달 5일까지 세무사님한테 넘겨야 해";
const FACT = "매출 정산 자료: 매달 5일까지 세무사님에게 넘김";
const LOOKUP = "한일포장 배송 조건 좀 확인해 줘";
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
  test("is added to 수첩 as the night's line, judged before the write, with the quoted message as its evidence, and reaches the prompt", async () => {
    const { owner, bot, store, hook, threadId, extracted, judge } = await setup(
      () => [{ line: FACT, quote: SAID }],
    );
    const counts = await hook({
      botId: bot.id,
      threadId,
      owner: said(threadId, LOOKUP, SAID),
    });
    expect(counts).toMatchObject({ added: 1, unquoted: 0, unsupported: 0 });
    expect(extracted[0]).toEqual({ messages: [LOOKUP, SAID], notebook: [] });
    // The judge read the line against the quoted message and the one before it, before the write.
    expect(judge?.asked).toEqual([
      { claim: FACT, messages: [LOOKUP, SAID], older: [], forgotten: [] },
    ]);
    const [row] = await rowsOf(bot.id);
    expect(row).toMatchObject({
      content: FACT,
      source: "night",
      forgottenAt: null,
      evidenceThreadId: threadId,
      evidenceMessageId: "u1",
      evidenceExcerpt: SAID,
    });
    expect(row?.confidence).toBeCloseTo(0.9, 3);
    expect(row?.curatedAt).not.toBeNull();
    const [line] = await store.list(bot.id, owner.id);
    expect(line).toMatchObject({ source: "night", confirmed: false });
    // Confirmed by evidence at the write: the judge's support is the line's confidence.
    expect(line?.evidence).toMatchObject({
      trust: "evidence",
      messageId: "u1",
      excerpt: SAID,
    });
    const carried = carriedMemoriesOf(
      await selectNotebookRows(database, [bot.id], owner.id),
    );
    expect(carried.memories).toEqual([FACT]);
    // Counts only in the log, never the line nor the quote.
    expect(added().at(-1)).toMatchObject({ bot: bot.id, added: 1 });
    expect(JSON.stringify(added())).not.toContain("세무사");

    // The same words the next night: the store's own word-for-word check, no judge asked.
    const again = await hook({
      botId: bot.id,
      threadId,
      owner: said(threadId, SAID),
    });
    expect(again).toMatchObject({ added: 0, duplicate: 1 });
    expect(judge?.asked).toHaveLength(1);
    expect(extracted[1]?.notebook).toEqual([FACT]);
    expect(await rowsOf(bot.id)).toHaveLength(1);
  });

  test("a correction is written, and the judge retires the value it corrects; the lost row's terse line too", async () => {
    const corrected = "매출 정산 자료: 매달 10일까지 세무사님에게 넘김";
    const change = "정산 자료는 이제 매달 10일까지야";
    const morning =
      "주말 출고 체크리스트 항목 좀 뽑아줘. 주말 포장은 민수가 토요일에 나와서 해.";
    const afternoon =
      "체크리스트 맨 위에 넣을 한 줄 제목 지어줘. 아, 아까 민수 토요일에 나온다고 했는데 일요일로 바꿨어.";
    const { owner, bot, store, hook, threadId } = await setup(
      () => [
        { line: corrected, quote: change },
        {
          line: "민수: 일요일 출근",
          quote: "아까 민수 토요일에 나온다고 했는데 일요일로 바꿨어",
        },
      ],
      judgeOf(({ claim }) => ({
        support: 0.9,
        replaces: claim.includes("10일") ? ["5일까지"] : [],
      })),
    );
    const old = await store.remember(bot.id, owner.id, FACT);
    const counts = await hook({
      botId: bot.id,
      threadId,
      owner: said(threadId, morning, change, afternoon),
    });
    expect(counts).toMatchObject({ added: 2, superseded: 1, duplicate: 0 });
    const rows = await rowsOf(bot.id);
    expect(rows.find((row) => row.id === old?.id)).toMatchObject({
      forgottenBy: "curation",
      forgetReason: "superseded",
    });
    const fresh = rows.find((row) => row.content === corrected);
    expect(fresh).toMatchObject({
      source: "night",
      supersedes: old?.id,
      evidenceMessageId: "u1",
      evidenceExcerpt: change,
    });
    expect(rows.find((row) => row.id === old?.id)?.replacedBy).toBe(
      fresh?.id ?? "",
    );
    expect(
      rows.find((row) => row.content === "민수: 일요일 출근"),
    ).toMatchObject({ evidenceMessageId: "u2", forgottenAt: null });
    const carried = carriedMemoriesOf(
      await selectNotebookRows(database, [bot.id], owner.id),
    );
    expect(carried.memories).toEqual([corrected, "민수: 일요일 출근"]);
  });

  test("another person with the same days is not swallowed, and an owner's line is never retired", async () => {
    const haeun = "하은이도 화요일 목요일에 나와";
    const { owner, bot, store, hook, threadId } = await setup(
      () => [
        { line: "하은: 화요일 목요일 출근", quote: haeun },
        {
          line: "매출 정산 자료: 매달 10일까지",
          quote: "정산 자료는 이제 매달 10일까지야",
        },
      ],
      judgeOf(({ claim }) => ({
        support: 0.9,
        // The judge would retire the owner's own line; the night never offers it.
        replaces: claim.includes("10일") ? ["5일까지"] : [],
      })),
    );
    await store.remember(bot.id, owner.id, "지은: 화요일 목요일 출근");
    await store.remember(bot.id, owner.id, FACT, { source: "owner" });
    const counts = await hook({
      botId: bot.id,
      threadId,
      owner: said(threadId, haeun, "정산 자료는 이제 매달 10일까지야"),
    });
    expect(counts).toMatchObject({ added: 2, superseded: 0, duplicate: 0 });
    const live = (await rowsOf(bot.id)).filter(
      (row) => row.forgottenAt === null,
    );
    expect(live.map((row) => row.content).sort()).toEqual(
      [
        "지은: 화요일 목요일 출근",
        "하은: 화요일 목요일 출근",
        FACT,
        "매출 정산 자료: 매달 10일까지",
      ].sort(),
    );
  });

  test("the judge refuses what the floor cannot: another person, a dropped negation, a changed recurrence, 10시 read as 10만", async () => {
    const card = "카드 결제는 안 받아";
    const weekly = "기획전 신청은 매주 금요일까지야";
    const free = "10시 전 주문이면 무료배송이야";
    const { bot, hook, threadId, judge } = await setup(
      () => [
        { line: "민수: 화요일 목요일만 나와", quote: JIEUN },
        { line: "카드 결제 받음", quote: card },
        { line: "기획전 신청: 매일 금요일까지", quote: weekly },
        { line: "배송: 10만 원 이상 무료", quote: free },
        { line: FACT, quote: SAID },
      ],
      judgeOf(({ claim }) => ({ support: claim === FACT ? 0.9 : 0.1 })),
    );
    const counts = await hook({
      botId: bot.id,
      threadId,
      owner: said(threadId, JIEUN, card, weekly, free, SAID),
    });
    // Each passed the floor — the quote is the owner's, the figure (10) is in it — and the judge read it.
    expect(judge?.asked.map((a) => a.claim)).toEqual([
      "민수: 화요일 목요일만 나와",
      "카드 결제 받음",
      "기획전 신청: 매일 금요일까지",
      "배송: 10만 원 이상 무료",
      FACT,
    ]);
    expect(counts).toMatchObject({ added: 1, unsupported: 4, unquoted: 0 });
    expect((await rowsOf(bot.id)).map((row) => row.content)).toEqual([FACT]);
  });

  test("the floor alone, no judge asked: a page's claim; a figure in the quote, not merely the message; folded digits", async () => {
    const page = "한일포장: 주문 시 선결제, 50,000원 이상 무료배송";
    const priceLater = "유자는 청운농원에서 1kg에 받아, 18,000원이야";
    const wide = "유자는 1kg에 １８,０００원에 받아";
    const { bot, hook, threadId, judge } = await setup(() => [
      // Codex's case: the request holds the supplier and the word, the page added the amount.
      { line: "한일포장: 50,000원 이상 무료배송", quote: LOOKUP },
      // The page's own words.
      { line: page, quote: page },
      // Too short to be a statement.
      { line: "한일포장: 선결제", quote: "한일포장" },
      // The figure is in the message, but not in the quote: not evidence for the figure.
      { line: "유자: 1kg에 18,000원", quote: "유자는 청운농원에서 1kg에 받아" },
      // Full-width digits in the owner's message: the quote is found, and so is its figure.
      { line: "유자: 1kg에 18,000원", quote: wide },
    ]);
    const counts = await hook({
      botId: bot.id,
      threadId,
      owner: said(threadId, LOOKUP, SAID, priceLater, wide),
    });
    expect(counts).toMatchObject({ added: 1, unquoted: 4 });
    expect(judge?.asked.map((a) => a.claim)).toEqual(["유자: 1kg에 18,000원"]);
    expect((await rowsOf(bot.id)).map((row) => row.evidenceMessageId)).toEqual([
      "u3",
    ]);
  });

  test("a line the owner forgot is never written again: word for word by the store, restated by the forget rule, and by the judge", async () => {
    const { owner, bot, store, hook, threadId, judge } = await setup(
      () => [
        { line: FACT, quote: SAID },
        {
          line: "매출 정산 자료는 매달 5일까지 세무사님에게 넘겨야 한다",
          quote: SAID,
        },
        { line: "세무사 자료 마감: 매달 초", quote: SAID },
      ],
      judgeOf(({ claim, forgotten }) => ({
        support: 0.9,
        ...(claim.includes("매달 초") && forgotten.length > 0 ? {} : {}),
      })),
    );
    const line = await store.remember(bot.id, owner.id, FACT);
    expect(await store.forget(line?.id ?? "", owner.id)).not.toBeNull();
    // The store's own door refuses the night's word-for-word write too (N5).
    await expect(
      store.remember(bot.id, owner.id, FACT, { source: "night" }),
    ).rejects.toBeInstanceOf(MemoryForgottenError);
    const counts = await hook({
      botId: bot.id,
      threadId,
      owner: said(threadId, SAID),
    });
    // Two refused by the forget rule before the judge; the third reached it with the forgotten line.
    expect(counts).toMatchObject({ forgotten: 2 });
    expect(judge?.asked.map((a) => a.claim)).toEqual([
      "세무사 자료 마감: 매달 초",
    ]);
    expect(judge?.asked[0]?.forgotten).toEqual([FACT]);
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

  test("a conversation dropped while the extractor was thinking writes nothing", async () => {
    let kept = true;
    const { bot, hook, threadId, judge } = await setup(async () => {
      kept = false;
      return [{ line: FACT, quote: SAID }];
    });
    const counts = await hook({
      botId: bot.id,
      threadId,
      owner: said(threadId, SAID),
      kept: () => kept,
    });
    expect(counts).toMatchObject({ added: 0 });
    expect(judge?.asked).toEqual([]);
    expect(await rowsOf(bot.id)).toEqual([]);
  });

  test("two closes of one Bot at once write one after the other, and the second sees the first's line", async () => {
    const { bot, store, threadId } = await setup(() => []);
    let inFlight = 0;
    let most = 0;
    const counting = {
      ...store,
      remember: async (...args: Parameters<typeof store.remember>) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return store.remember(...args);
      },
    };
    const hook = createStandingHook({
      database,
      store: counting,
      extract: async () => [{ line: FACT, quote: SAID }],
      asker: supportive().asker,
    });
    const [one, two] = await Promise.all([
      hook({ botId: bot.id, threadId, owner: said(threadId, SAID) }),
      hook({ botId: bot.id, threadId, owner: said(threadId, SAID) }),
    ]);
    expect(most).toBe(1);
    expect([one.added, two.added].sort()).toEqual([0, 1]);
    expect([one.duplicate, two.duplicate].sort()).toEqual([0, 1]);
    expect(await rowsOf(bot.id)).toHaveLength(1);
  });

  test("the judge down, or absent, writes nothing that night, and the close is not failed", async () => {
    const failing: JevAsker = {
      async ask() {
        throw new Error("jev: down");
      },
    };
    const { bot, store, threadId } = await setup(() => []);
    const down = createStandingHook({
      database,
      store,
      extract: async () => [
        { line: FACT, quote: SAID },
        { line: "지은: 화요일 목요일 출근", quote: JIEUN },
      ],
      asker: failing,
    });
    expect(
      await down({
        botId: bot.id,
        threadId,
        owner: said(threadId, SAID, JIEUN),
      }),
    ).toMatchObject({ added: 0, unjudged: 2 });
    const none = createStandingHook({
      database,
      store,
      extract: async () => [{ line: FACT, quote: SAID }],
      asker: null,
    });
    expect(
      await none({ botId: bot.id, threadId, owner: said(threadId, SAID) }),
    ).toMatchObject({ added: 0, unjudged: 1 });
    expect(await rowsOf(bot.id)).toEqual([]);
  });

  test("a night write through the store carries the evidence the store's hook finds, as a Bot's does (N5)", async () => {
    const { owner, bot, threadId } = await setup(() => []);
    const hooked = createAgentMemoryStore(database, {
      evidenceFor: () => ({ threadId, messageId: "u9", excerpt: "말한 것" }),
    });
    const row = await hooked.remember(bot.id, owner.id, FACT, {
      source: "night",
    });
    expect(row?.evidence).toMatchObject({ messageId: "u9", trust: "inferred" });
    const theirs = await hooked.remember(bot.id, owner.id, "내 줄", {
      source: "owner",
    });
    expect(theirs?.evidence.messageId).toBeNull();
  });
});

describe("the hourly curation and a night line", () => {
  test("a night line is judged at its write, not again by the hour; a newer Bot line the judge is sure of supersedes it", async () => {
    const { owner, bot, store, hook, threadId } = await setup(() => [
      { line: "포장 알바 지은이: 화요일, 목요일 출근", quote: JIEUN },
    ]);
    const t0 = new Date(Date.now() - 60 * 60_000);
    const history: StampedMessage[] = [
      { id: "u0", role: "user", content: JIEUN, lafAt: t0.toISOString() },
      {
        id: "u1",
        role: "user",
        content: "지은이 이제 수요일만 나와",
        lafAt: t0.toISOString(),
      },
    ] as never;
    expect(
      await hook({ botId: bot.id, threadId, owner: said(threadId, JIEUN) }),
    ).toMatchObject({ added: 1 });
    // The Bot, in a later turn, remembers the change; the hour judges that line.
    const newer = await store.remember(
      bot.id,
      owner.id,
      "포장 알바 지은이: 수요일 출근",
      {
        evidence: {
          threadId,
          messageId: "u1",
          excerpt: "지은이 이제 수요일만",
        },
      },
    );
    await database
      .update(agentMemories)
      .set({ createdAt: t0, evidenceThreadId: threadId })
      .where(eq(agentMemories.agentId, bot.id));
    await database
      .update(agentMemories)
      .set({ createdAt: new Date(t0.getTime() + 60_000) })
      .where(eq(agentMemories.id, newer?.id ?? ""));
    const { asker, asked } = judgeOf(() => ({
      support: 0.9,
      replaces: ["화요일, 목요일"],
    }));
    const curator = createMemoryCurator({
      database,
      asker,
      history: async () => history,
      now: () => new Date(Date.now() + 20 * 60_000),
    });
    const [run] = await curator.runOnce();
    // One candidate: the night line was judged when written and is not judged again.
    expect(asked.map((a) => a.claim)).toEqual([
      "포장 알바 지은이: 수요일 출근",
    ]);
    expect(run).toMatchObject({ checked: 1, confirmed: 1, superseded: 1 });
    const rows = await rowsOf(bot.id);
    expect(rows.find((row) => row.source === "night")).toMatchObject({
      forgottenBy: "curation",
      forgetReason: "superseded",
      replacedBy: newer?.id,
    });
  });
});
