import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { eq } from "drizzle-orm";
import { SECRET_FIELD_RULE } from "../src/computer/default-policy";
import { createDatabase } from "../src/db/client";
import { lafThreadMessages } from "../src/db/schema";
import { SECRET_REDACTION } from "../src/runner/secret-redaction";
import { appendMessages, messagesFor } from "../src/runner/thread-store";
import { HISTORY_PAGE, historyPage } from "../src/turns/history";
import { TEST_POOL } from "./support/database";

/**
 * WHAT A CONVERSATION KEEPS AFTER A SECRET HAS BEEN ENTERED.
 *
 * The audit trail refuses to write a value, and is tested for it. The transcript is another place
 * a value could end up, and had no such test (§3.5): a run hands back its whole history as its
 * input, that history is written to `laf_thread_messages` verbatim, and every tool call a Bot
 * made — with its arguments — is in it.
 *
 * `computer_request_secret` exists precisely so the model never holds the value: it names a field
 * and a label, a person types into that field themselves, and the value travels on a route the
 * model cannot see. So the correct answer here is that the transcript holds the request and not the
 * value, and this file is what says so out loud.
 *
 * Written as a turn writes it (`appendMessages`, the one writer, called by `turns/engine.ts`) and
 * read back the two ways a conversation is read: what the next turn hands the model
 * (`messagesFor`) and the page a window is served (`historyPage`, behind
 * `GET /api/turns/:threadId/history`). It drove the window's runner and read that runner's own
 * thread route until both went with the run door (2026-10-06); the store was always this one.
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

afterAll(async () => {
  // Scoped to the threads this file made, never the table.
  for (const threadId of threadIds) {
    await database
      .delete(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, threadId));
  }
  await database.$client.close();
});

/**
 * One turn, as the engine files it: what the turn was handed first — a crash mid-turn keeps the
 * person's side — and then the same history with what the Bot said at its end.
 */
async function aTurn(
  threadId: string,
  messages: Message[],
  answer: string,
): Promise<void> {
  threadIds.push(threadId);
  await appendMessages(database, threadId, messages);
  await appendMessages(database, threadId, [
    ...messages,
    said(`assistant-${randomUUID().slice(0, 8)}`, "assistant", answer),
  ]);
}

/**
 * The thread as Postgres holds it, read both ways: for the next turn's model, and for a window.
 *
 * From the rows, always. The runner this file used to drive kept a live copy in memory beside
 * them, and a test had to reopen it to be sure it was reading the durable one; a turn keeps none.
 */
async function kept(threadId: string) {
  const forTheModel = await messagesFor(database, threadId);
  const forAWindow = await historyPage(database, threadId, {
    before: null,
    limit: HISTORY_PAGE,
  });
  return {
    messages: forTheModel,
    serialised: JSON.stringify([forTheModel, forAWindow.messages]),
  };
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

describe("a conversation in which a person entered a secret", () => {
  test("keeps the request and not the value", async () => {
    const threadId = `thread-secret-${randomUUID()}`;

    /*
     * The history a real secret entry leaves on the model's side.
     *
     * The Bot asks for a value by naming the field it goes in; the tool answers with who holds the
     * wheel. Then a person types it on `/human/secret`, which is not a message and never becomes
     * one — that is the whole design, and this test is what proves the design survived contact with
     * a store that writes the history back verbatim.
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

    await aTurn(
      threadId,
      history,
      "비밀번호를 입력해 주세요. 입력하시면 이어서 진행할게요.",
    );

    const { messages, serialised } = await kept(threadId);

    // The positive control first. Without it, an empty thread would pass every assertion below by
    // holding nothing at all.
    expect(serialised).toContain("computer_request_secret");
    expect(serialised).toContain("은행 비밀번호");
    expect(messages.length).toBeGreaterThanOrEqual(history.length);

    // And the value, which was never on this path: not in the request, not in the tool's answer,
    // not in the reply the Bot gave.
    expect(serialised).not.toContain(SECRET);
  });

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
  test("keeps what the Bot typed into an ordinary field", async () => {
    const threadId = `thread-typed-${randomUUID()}`;

    await aTurn(
      threadId,
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

    const { serialised } = await kept(threadId);

    // Verbatim, and durably: it came out of Postgres.
    expect(serialised).toContain("김기범");
    expect(serialised).toContain("computer_type");
  });

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
   */
  test("takes the value out when the boundary refused the typing as a secret", async () => {
    const threadId = `thread-refused-${randomUUID()}`;

    await aTurn(
      threadId,
      [
        said("u1", "user", "로그인 해줘"),
        call("t1", "computer_type", {
          ref: "e4",
          snapshotId: 3,
          text: SECRET,
        }),
        /*
         * The tool result of a refusal that carries its rule and no code: what a routine's tool
         * answers with (`runner/unattended.ts`, `outcomeOfError`), and what the window's did. It
         * is the shape the redaction cannot read a code off, which is why the rule is read too.
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

    const { serialised } = await kept(threadId);

    // The positive controls: an empty thread would pass the assertion that matters by holding
    // nothing at all, and so would a redactor that deleted the call outright.
    expect(serialised).toContain("computer_type");
    expect(serialised).toContain("e4");
    expect(serialised).toContain(SECRET_REDACTION);

    expect(serialised).not.toContain(SECRET);
  });

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
  test("takes it out when the run ended before the result arrived", async () => {
    const threadId = `thread-crashed-${randomUUID()}`;

    await aTurn(
      threadId,
      [
        said("u1", "user", "카드번호 넣어줘"),
        // No `tool` message follows it: this is the history a crash between the call and its
        // answer leaves behind, and the next turn is handed it back exactly like this.
        call("t1", "computer_type", {
          ref: "e9",
          snapshotId: 4,
          text: CARD,
        }),
      ],
      "확인했습니다.",
    );

    const { serialised } = await kept(threadId);

    expect(serialised).toContain("computer_type");
    expect(serialised).toContain(SECRET_REDACTION);
    expect(serialised).not.toContain(CARD);
  });
});
