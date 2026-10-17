import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import {
  contextFactsFor,
  contextLayerText,
  systemPromptText,
} from "../../shared/prompt";
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
 * notebook or of the browser's cookies holds the company's file name or room name — the shape of
 * the product's password tests (CLAUDE.md, "Never record what somebody typed"). And the person's
 * own conversation, notebook and logins are what they were.
 *
 * Every row is written through the paths the product writes them by where one exists: the
 * conversation through `appendMessages`, which marks the hub's results; the context through the
 * conversation store. The browser is a jar of cookies by origin — the per-origin delete itself is
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
): PrepareInput {
  const now = new Date("2026-10-16T01:00:00Z");
  const facts = contextFactsFor({
    mode: "chat",
    now,
    timeZone: "Asia/Seoul",
    bot: { id: botId, name: "미소" },
    toolNames,
    person: { timeZone: "Asia/Seoul" },
  });
  return {
    threadId,
    botId,
    mode: "chat",
    messages: [{ id: "u1", role: "user", content: OWN_ASK }] as never,
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
  return JSON.stringify({
    messages,
    notebook,
    contexts,
    runs,
    outbox,
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

    // The notebook: the person's own line, and one learned in the room.
    await database.insert(agentMemories).values([
      {
        id: `${suite}-own`,
        agentId: botId,
        ownerUserId: userId,
        content: OWN_FACT,
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

    // The conversations as the context store holds them: frozen with the hub's tools named.
    const conversations = createConversationStore({
      persistence: conversationPersistence(database),
    });
    const attached = conversations.prepare(
      prepareInput(botId, chat, HUB_TOOLS),
    );
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
    // The notebook: the own line live and as it was; the room's retired and blanked.
    const lines = await database
      .select()
      .from(agentMemories)
      .where(eq(agentMemories.agentId, botId));
    const own = lines.find((line) => line.id === `${suite}-own`);
    const company = lines.find((line) => line.id === `${suite}-company`);
    expect(own?.content).toBe(OWN_FACT);
    expect(own?.forgottenAt).toBeNull();
    expect(company?.forgottenAt).not.toBeNull();
    expect(company?.forgetReason).toBe("company_left");
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
