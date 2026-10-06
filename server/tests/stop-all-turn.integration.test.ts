/**
 * `모두 멈추기` reaches a turn the server owns.
 *
 * The press and the turn are each held on their own: `stop-all.test.ts` presses the door over work
 * that is a double, and `turn-engine.integration.test.ts` stops a turn by its conversation
 * (`engine.stop`). What joins them is one registration — a turn lists itself as work in flight, with
 * the function that stops it, from the moment it is accepted (`turns/engine.ts`, `send`) — and
 * nothing pressed it. Measured 2026-10-06: with the registration taken out both of those files
 * still passed, while the press here counted no conversation — and it stops only what it counts.
 *
 * The window's runner listed its runs the same way, and `chat-stop.integration.test.ts` held the
 * join for that path until both went with the run door (2026-10-06). This is it for the path the
 * product has: a real engine with a turn in flight, a real ledger and thread store, and the press
 * itself (`createStopAll`) reading the same list — nothing standing in between them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, lafThreadMessages, lafThreadRuns } from "../src/db/schema";
import { createWorkInFlight } from "../src/runner/in-flight";
import { createRunLedger } from "../src/runner/run-ledger";
import { createStopAll } from "../src/runner/stop-all";
import { messagesFor } from "../src/runner/thread-store";
import type { LoopAgent } from "../src/runner/turn-loop";
import { createTurnEngine } from "../src/turns/engine";
import { createTurnHub } from "../src/turns/hub";
import { TEST_POOL } from "./support/database";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("모두 멈추기 and a turn the server owns", () => {
  const database = createDatabase(databaseUrl ?? "", TEST_POOL);
  const run = randomUUID().slice(0, 8);
  const OWNER = `stop-all-turn-${run}`;
  const BOT = `stop-all-turn-bot-${run}`;
  const threadId = `stop-all-turn-thread-${run}`;

  beforeAll(async () => {
    // The ledger's row names its Bot by a key; nothing else a turn writes needs a row to be there.
    await database.insert(agents).values({
      id: BOT,
      name: "모두 멈추기 비서",
      type: "remote_ag_ui",
      configuration: {},
    });
  });

  // Only what this file made: one conversation's runs and messages, and its Bot, by identity.
  afterAll(async () => {
    await database
      .delete(lafThreadRuns)
      .where(eq(lafThreadRuns.threadId, threadId));
    await database
      .delete(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
    await database.delete(agents).where(inArray(agents.id, [BOT]));
    await database.$client.close();
  });

  /** A Bot that asks for one browser step and would answer on its second run, if it had one. */
  function aBotMidTask() {
    const bot = {
      messages: [] as Message[],
      runs: 0,
      setMessages(messages: Message[]) {
        bot.messages = [...messages];
      },
      addMessage(message: Message) {
        bot.messages.push(message);
      },
      async runAgent(
        _input: unknown,
        subscriber?: { onRunFinishedEvent?: () => unknown },
      ) {
        bot.runs += 1;
        bot.messages.push({
          id: `a-${randomUUID()}`,
          role: "assistant",
          content: bot.runs === 1 ? "찾아볼게요." : "다 됐어요.",
          ...(bot.runs === 1
            ? {
                toolCalls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "computer_navigate",
                      arguments: '{"url":"https://example.com"}',
                    },
                  },
                ],
              }
            : {}),
        } as Message);
        subscriber?.onRunFinishedEvent?.();
        return { result: undefined, newMessages: [] };
      },
    };
    return bot;
  }

  async function until(check: () => Promise<boolean>, ms = 5000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("timed out waiting");
  }

  const statusOf = async (runId: string) =>
    (
      await database
        .select({ status: lafThreadRuns.status })
        .from(lafThreadRuns)
        .where(eq(lafThreadRuns.runId, runId))
    )[0]?.status;

  test("one press stops a turn in flight, and the turn ends as one the person stopped", async () => {
    // The one list the engine writes to and the press reads from, as `main.ts` hands it to both.
    const work = createWorkInFlight();
    const stopAll = createStopAll({ work });
    const bot = aBotMidTask();
    /** Settles when the Bot's step has been handed to its tool: the turn is in flight from here. */
    let stepIsOut: () => void = () => {};
    const out = new Promise<void>((resolve) => {
      stepIsOut = resolve;
    });
    const engine = createTurnEngine({
      database,
      ledger: createRunLedger(database),
      hub: createTurnHub({ keepEndedMs: 50 }),
      work,
      resolveAgents: async () => ({ [BOT]: bot as unknown as LoopAgent }),
      tools: async () => ({
        tools: [
          { name: "computer_navigate", description: "go", parameters: {} },
        ],
        // A step that ends only when it is stopped — a page that never finishes loading.
        execute: (_name, _args, call) =>
          new Promise((resolve) => {
            call.signal.addEventListener(
              "abort",
              () => resolve({ ok: false, code: "laf:stopped", stopped: true }),
              { once: true },
            );
            stepIsOut();
          }),
      }),
    });
    const person = { id: OWNER };
    const mayDrive = async () => true;

    try {
      const sent = await engine.send({
        threadId,
        channelId: `stop-all-turn-channel-${run}`,
        owner: { id: OWNER, role: "user" },
        botId: BOT,
        messages: [
          { id: randomUUID(), role: "user", content: "오래 걸리는 일" },
        ],
        tools: null,
      });
      if (!sent.ok) throw new Error(`not sent: ${sent.code}`);
      await out;

      // What the confirm dialog counts before the press: this conversation, by its thread.
      expect(await stopAll.running(person, mayDrive)).toEqual({
        running: { chat: 1, routine: 0 },
        chats: [threadId],
      });
      // Nobody else's list holds it.
      expect(work.of("somebody-else")).toEqual([]);

      expect(await stopAll.stopAll(person, mayDrive)).toEqual({
        stopped: { chat: 1, routine: 0 },
        notStopped: { chat: 0, routine: 0 },
        chats: { stopped: [threadId], notStopped: [] },
      });

      // Said stopped, and stopped: the ledger's row, the step it cut, and the model not asked again.
      await until(async () => (await statusOf(sent.turnId)) === "stopped");
      const cut = (await messagesFor(database, threadId)).find(
        (message) => message.role === "tool",
      );
      expect(JSON.parse(String(cut?.content))).toMatchObject({
        code: "laf:stopped",
        stopped: true,
      });
      expect(bot.runs).toBe(1);
      // And over everywhere it was going on: the conversation is free, and off the list.
      expect(engine.busy(threadId)).toBe(false);
      expect(work.of(OWNER)).toEqual([]);
    } finally {
      // A turn the press did not reach must not go on after the file: stopped by its conversation.
      await engine.stopFor(OWNER);
    }
  });
});
