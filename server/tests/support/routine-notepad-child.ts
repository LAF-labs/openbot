/**
 * A server process that runs one routine whose Bot moves the notepad's cursor, and is killed at a
 * chosen instant.
 *
 * The sibling of `routine-run-child.ts`, for the notepad (`routine-notepad-kill.integration.test.ts`):
 * the same production wiring — the real service, the real ledger, the real delivery — with a Bot
 * that, on its first turn, calls `routine_note` to say it got to `LAST_ID`, and on its second
 * answers. The run goes through the unattended loop, because that is the only path offered the
 * notepad.
 *
 *   KILL_AT=delivered  after the answer has been written, inside the settlement's transaction —
 *                      which is also after the notepad's write, the first statement in it;
 *   KILL_AT=committed  as the `routine.ran` trail row is written, which is after the commit.
 */
import type { Message } from "@ag-ui/client";
import type { AuditStore } from "../../src/audit";
import { createDatabase } from "../../src/db/client";
import { createRoutineDelivery } from "../../src/routines/deliver";
import { createRoutineService } from "../../src/routines/service";
import { createRunLedger } from "../../src/runner/run-ledger";
import type { LoopAgent } from "../../src/runner/unattended";

const { DATABASE_URL, ROUTINE_ID, OWNER_ID, BOT_ID, LAST_ID, KILL_AT } =
  process.env;
if (!DATABASE_URL || !ROUTINE_ID || !OWNER_ID || !BOT_ID || !LAST_ID) {
  throw new Error("routine-notepad-child needs its five variables");
}

const database = createDatabase(DATABASE_URL, { max: 2 });

const die = (): never => {
  process.kill(process.pid, "SIGKILL");
  // Not reached; SIGKILL is not delivered to a handler. Kept so the type says so.
  throw new Error("still alive");
};

/** Two turns: move the cursor, then answer. What a model does, as the loop sees it. */
function cursorMovingBot(): LoopAgent {
  let turns = 0;
  const bot = {
    messages: [] as Message[],
    setMessages(messages: Message[]) {
      bot.messages = [...messages];
    },
    addMessage(message: Message) {
      bot.messages.push(message);
    },
    async runAgent(
      _parameters?: unknown,
      subscriber?: { onRunFinishedEvent?: () => unknown },
    ) {
      turns += 1;
      const said: Message =
        turns === 1
          ? {
              id: crypto.randomUUID(),
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "move-the-cursor",
                  type: "function",
                  function: {
                    name: "routine_note",
                    arguments: JSON.stringify({
                      action: "watermark",
                      key: "new_reviews",
                      lastId: LAST_ID,
                    }),
                  },
                },
              ],
            }
          : {
              id: crypto.randomUUID(),
              role: "assistant",
              content: "새 리뷰 3건에 답글 초안을 썼습니다.",
            };
      bot.messages.push(said);
      subscriber?.onRunFinishedEvent?.();
      return { result: undefined, newMessages: [said] };
    },
  };
  return bot as unknown as LoopAgent;
}

const deliver = createRoutineDelivery(database);
const trail: AuditStore = {
  insert: async () => {
    if (KILL_AT === "committed") die();
  },
};

const service = createRoutineService({
  database,
  resolveAgents: async () => ({ [BOT_ID]: cursorMovingBot() as never }),
  ledger: createRunLedger(database),
  auditStore: trail,
  tools: async () => ({
    tools: [],
    execute: async () => ({ ok: false, code: "laf:tool_unknown" }),
  }),
  deliver: async (...args: Parameters<typeof deliver>) => {
    const delivered = await deliver(...args);
    if (KILL_AT === "delivered") die();
    return delivered;
  },
});

await service.runNow({ id: OWNER_ID, role: "user" }, ROUTINE_ID);
// A kill point that was never reached is a test that measured nothing; say so with the exit code.
process.exit(3);
