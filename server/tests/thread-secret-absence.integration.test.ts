import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BaseEvent, Message } from "@ag-ui/client";
import { count, eq, inArray } from "drizzle-orm";
import { SECRET_FIELD_RULE } from "../src/computer/default-policy";
import { createDatabase } from "../src/db/client";
import { agents, lafThreadMessages, lafThreadRuns } from "../src/db/schema";
import { LafPostgresRunner } from "../src/runner/laf-runner";
// Every `create` here used to be given a database and nothing else. `ledger` is a required argument
// and `server/tsconfig.json` includes only `src`, so nothing said so: every run in this file threw
// `this.ledger.begin is not an object` into the console, was swallowed by the persist path's catch,
// and left the `laf_thread_runs` rows that `afterAll` deletes never written in the first place.
import { createRunLedger } from "../src/runner/run-ledger";
import { SECRET_REDACTION } from "../src/runner/secret-redaction";
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

/**
 * A card number, for the case where no tool result exists to judge the typing by.
 *
 * Sixteen digits, which is the shape `looksLikeASecret` recognises on its own. `SECRET` above
 * deliberately is NOT that shape — a bare password with no secret word beside it does not match the
 * pattern — which is exactly why the refusal, and not the pattern, is the primary rule.
 */
const CARD = "4111-1111-1111-9613";

const threadIds: string[] = [];
const agentIds: string[] = [];

/**
 * A Bot row, because the run ledger's `agent_id` is a foreign key into `agents`.
 *
 * Every run in this file used to invent an id and the insert failed on the constraint, silently:
 * the persist path catches, the messages still land, and the `laf_thread_runs` rows this file's
 * cleanup deletes were never written at all. Four columns is the whole of what a Bot needs to
 * exist, so the run being recorded costs one insert and one delete.
 */
async function aBot(prefix: string): Promise<string> {
  const agentId = `${prefix}-${randomUUID().slice(0, 8)}`;
  await database.insert(agents).values({
    id: agentId,
    name: agentId,
    // Everything anybody makes is remote. See CLAUDE.md.
    type: "remote_ag_ui",
    configuration: {},
  });
  agentIds.push(agentId);
  return agentId;
}

afterAll(async () => {
  for (const threadId of threadIds) {
    await database
      .delete(lafThreadRuns)
      .where(eq(lafThreadRuns.threadId, threadId));
    await database
      .delete(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
  }
  // After the runs, which point at them. Scoped to the ids this file made, never the table.
  if (agentIds.length > 0) {
    await database.delete(agents).where(inArray(agents.id, agentIds));
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
      const agentId = await aBot("agent-secret");
      const runner = await LafPostgresRunner.create(
        database,
        createRunLedger(database),
      );

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
      const agentId = await aBot("agent-secret");

      await runTurn(
        await LafPostgresRunner.create(database, createRunLedger(database)),
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
      const reopened = await LafPostgresRunner.create(
        database,
        createRunLedger(database),
      );
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
   * that is CORRECT for ordinary typing: "typed 김기범 into the name box" is the answer to what a
   * Bot did, and a store that forgot it would leave the Bot unable to say what it had already
   * filled in.
   *
   * This is the half of §3.5 that must NOT change, and it is asserted first so that neither test
   * below can be satisfied by a redactor that simply eats everything.
   */
  test(
    "keeps what the Bot typed into an ordinary field",
    async () => {
      const threadId = `thread-typed-${randomUUID()}`;
      threadIds.push(threadId);
      const agentId = await aBot("agent-typed");
      const runner = await LafPostgresRunner.create(
        database,
        createRunLedger(database),
      );

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
        (
          await LafPostgresRunner.create(database, createRunLedger(database))
        ).getThreadMessages(threadId),
      );

      // Verbatim, and durably: this is read from a second runner, so it came out of Postgres.
      expect(kept).toContain("김기범");
      expect(kept).toContain("computer_type");
    },
    RUN_TIMEOUT_MS,
  );

  /**
   * THE OTHER HALF OF §3.5, NOW THE OTHER WAY ROUND.
   *
   * 6a99045 measured this as a leak and left the assertion here to be inverted. A model that put a
   * credential into a `computer_type` argument left it in the row even though the gateway REFUSED
   * the action — the refusal acts on the ACTION and never reached the transcript, so the value went
   * back to the model with the history on every following turn. `computer_request_secret` exists
   * precisely so it never has to be there at all.
   *
   * The refusal now reaches the record too. What survives is the call, the field and the tool's
   * name — enough to read the turn — and not the value.
   *
   * Read from a SECOND runner for the reason the restart test above gives: the runner that ran the
   * turn still holds an unredacted live copy in memory, and the durable row is the one that
   * outlives the process and answers every later reader.
   */
  test(
    "takes the value out when the boundary refused the typing as a secret",
    async () => {
      const threadId = `thread-refused-${randomUUID()}`;
      threadIds.push(threadId);
      const agentId = await aBot("agent-refused");

      await runTurn(
        await LafPostgresRunner.create(database, createRunLedger(database)),
        threadId,
        agentId,
        [
          said("u1", "user", "로그인 해줘"),
          call("t1", "computer_type", {
            ref: "e4",
            snapshotId: 3,
            text: SECRET,
          }),
          /*
           * The tool result as the attended path builds it out of the gateway's 403
           * (`computer-tools.tsx`): the rule that refused, the reason, and no code — that path reads
           * `code` off `body.error` rather than off `body.code`, so a policy refusal reaches the
           * model with the rule and nothing else.
           */
          answered("t1", {
            ok: false,
            refused: true,
            reason: "A rule refused typing into that field.",
            rule: SECRET_FIELD_RULE,
          }),
        ],
        "비밀번호는 직접 입력해 주세요.",
      );

      const kept = JSON.stringify(
        (
          await LafPostgresRunner.create(database, createRunLedger(database))
        ).getThreadMessages(threadId),
      );

      // The positive controls: an empty thread would pass the assertion that matters by holding
      // nothing at all, and so would a redactor that deleted the call outright.
      expect(kept).toContain("computer_type");
      expect(kept).toContain("e4");
      expect(kept).toContain(SECRET_REDACTION);

      expect(kept).not.toContain(SECRET);
    },
    RUN_TIMEOUT_MS,
  );

  /**
   * AND WHEN NOBODY EVER ANSWERED.
   *
   * A run that died between the call and its result leaves the argument with nothing to judge it
   * by: the gateway may have refused it, or the process may have gone down first. The boundary is
   * silent, so the only thing left is the shape of the text, and `looksLikeASecret` — the memory
   * store's filter — is the one answer this deployment has to "does that look like a credential".
   *
   * A card number is what that filter recognises without a word beside it. A bare password with no
   * secret word around it does not match it, which is why this is the floor under the refusal and
   * not a replacement for it.
   */
  test(
    "takes it out when the run ended before the result arrived",
    async () => {
      const threadId = `thread-crashed-${randomUUID()}`;
      threadIds.push(threadId);
      const agentId = await aBot("agent-crashed");

      await runTurn(
        await LafPostgresRunner.create(database, createRunLedger(database)),
        threadId,
        agentId,
        [
          said("u1", "user", "카드번호 넣어줘"),
          // No `tool` message follows it: this is the history a crash between the call and its
          // answer leaves behind, and the next run hands it back exactly like this.
          call("t1", "computer_type", {
            ref: "e9",
            snapshotId: 4,
            text: CARD,
          }),
        ],
        "확인했습니다.",
      );

      const kept = JSON.stringify(
        (
          await LafPostgresRunner.create(database, createRunLedger(database))
        ).getThreadMessages(threadId),
      );

      expect(kept).toContain("computer_type");
      expect(kept).toContain(SECRET_REDACTION);
      expect(kept).not.toContain(CARD);
    },
    RUN_TIMEOUT_MS,
  );
});
