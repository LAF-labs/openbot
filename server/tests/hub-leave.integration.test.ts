import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import {
  contextFactsFor,
  contextLayerText,
  systemPromptText,
} from "../../shared/prompt";
import { dayLabel } from "../../shared/prompt/zone";
import {
  conversationPersistence,
  createConversationStore,
  type PrepareInput,
} from "../src/context/conversations";
import { createDatabase } from "../src/db/client";
import {
  agentMemories,
  agents,
  hubCursor,
  hubOutbox,
  lafConversationContexts,
  lafRoutineNotepads,
  lafRoutineRuns,
  lafRoutines,
  lafThreadMessages,
  lafThreadRuns,
  users,
} from "../src/db/schema";
import { leaveCompanyIfDetached } from "../src/hub/leave";
import {
  appendMessages,
  LEFT_COMPANY_RESULT,
  messagesFor,
} from "../src/runner/thread-store";
import { TEST_POOL } from "./support/database";

/**
 * LEAVING A COMPANY, SERIALISED: after the leave, nothing this VM keeps of a conversation, of the
 * notebook, of a routine's notepad or of the browser's cookies holds the company's file name or
 * room name — the shape of the product's password tests (CLAUDE.md, "Never record what somebody
 * typed"). Nor does what a model wrote from them: a day summary read off the hub's answers, a
 * close waiting to be taken, a notebook line learned with them in front of it, as the frozen
 * layer draws it. And the person's own conversation, notebook, notepad and logins are what they were.
 *
 * Every row is written through the paths the product writes them by where one exists: the
 * conversation through `appendMessages`, which marks the hub's results; the context, its day
 * summary and the close waiting behind it through the conversation store. The browser is a jar of cookies by origin — the per-origin delete itself is
 * measured on a real Chromium in `agent-computer/tests/forget-cookies.test.ts`.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suite = `leave-${randomUUID().slice(0, 8)}`;

/** The company's words: they must be nowhere after the leave, and somewhere before it. */
const FILE_NAME = "거래처단가표_가을개정.xlsx";
const ROOM_NAME = "영업삼팀 단톡방";
const COMPANY_LOGIN = "https://wing.company-vault.test";

/** The person's own: these must be exactly where they were. */
const OWN_FACT = "사장님은 택배를 우체국으로 보낸다.";
const OWN_ASK = "내일 아침 날씨 알려 줘";
const OWN_LOGIN = "https://my.own-bank.test";
/** Learned in the question the hub answered, and said right by the person: theirs, kept. */
const VOUCHED = "사장님은 단가표를 매주 월요일에 본다.";
/** Learned in the same question, and never said right: written from the company's words. */
const HEARD = `${FILE_NAME}의 단가는 금요일마다 바뀐다.`;
const OWN_NOTE = "송장 17번까지 확인";

const madeUsers: string[] = [];
const madeBots: string[] = [];
const madeThreads: string[] = [];

afterEach(async () => {
  const threads = madeThreads.splice(0);
  if (threads.length) {
    await database
      .delete(lafThreadMessages)
      .where(inArray(lafThreadMessages.threadId, threads));
    await database
      .delete(lafThreadRuns)
      .where(inArray(lafThreadRuns.threadId, threads));
  }
  // The memories and contexts cascade with the Bot.
  const bots = madeBots.splice(0);
  if (bots.length)
    await database.delete(agents).where(inArray(agents.id, bots));
  const people = madeUsers.splice(0);
  if (people.length)
    await database.delete(users).where(inArray(users.id, people));
  await database.delete(hubOutbox).where(like(hubOutbox.id, `${suite}%`));
  await database.delete(hubCursor);
});

afterAll(async () => {
  await database.$client.close();
});

async function aPersonAndBot() {
  const userId = `${suite}-user-${randomUUID().slice(0, 8)}`;
  await database
    .insert(users)
    .values({ id: userId, email: `${userId}@example.test`, name: "사장님" });
  madeUsers.push(userId);
  const botId = `${suite}-bot-${randomUUID().slice(0, 8)}`;
  await database.insert(agents).values({
    id: botId,
    name: "미소",
    type: "remote_ag_ui",
    configuration: {},
  });
  madeBots.push(botId);
  return { userId, botId };
}

const HUB_TOOLS = ["mcp__hub__read", "mcp__hub__write"];

function prepareInput(
  botId: string,
  threadId: string,
  toolNames: readonly string[],
  thread: {
    messages?: readonly unknown[];
    now?: Date;
    memories?: string[];
  } = {},
): PrepareInput {
  const now = thread.now ?? new Date("2026-10-16T01:00:00Z");
  const facts = contextFactsFor({
    mode: "chat",
    now,
    timeZone: "Asia/Seoul",
    bot: { id: botId, name: "미소" },
    toolNames,
    memories: thread.memories ?? [],
    person: { timeZone: "Asia/Seoul" },
  });
  return {
    threadId,
    botId,
    mode: "chat",
    messages: (thread.messages ?? [
      { id: "u1", role: "user", content: OWN_ASK },
    ]) as never,
    key: { harness: "h1", model: "m", effort: "balanced", tools: "t1" },
    facts,
    system: (told) => systemPromptText("chat", contextLayerText(told)),
    now,
  };
}

/** Everything this VM keeps that the test made, as one string. */
async function serialised(input: {
  botId: string;
  threads: string[];
  jar: Map<string, string[]>;
}): Promise<string> {
  const messages = await database
    .select()
    .from(lafThreadMessages)
    .where(inArray(lafThreadMessages.threadId, input.threads));
  const notebook = await database
    .select()
    .from(agentMemories)
    .where(eq(agentMemories.agentId, input.botId));
  const contexts = await database
    .select()
    .from(lafConversationContexts)
    .where(inArray(lafConversationContexts.threadId, input.threads));
  const runs = await database
    .select()
    .from(lafThreadRuns)
    .where(inArray(lafThreadRuns.threadId, input.threads));
  const outbox = await database
    .select()
    .from(hubOutbox)
    .where(like(hubOutbox.id, `${suite}%`));
  const notepads = await database
    .select({ entries: lafRoutineNotepads.entries })
    .from(lafRoutineNotepads)
    .innerJoin(lafRoutines, eq(lafRoutines.id, lafRoutineNotepads.routineId))
    .where(eq(lafRoutines.agentId, input.botId));
  return JSON.stringify({
    messages,
    notebook,
    contexts,
    runs,
    outbox,
    notepads,
    cookies: [...input.jar.entries()],
  });
}

describe("a VM detached from its company", () => {
  test("keeps no company file name or room name in messages, notebook or cookies — and keeps the person's own", async () => {
    const { userId, botId } = await aPersonAndBot();
    const chat = `${suite}-chat`;
    const room = `room:${suite}`;
    const delegated = `room:${suite}.browse`;
    madeThreads.push(chat, room, delegated);

    // The person's own conversation, with one hub call in it — the result is the company's words.
    await appendMessages(database, chat, [
      { id: "m1", role: "user", content: OWN_ASK },
      {
        id: "m2",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_hub",
            type: "function",
            function: {
              name: "mcp__hub__read",
              arguments: JSON.stringify({ kind: "search", query: "단가" }),
            },
          },
          {
            id: "call_own",
            type: "function",
            function: { name: "now", arguments: "{}" },
          },
        ],
      },
      {
        id: "m3",
        role: "tool",
        toolCallId: "call_hub",
        content: JSON.stringify({
          source: "회사",
          hits: [{ title: FILE_NAME, where: ROOM_NAME }],
        }),
      },
      {
        id: "m4",
        role: "tool",
        toolCallId: "call_own",
        content: "2026-10-16 10:00 (목)",
      },
      { id: "m5", role: "assistant", content: "찾았어요." },
      { id: "m6", role: "user", content: "택배는 우체국으로 보내" },
      { id: "m7", role: "assistant", content: "기억해 둘게요." },
    ] as never);
    // A room's conversation and the run it handed browsing to: the company's, whole.
    await appendMessages(database, room, [
      {
        id: "r1",
        role: "user",
        content: `${ROOM_NAME}: ${FILE_NAME} 확인 부탁`,
      },
      { id: "r2", role: "assistant", content: `${FILE_NAME} 열어 볼게요.` },
    ] as never);
    await appendMessages(database, delegated, [
      { id: "b1", role: "user", content: `${FILE_NAME} 찾기` },
    ] as never);
    await database.insert(lafThreadRuns).values({
      runId: `${suite}-run`,
      threadId: room,
      agentId: botId,
      userId,
      status: "done",
    } as never);

    /*
     * The notebook: the person's own line, one learned in the room, and two learned in the question
     * the hub answered — one the person said is right, one nobody did.
     */
    await database.insert(agentMemories).values([
      {
        id: `${suite}-own`,
        agentId: botId,
        ownerUserId: userId,
        content: OWN_FACT,
        evidenceThreadId: chat,
        evidenceMessageId: "m6",
        evidenceExcerpt: "택배는 우체국으로 보내",
      },
      {
        id: `${suite}-vouched`,
        agentId: botId,
        ownerUserId: userId,
        content: VOUCHED,
        confirmedAt: new Date(),
        evidenceThreadId: chat,
        evidenceMessageId: "m1",
        evidenceExcerpt: OWN_ASK,
      },
      {
        id: `${suite}-heard`,
        agentId: botId,
        ownerUserId: userId,
        content: HEARD,
        evidenceThreadId: chat,
        evidenceMessageId: "m1",
        evidenceExcerpt: OWN_ASK,
      },
      {
        id: `${suite}-company`,
        agentId: botId,
        ownerUserId: userId,
        content: `${ROOM_NAME}에서는 ${FILE_NAME}을 금요일에 고친다.`,
        evidenceThreadId: room,
        evidenceMessageId: "r1",
        evidenceExcerpt: `${ROOM_NAME}: ${FILE_NAME}`,
      },
    ]);

    /*
     * Two routines with a notepad each: one whose run read the hub — its note is the company's —
     * and one whose run only told the time.
     */
    const routine = (id: string, called: string, note: string) => ({
      row: {
        id,
        agentId: botId,
        name: id,
        instruction: "매일 확인",
        scheduleKind: "daily" as const,
        dailyLocal: "09:00",
        dailyTimeZone: "Asia/Seoul",
        createdById: userId,
        createdByRole: "user",
        nextRunAt: new Date(),
      },
      run: {
        id: `${id}-run`,
        routineId: id,
        startedAt: new Date(),
        ok: true,
        answer: "확인했어요.",
        steps: [{ ms: 10, text: 5, calls: [{ name: called, ok: true }] }],
      },
      notepad: {
        routineId: id,
        entries: [
          {
            key: "where",
            kind: "note",
            value: note,
            at: new Date().toISOString(),
          },
        ],
        version: 1,
        writtenByRun: `${id}-run`,
      },
    });
    const routines = [
      routine(`${suite}-team`, "mcp__hub__read", `${ROOM_NAME} 글 40번까지`),
      routine(`${suite}-mine`, "now", OWN_NOTE),
    ];
    await database.insert(lafRoutines).values(routines.map((one) => one.row));
    await database
      .insert(lafRoutineRuns)
      .values(routines.map((one) => one.run) as never);
    await database
      .insert(lafRoutineNotepads)
      .values(routines.map((one) => one.notepad) as never);

    // What was on its way to the hub, and where the VM was in the hub's events.
    await database.insert(hubOutbox).values({
      id: `${suite}-post`,
      method: "POST",
      path: "/rooms/r_1/messages",
      body: { text: `${ROOM_NAME}에 ${FILE_NAME} 올렸어요` },
      origin: "chat",
    });
    await database
      .insert(hubCursor)
      .values({ one: true, hub: "https://co.hub.test", seq: 42 })
      .onConflictDoUpdate({
        target: hubCursor.one,
        set: { hub: "https://co.hub.test", seq: 42 },
      });

    /*
     * The conversations as the context store holds them: frozen with the hub's tools named and the
     * notebook drawn. The person's conversation closed its day on a summary of what it read — the
     * summariser is handed the hub's answer, and writes from it, as the real one does — and a
     * second close waits for the next message, carrying the first one's lines forward.
     */
    const today = dayLabel(new Date(), "Asia/Seoul");
    const shortToday = `${Number(today.slice(5, 7))}/${Number(today.slice(8, 10))}`;
    let clock = Date.now() + 2 * 86_400_000;
    const conversations = createConversationStore({
      persistence: conversationPersistence(database),
      now: () => clock,
      days: {
        summarize: async ({ previous, transcript }) =>
          [
            previous ?? "",
            transcript.includes(FILE_NAME)
              ? `- ${shortToday}: ${FILE_NAME}에서 단가를 찾아 드림.`
              : `- ${shortToday}: 인사를 나눔.`,
          ]
            .filter(Boolean)
            .join("\n"),
        history: (threadId) => messagesFor(database, threadId) as never,
        busy: async () => false,
        fallbackTimeZone: "Asia/Seoul",
        minChars: 1,
      },
    });
    const drawn = { memories: [OWN_FACT, VOUCHED, HEARD] };
    const at = () => new Date(clock);
    conversations.prepare(
      prepareInput(botId, chat, HUB_TOOLS, {
        ...drawn,
        messages: await messagesFor(database, chat),
        now: at(),
      }),
    );
    expect(await conversations.closeNow(chat)).toBe(true);
    await appendMessages(database, chat, [
      { id: "m8", role: "user", content: "고마워" },
      { id: "m9", role: "assistant", content: "네." },
    ] as never);
    const attached = conversations.prepare(
      prepareInput(botId, chat, HUB_TOOLS, {
        ...drawn,
        messages: await messagesFor(database, chat),
        now: at(),
      }),
    );
    expect(attached.epoch.reason).toBe("day_boundary");
    expect(attached.system).toContain(FILE_NAME);
    clock += 86_400_000;
    expect(await conversations.closeNow(chat)).toBe(true);
    conversations.prepare(prepareInput(botId, room, HUB_TOOLS));
    await conversations.settled();
    expect(attached.system).toContain(
      "- 회사: mcp__hub__read, mcp__hub__write",
    );

    // The browser: a company login and the person's own.
    const jar = new Map<string, string[]>([
      [COMPANY_LOGIN, [`session=${ROOM_NAME}`]],
      [OWN_LOGIN, ["session=mine"]],
    ]);
    const asked: string[][] = [];

    const before = await serialised({
      botId,
      threads: [chat, room, delegated],
      jar,
    });
    // Without these the assertions below would pass on a fixture that never held the words.
    expect(before).toContain(FILE_NAME);
    expect(before).toContain(ROOM_NAME);

    const result = await leaveCompanyIfDetached({
      attached: false,
      database,
      conversations,
      loginOrigins: async () => [COMPANY_LOGIN],
      forgetCookies: async (origins) => {
        asked.push([...origins]);
        let forgotten = 0;
        for (const origin of origins) {
          forgotten += jar.get(origin)?.length ?? 0;
          jar.delete(origin);
        }
        return forgotten;
      },
    });
    await conversations.settled();
    expect(result?.done).toBe(true);
    expect(asked).toEqual([[COMPANY_LOGIN]]);

    const after = await serialised({
      botId,
      threads: [chat, room, delegated],
      jar,
    });
    expect(after).not.toContain(FILE_NAME);
    expect(after).not.toContain(ROOM_NAME);

    // The person's own conversation: every message where it was, the hub's result blanked in place.
    const kept = await messagesFor(database, chat);
    expect(kept.map((message) => message.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
      "m7",
      "m8",
      "m9",
    ]);
    expect(kept[0]?.content).toBe(OWN_ASK);
    expect(kept[2]?.content).toBe(LEFT_COMPANY_RESULT);
    expect(kept[3]?.content).toBe("2026-10-16 10:00 (목)");
    // A copy of the result built before the leave, handed back by a run, does not write it back.
    await appendMessages(database, chat, [
      {
        id: "m3",
        role: "tool",
        toolCallId: "call_hub",
        content: JSON.stringify({ hits: [{ title: FILE_NAME }] }),
      },
    ] as never);
    expect((await messagesFor(database, chat))[2]?.content).toBe(
      LEFT_COMPANY_RESULT,
    );
    // The room's conversation and its run: gone whole.
    expect(await messagesFor(database, room)).toEqual([]);
    expect(await messagesFor(database, delegated)).toEqual([]);
    /*
     * The notebook: the own line and the one the person said is right live and as they were; the
     * room's, and the one learned from the hub's answer, retired and blanked.
     */
    const lines = await database
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.agentId, botId));
    const line = (id: string) =>
      lines.find((one) => one.id === `${suite}-${id}`);
    expect(line("own")?.content).toBe(OWN_FACT);
    expect(line("own")?.forgottenAt).toBeNull();
    expect(line("vouched")?.content).toBe(VOUCHED);
    expect(line("vouched")?.forgottenAt).toBeNull();
    for (const id of ["company", "heard"]) {
      expect(line(id)?.forgottenAt).not.toBeNull();
      expect(line(id)?.forgetReason).toBe("company_left");
    }
    // The day summary: a gap over its days, and nothing it said.
    const [context] = await database
      .select({ epoch: lafConversationContexts.epoch })
      .from(lafConversationContexts)
      .where(eq(lafConversationContexts.threadId, chat));
    const stood = (context?.epoch as { cut?: { summary: string } } | undefined)
      ?.cut;
    expect(stood?.summary).toMatch(
      new RegExp(
        `^- ${shortToday}~\\d+/\\d+: 이 기간의 대화는 요약되지 않았다\\.$`,
      ),
    );
    // The routine that read the hub starts its next run with an empty notepad; the other as it was.
    const notepads = await database
      .select()
      .from(lafRoutineNotepads)
      .where(
        inArray(
          lafRoutineNotepads.routineId,
          routines.map((one) => one.row.id),
        ),
      );
    const notepad = (id: string) =>
      notepads.find((one) => one.routineId === `${suite}-${id}`);
    expect(notepad("team")?.entries).toEqual([]);
    expect(notepad("team")?.version).toBe(2);
    expect(notepad("mine")?.entries).toEqual([
      expect.objectContaining({ key: "where", value: OWN_NOTE }),
    ]);
    // The person's own login is still in the jar.
    expect(jar.get(OWN_LOGIN)).toEqual(["session=mine"]);
    // Nothing left to say this VM was in a company: the next boot does nothing.
    expect(await database.select().from(hubCursor)).toEqual([]);
    expect(
      await leaveCompanyIfDetached({
        attached: false,
        database,
        conversations,
        loginOrigins: async () => [COMPANY_LOGIN],
      }),
    ).toBeNull();

    /*
     * THE BOT'S NEXT TURN, AFTER THE RESTART THE DETACH MADE: a new epoch, and its frozen layer no
     * longer names the hub's tools. Read back from the row, so a restart between the leave and the
     * next message does not lose it — the key alone would not move (`hub-tools-head.test.ts`).
     */
    const restarted = createConversationStore({
      persistence: conversationPersistence(database),
    });
    await restarted.load();
    const next = restarted.prepare(prepareInput(botId, chat, []));
    expect(next.epoch.reason).toBe("company_left");
    expect(next.system).not.toContain("mcp__hub__");
    expect(next.system).not.toContain("- 회사:");

    // WITHOUT A RESTART: the close that was waiting is not taken by the next message either.
    const going = conversations.prepare(
      prepareInput(botId, chat, [], {
        memories: [OWN_FACT, VOUCHED],
        messages: [
          ...(await messagesFor(database, chat)),
          { id: "m10", role: "user", content: "오늘 일정은?" },
        ],
        now: at(),
      }),
    );
    expect(going.epoch.reason).toBe("company_left");
    expect(going.system).not.toContain(FILE_NAME);
    expect(going.system).toContain("이 기간의 대화는 요약되지 않았다.");
  }, 20_000);

  test("a VM still attached, or never attached, leaves nothing", async () => {
    const conversations = createConversationStore();
    await database
      .insert(hubCursor)
      .values({ one: true, hub: "https://co.hub.test", seq: 7 })
      .onConflictDoUpdate({
        target: hubCursor.one,
        set: { hub: "https://co.hub.test", seq: 7 },
      });
    const leave = {
      database,
      conversations,
      loginOrigins: async () => [],
    };
    expect(
      await leaveCompanyIfDetached({ ...leave, attached: true }),
    ).toBeNull();
    expect(await database.select().from(hubCursor)).toHaveLength(1);
    await database.delete(hubCursor);
    expect(
      await leaveCompanyIfDetached({ ...leave, attached: false }),
    ).toBeNull();
  });

  test("a browser that cannot sign out keeps the cursor, so the next boot tries again", async () => {
    const conversations = createConversationStore();
    await database
      .insert(hubCursor)
      .values({ one: true, hub: "https://co.hub.test", seq: 9 })
      .onConflictDoUpdate({
        target: hubCursor.one,
        set: { hub: "https://co.hub.test", seq: 9 },
      });
    const result = await leaveCompanyIfDetached({
      attached: false,
      database,
      conversations,
      loginOrigins: async () => [COMPANY_LOGIN],
      forgetCookies: async () => {
        throw new Error("computer down");
      },
    });
    expect(result?.done).toBe(false);
    expect(await database.select().from(hubCursor)).toHaveLength(1);
  });
});
