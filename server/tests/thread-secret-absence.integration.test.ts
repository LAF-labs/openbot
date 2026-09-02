import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BaseEvent, Message } from "@ag-ui/client";
import { count, eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { lafThreadMessages, lafThreadRuns } from "../src/db/schema";
import { LafPostgresRunner } from "../src/runner/laf-runner";
import { TEST_POOL } from "./support/database";

/**
 * WHAT A CONVERSATION KEEPS AFTER A SECRET HAS BEEN ENTERED.
 *
 * The audit trail and the demonstration recorder both refuse to write a value, and both are tested
 * for it. The transcript is the third place a value could end up and the only one that had no such
 * test (§3.5): a run hands back its whole history as its input, that history is written to
 * `laf_thread_messages` verbatim, and every tool call a Bot made — with its arguments — is in it.
 *
 * `computer_request_secret` exists precisely so the model never holds the value: it names a field
 * and a label, a person types into that field themselves, and the value travels on a route the
 * model cannot see. So the correct answer here is that the transcript holds the request and not the
 * value, and this file is what says so out loud.
 *
 * Read back through `getThreadMessages`, which is the runner's public read path and what
 * CopilotKit's thread-messages route calls. Deliberately not through the snapshot table, so the
 * test survives that table being replaced.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

/** Distinctive enough that finding it in a serialised thread means what it looks like it means. */
const SECRET = "hunter2-Zx9-BANKPASS";

const threadIds: string[] = [];

afterAll(async () => {
  for (const threadId of threadIds) {
    await database
      .delete(lafThreadRuns)
      .where(eq(lafThreadRuns.threadId, threadId));
    await database
      .delete(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
  }
  await database.$client.close();
});

const event = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, ...extra }) as unknown as BaseEvent;

/**
 * A Bot that says one thing and stops, as AG-UI delivers it.
 *
 * Cast rather than constructed: `AbstractAgent` is a class with a transport behind it, and what the
 * runner actually uses of it is `agentId`, `messages`, `runAgent` and `abortRun` — the same
 * arrangement `unattended-run.test.ts` drives its loop with.
 */
function fakeAgent(agentId: string, answer: string, messages: Message[]) {
  return {
    agentId,
    messages,
    abortRun() {},
    async runAgent(
      _input: unknown,
      subscriber?: { onEvent?: (payload: { event: BaseEvent }) => unknown },
    ) {
      const messageId = `assistant-${randomUUID().slice(0, 8)}`;
      for (const one of [
        event("RUN_STARTED"),
        event("TEXT_MESSAGE_START", { messageId, role: "assistant" }),
        event("TEXT_MESSAGE_CONTENT", { messageId, delta: answer }),
        event("TEXT_MESSAGE_END", { messageId }),
        event("RUN_FINISHED"),
      ]) {
        subscriber?.onEvent?.({ event: one });
      }
      return { result: undefined, newMessages: [] };
    },
  } as never;
}

/** One turn, driven through the runner exactly as the endpoint drives it. */
async function runTurn(
  runner: LafPostgresRunner,
  threadId: string,
  agentId: string,
  messages: Message[],
  answer: string,
): Promise<void> {
  const events = runner.run({
    threadId,
    agent: fakeAgent(agentId, answer, messages),
    input: {
      threadId,
      runId: randomUUID(),
      messages,
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    } as never,
  });
  await new Promise<void>((resolve) => {
    events.subscribe({ complete: resolve, error: () => resolve() });
  });
  /*
   * The tee writes on the stream completing, and it is fire-and-forget by design: persistence must
   * never be able to hold up or break a turn. So the row is waited for rather than assumed — a fixed
   * sleep here is the kind of wall-clock assertion that passes on the author's machine and fails in
   * CI, which §3.7 counts among the things wrong with this suite.
   */
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const [row] = await database
      .select({ stored: count() })
      .from(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
    if ((row?.stored ?? 0) > messages.length) return;
    await Bun.sleep(25);
  }
  throw new Error(`The turn on ${threadId} was never written to the store.`);
}

const call = (id: string, name: string, args: object): Message =>
  ({
    id: `assistant-${id}`,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  }) as Message;

const answered = (id: string, result: object): Message =>
  ({
    id: `tool-${id}`,
    role: "tool",
    toolCallId: id,
    content: JSON.stringify(result),
  }) as Message;

const said = (id: string, role: string, content: string): Message =>
  ({ id, role, content }) as Message;

/**
 * Longer than bun's five seconds, because each of these drives a run and then waits for a row.
 *
 * The wait is bounded and the bound is a real one — a turn that never reaches the store fails with
 * a sentence saying so. Five seconds was enough alone and not enough in a full run against a
 * database sixty other files are also using, which is the only kind of flake worth predicting.
 */
const RUN_TIMEOUT_MS = 30_000;

describe("a conversation in which a person entered a secret", () => {
  test(
    "keeps the request and not the value",
    async () => {
      const threadId = `thread-secret-${randomUUID()}`;
      threadIds.push(threadId);
      const agentId = `agent-secret-${randomUUID().slice(0, 8)}`;
      const runner = await LafPostgresRunner.create(database);

      /*
       * The history a real secret entry leaves on the model's side.
       *
       * The Bot asks for a value by naming the field it goes in; the tool answers with who holds the
       * wheel. Then a person types it on `/human/secret`, which is not a message and never becomes
       * one — that is the whole design, and this test is what proves the design survived contact with
       * a store that writes the input back verbatim.
       */
      const history: Message[] = [
        said("u1", "user", "은행 사이트에 로그인해줘"),
        call("t1", "computer_request_secret", {
          label: "은행 비밀번호",
          ref: "e4",
          snapshotId: 3,
        }),
        answered("t1", { holder: "human", url: "https://bank.example/login" }),
      ];

      await runTurn(
        runner,
        threadId,
        agentId,
        history,
        "비밀번호를 입력해 주세요. 입력하시면 이어서 진행할게요.",
      );

      const kept = runner.getThreadMessages(threadId);
      const serialised = JSON.stringify(kept);

      // The positive control first. Without it, an empty thread would pass every assertion below by
      // holding nothing at all.
      expect(serialised).toContain("computer_request_secret");
      expect(serialised).toContain("은행 비밀번호");
      expect(kept.length).toBeGreaterThanOrEqual(history.length);

      // And the value, which was never on this path: not in the request, not in the tool's answer,
      // not in the reply the Bot streamed.
      expect(serialised).not.toContain(SECRET);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "still holds none of it after a restart reads the thread back",
    async () => {
      const threadId = `thread-secret-restart-${randomUUID()}`;
      threadIds.push(threadId);
      const agentId = `agent-secret-${randomUUID().slice(0, 8)}`;

      await runTurn(
        await LafPostgresRunner.create(database),
        threadId,
        agentId,
        [
          said("u1", "user", "로그인 좀"),
          call("t1", "computer_request_secret", {
            label: "은행 비밀번호",
            ref: "e4",
            snapshotId: 3,
          }),
          answered("t1", {
            holder: "human",
            url: "https://bank.example/login",
          }),
        ],
        "입력해 주세요.",
      );

      /*
       * A SECOND PROCESS, which is where the durable copy is the only copy.
       *
       * `getThreadMessages` prefers the live in-memory thread when it is newer, so reading it on the
       * runner that just ran the turn can be answered without Postgres ever being consulted. A fresh
       * runner has no live copy and can only answer from the row — which is the copy that outlives
       * everything and the one §3.5 is about.
       */
      const reopened = await LafPostgresRunner.create(database);
      const serialised = JSON.stringify(reopened.getThreadMessages(threadId));

      expect(serialised).toContain("computer_request_secret");
      expect(serialised).not.toContain(SECRET);
    },
    RUN_TIMEOUT_MS,
  );

  /**
   * WHAT THE TRANSCRIPT DOES KEEP, MEASURED.
   *
   * §3.5 suspected that a Bot's `computer_type` arguments land in the store verbatim. They do, and
   * this test is the measurement rather than an approval of it: every run hands back its whole
   * history as input, and the input is written as it arrives.
   *
   * That is CORRECT for ordinary typing and is what makes a conversation readable — "typed 김기범
   * into the name box" is the answer to what a Bot did. It is a problem only where a value the Bot
   * should not have had reaches that argument, which the shipped `deny` on password fields stops at
   * the boundary (`SECRET_FIELD_RULE`), and which `computer_request_secret` gives the Bot somewhere
   * else to send. Both of those act on the ACTION; neither reaches the transcript, so a model that
   * put a credential in a `computer_type` argument would leave it in the row even though the action
   * itself was refused — the refusal is what did not happen, and the text is still in the history
   * the next turn sends back.
   *
   * The test is here so that stops being a surprise, and so that a wave which decides to redact
   * this argument has the assertion to invert.
   */
  test(
    "keeps what the Bot typed, which is the other half of §3.5",
    async () => {
      const threadId = `thread-typed-${randomUUID()}`;
      threadIds.push(threadId);
      const agentId = `agent-typed-${randomUUID().slice(0, 8)}`;
      const runner = await LafPostgresRunner.create(database);

      await runTurn(
        runner,
        threadId,
        agentId,
        [
          said("u1", "user", "이름 칸에 김기범 이라고 넣어줘"),
          call("t1", "computer_type", {
            ref: "e4",
            snapshotId: 3,
            text: "김기범",
          }),
          answered("t1", { action: "type", url: "https://shop.example/order" }),
        ],
        "넣었습니다.",
      );

      const kept = JSON.stringify(
        (await LafPostgresRunner.create(database)).getThreadMessages(threadId),
      );

      // Verbatim, and durably: this is read from a second runner, so it came out of Postgres.
      expect(kept).toContain("김기범");
      expect(kept).toContain("computer_type");
    },
    RUN_TIMEOUT_MS,
  );
});
