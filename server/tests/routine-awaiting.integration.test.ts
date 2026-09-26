import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent, Message } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import { toolResultText } from "../../shared/prompt/tool-results.ko";
import type { AuditEventInput } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import { ActionNeedsApprovalError } from "../src/computer/gateway/caller";
import { createDatabase } from "../src/db/client";
import { agents, lafRoutineRuns, lafRoutines, users } from "../src/db/schema";
import { createRoutineService } from "../src/routines/service";
import { outcomeOfError } from "../src/runner/unattended";
import { A_CLICK } from "./support/subjects";
import { TEST_POOL } from "./support/database";

/**
 * A routine that met a question nobody could answer, and what the person and the next run read.
 *
 * The run used to append a line to its answer for the person to read, and the line was the refusal
 * envelope's `reason` — the sentence written for the MODEL: "…무엇을 기다리고 있었는지 말하고
 * 멈춰라. 다른 길로 돌아가지 마라." The person read the model's instruction in their conversation,
 * and the next run was fed it back under "What you reported the last time", so it was told to stop
 * before it started (review 2026-09-26, reproduced end to end). The fact goes beside the answer now.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suffix = randomUUID().slice(0, 8);
const PERSON = { id: `routine-awaiting-${suffix}`, role: "user" as const };
const BOT_ID = `routine-awaiting-bot-${suffix}`;
const THE_BOTS_WORDS = "결제 버튼 앞에서 사장님 확인을 기다리고 있어요.";
/** The model's instruction for a question nobody answered — never a person's reading. */
const FOR_THE_MODEL = toolResultText("laf:nobody_answered");

beforeAll(async () => {
  await database.insert(users).values({
    id: PERSON.id,
    email: `${PERSON.id}@laf.test`,
    name: "루틴 대기 테스트",
  });
  await database.insert(agents).values({
    id: BOT_ID,
    name: "결제 비서",
    type: "remote_ag_ui",
    configuration: {},
  });
});

afterAll(async () => {
  // Only this file's rows: its routines and their receipts, its person and its Bot.
  const mine = database
    .select({ id: lafRoutines.id })
    .from(lafRoutines)
    .where(eq(lafRoutines.createdById, PERSON.id));
  await database
    .delete(lafRoutineRuns)
    .where(inArray(lafRoutineRuns.routineId, mine));
  await database
    .delete(lafRoutines)
    .where(eq(lafRoutines.createdById, PERSON.id));
  await database.delete(agents).where(eq(agents.id, BOT_ID));
  await database.delete(users).where(eq(users.id, PERSON.id));
  await database.$client.close();
});

/** Each run: a click first, then the Bot's own words about the wait. Records every instruction. */
function clickingBot() {
  const instructions: string[] = [];
  let turn = 0;
  const agent = {
    messages: [] as Message[],
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
      instructions.push(String(messages[0]?.content ?? ""));
      turn = 0;
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent(
      _input: unknown,
      subscriber?: { onRunFinishedEvent?: () => unknown },
    ) {
      turn += 1;
      agent.messages.push(
        turn === 1
          ? ({
              id: randomUUID(),
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: `click-${randomUUID()}`,
                  type: "function",
                  function: {
                    name: "computer_click",
                    arguments: '{"ref":"e1","snapshotId":1}',
                  },
                },
              ],
            } as Message)
          : ({
              id: randomUUID(),
              role: "assistant",
              content: THE_BOTS_WORDS,
            } as Message),
      );
      subscriber?.onRunFinishedEvent?.();
      return { result: undefined, newMessages: [] };
    },
  };
  return { agent: agent as unknown as AbstractAgent, instructions };
}

describe("a routine that stopped for the person's yes", () => {
  test("the person reads the Bot's words, the fact rides beside them, and the next run is not told to stop", async () => {
    const registry = createApprovalRegistry();
    const bot = clickingBot();
    const delivered: string[] = [];
    const rows: AuditEventInput[] = [];
    const service = createRoutineService({
      database,
      resolveAgents: async () => ({ [BOT_ID]: bot.agent }),
      auditStore: { insert: async (row) => void rows.push(row) },
      deliver: async (delivery) => {
        delivered.push(delivery.answer);
        return null;
      },
      // Every click meets a boundary nobody can answer at this hour, the way the gateway throws it.
      tools: async () => ({
        tools: [],
        execute: async () =>
          outcomeOfError(
            new ActionNeedsApprovalError(
              await registry.request({
                botId: BOT_ID,
                actor: PERSON.id,
                rule: "r",
                subject: A_CLICK,
                fingerprint: randomUUID(),
                target: { type: "computer", id: BOT_ID },
              }),
            ),
          ),
      }),
    });
    const routine = await service.create(PERSON, {
      agentId: BOT_ID,
      name: "아침 결제",
      instruction: "결제해 줘",
      schedule: { kind: "interval", minutes: 60 },
    });

    await service.runNow(PERSON, routine.id);

    // What the person reads is the Bot's own words, and nothing written for the model.
    expect(delivered).toEqual([THE_BOTS_WORDS]);
    expect(delivered[0]).not.toContain(FOR_THE_MODEL);
    expect(delivered[0]).not.toContain("⏸");

    // The fact is beside the answer: on the receipt, and on the trail row.
    const [receipt] = await service.runs(PERSON, routine.id);
    expect(receipt).toMatchObject({
      ok: true,
      answer: THE_BOTS_WORDS,
      awaiting: "laf:awaiting_approval",
    });
    const ran = rows.find((row) => row.eventType === "routine.ran");
    expect(ran?.payload).toMatchObject({
      ok: true,
      awaiting: "laf:awaiting_approval",
    });

    // The next run is shown what it reported — its own words — and no instruction to stop.
    await service.runNow(PERSON, routine.id);
    const next = bot.instructions[1] ?? "";
    expect(next).toContain(THE_BOTS_WORDS);
    expect(next).not.toContain(FOR_THE_MODEL);
    expect(next).not.toContain("멈춰라");
    expect(next).not.toContain("⏸");
  });
});
