import { afterEach, describe, expect, test } from "bun:test";
import {
  approvePageCall,
  closeQuestion,
  decisionOn,
  openQuestion,
  openQuestionCalls,
  openQuestions,
  type PendingApproval,
  questionOn,
} from "../src/lib/approvals";
import {
  forgetWatchedQuestions,
  questionThread,
  watchServerQuestions,
  watchShellQuestions,
} from "../src/lib/turns/questions";

/**
 * A QUESTION THE BOT STOPPED ON IS KNOWN ON EVERY SCREEN, NOT ONLY IN ITS CONVERSATION.
 *
 * The server's record of open questions was read by the open conversation alone. Everything else
 * that says "the Bot is waiting on you" — the pill, the tray, the sidebar's 기다리는 일, the phone
 * bar's dot — reads the store that reading fills. So on any other screen a question raised after
 * the person left said nothing, and one raised before they left went on saying 확인 필요 after
 * somebody had answered it.
 *
 * Read from the code, 2026-10-02, and NOT pressed on the running app: raising a real question means
 * the Bot pressing something on a money site, which that session was not permitted to do.
 */

const BOT = "agent_shell-q";
const THREAD = "thread-shell-q";
const PACE = { whileOpenMs: 15, afterFailureMs: 15 };

const SUBJECT = {
  kind: "browser",
  intent: "activate",
  host: "pay.example",
  element: { role: "button", name: "결제하기" },
  reason: "policy_ask",
} as const;

function approval(
  id: string,
  overrides: Partial<PendingApproval> = {},
): PendingApproval {
  return {
    id,
    botId: BOT,
    rule: "",
    subject: SUBJECT,
    step: { threadId: THREAD, toolCallId: `call-${id}` },
    requestedAt: "2026-10-02T09:00:00.000Z",
    expiresAt: "2026-10-02T09:10:00.000Z",
    ...overrides,
  };
}

/** The server's record, as a test changes it, and how often it was asked for. */
function record(initial: PendingApproval[] | null) {
  const state = { approvals: initial, reads: 0 };
  return {
    state,
    read: async () => {
      state.reads += 1;
      return state.approvals;
    },
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(ready: () => boolean, label: string) {
  const deadline = Date.now() + 2_000;
  while (!ready()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await wait(5);
  }
}
const openFor = (botId: string) =>
  openQuestions().filter((question) => question.botId === botId).length;

/**
 * A question of its own for each test. What was decided on a call is kept after its card folds
 * (`decisionOn`), by design, so two tests sharing a call would read each other's answers.
 */
let asked = 0;
const fresh = () => {
  asked += 1;
  return { id: `q${asked}`, call: `call-q${asked}` };
};

const watches: { dispose: () => void }[] = [];
const kept = <Watch extends { dispose: () => void }>(watch: Watch): Watch => {
  watches.push(watch);
  return watch;
};
afterEach(() => {
  for (const watch of watches.splice(0)) watch.dispose();
  forgetWatchedQuestions();
});

describe("the shell's watch, on a screen that is not the conversation", () => {
  test("a question the Bot stopped on is in the store the pill and the sidebar read", async () => {
    const q = fresh();
    const server = record([approval(q.id)]);
    kept(watchShellQuestions({ botId: BOT, read: server.read, pace: PACE }));
    await until(() => openFor(BOT) === 1, "the question to be known");
    expect(questionOn(q.call)?.approvalId).toBe(q.id);
    expect(questionOn(q.call)?.subject?.element?.name).toBe("결제하기");
  });

  test("it is raised later: the look the outbox asks for finds it", async () => {
    const q = fresh();
    const server = record([]);
    const watch = kept(
      watchShellQuestions({ botId: BOT, read: server.read, pace: PACE }),
    );
    await until(() => server.state.reads === 1, "the first look");
    expect(openFor(BOT)).toBe(0);
    server.state.approvals = [approval(q.id)];
    watch.look();
    await until(() => openFor(BOT) === 1, "the question to be known");
  });

  test("with nothing open it does not look by itself", async () => {
    const server = record([]);
    kept(watchShellQuestions({ botId: BOT, read: server.read, pace: PACE }));
    await until(() => server.state.reads === 1, "the first look");
    await wait(80);
    expect(server.state.reads).toBe(1);
  });

  test("with one open it keeps looking, and stops once it is answered", async () => {
    const q = fresh();
    const server = record([approval(q.id)]);
    kept(watchShellQuestions({ botId: BOT, read: server.read, pace: PACE }));
    await until(() => server.state.reads >= 3, "it to keep looking");
    // Answered in another window: the card's line keeps the answer, and nothing is waiting.
    server.state.approvals = [approval(q.id, { granted: true })];
    await until(() => openFor(BOT) === 0, "the question to fold");
    expect(decisionOn(q.call)?.outcome).toBe("allowed");
    await wait(40);
    const settled = server.state.reads;
    await wait(80);
    expect(server.state.reads).toBe(settled);
  });

  test("a question gone from the record — run out, or withdrawn by a stop — is closed", async () => {
    const q = fresh();
    const server = record([approval(q.id)]);
    kept(watchShellQuestions({ botId: BOT, read: server.read, pace: PACE }));
    await until(() => openFor(BOT) === 1, "the question to be known");
    server.state.approvals = [];
    await until(() => openFor(BOT) === 0, "the question to close");
    expect(decisionOn(q.call)).toBeUndefined();
  });

  test("a read the server did not answer is asked again, and says nothing meanwhile", async () => {
    const q = fresh();
    const server = record(null);
    kept(watchShellQuestions({ botId: BOT, read: server.read, pace: PACE }));
    await until(() => server.state.reads >= 2, "the second try");
    expect(openFor(BOT)).toBe(0);
    server.state.approvals = [approval(q.id)];
    await until(() => openFor(BOT) === 1, "the question to be known");
  });

  test("a record with no step on it draws no card: there is no line to put it on", async () => {
    const q = fresh();
    const { step: _step, ...stepless } = approval(q.id);
    const server = record([stepless]);
    kept(watchShellQuestions({ botId: BOT, read: server.read, pace: PACE }));
    await until(() => server.state.reads === 1, "the first look");
    await wait(20);
    expect(openFor(BOT)).toBe(0);
  });
});

describe("the shell's watch and a conversation's", () => {
  test("a conversation on screen keeps its own questions, and the shell takes them over when it leaves", async () => {
    const q = fresh();
    const server = record([approval(q.id)]);
    const conversation = kept(
      watchServerQuestions({
        botId: BOT,
        threadId: THREAD,
        going: () => true,
        read: server.read,
      }),
    );
    await until(() => openFor(BOT) === 1, "the conversation to draw it");
    // The record the shell reads says it was answered. While the conversation is on screen that is
    // the conversation's to hear, and the shell — which does look — leaves the card alone.
    const shell = record([approval(q.id, { granted: false })]);
    const watch = kept(
      watchShellQuestions({ botId: BOT, read: shell.read, pace: PACE }),
    );
    await until(() => shell.state.reads >= 1, "the shell's own look");
    await wait(40);
    expect(openFor(BOT)).toBe(1);
    // Nothing of its own is open, so it does not go on looking either.
    const settled = shell.state.reads;
    await wait(60);
    expect(shell.state.reads).toBe(settled);

    // The conversation leaves: nobody used to be there to hear the answer.
    conversation.dispose();
    await until(
      () => openFor(BOT) === 0,
      "the card the conversation drew to fold",
    );
    expect(decisionOn(q.call)?.outcome).toBe("declined");
    watch.dispose();
  });

  test("a card the conversation drew that has since run out is closed by the shell", async () => {
    const q = fresh();
    const server = record([approval(q.id)]);
    const conversation = kept(
      watchServerQuestions({
        botId: BOT,
        threadId: THREAD,
        going: () => true,
        read: server.read,
      }),
    );
    await until(() => openFor(BOT) === 1, "the conversation to draw it");
    const shell = record([]);
    kept(watchShellQuestions({ botId: BOT, read: shell.read, pace: PACE }));
    conversation.dispose();
    await until(() => openFor(BOT) === 0, "the stale card to close");
  });

  /*
   * Codex, on the pull request. An account that kept what it had before the limit can hold two
   * conversations with one Bot. The shell stood down for the whole Bot while either was on screen,
   * and the one on screen reads only its own thread: a question raised in the other was drawn
   * nowhere for its ten minutes.
   */
  test("a question raised in another conversation of the same Bot is the shell's, even with one on screen", async () => {
    const q = fresh();
    const elsewhere = approval(q.id, {
      step: { threadId: "thread-other", toolCallId: q.call },
    });
    const server = record([elsewhere]);
    kept(
      watchServerQuestions({
        botId: BOT,
        threadId: THREAD,
        going: () => false,
        read: server.read,
      }),
    );
    await until(() => server.state.reads >= 1, "the conversation's look");
    await wait(20);
    // The conversation on screen does not draw it: it is not its thread's.
    expect(questionOn(q.call)).toBeUndefined();

    kept(watchShellQuestions({ botId: BOT, read: server.read, pace: PACE }));
    await until(() => questionOn(q.call) !== undefined, "the shell to draw it");
    expect(questionThread(BOT, q.id)).toBe("thread-other");
    // And it goes on looking, because this one is its own.
    const reads = server.state.reads;
    await until(() => server.state.reads > reads + 1, "it to keep looking");
  });

  test("a conversation's watch folds only its own conversation's cards", async () => {
    const q = fresh();
    const elsewhere = approval(q.id, {
      step: { threadId: "thread-other", toolCallId: q.call },
    });
    const shell = record([elsewhere]);
    const watch = kept(
      watchShellQuestions({ botId: BOT, read: shell.read, pace: PACE }),
    );
    await until(() => questionOn(q.call) !== undefined, "the other card");
    watch.dispose();
    // This conversation's record never names the other thread's question.
    const server = record([]);
    kept(
      watchServerQuestions({
        botId: BOT,
        threadId: THREAD,
        going: () => false,
        read: server.read,
      }),
    );
    await until(() => server.state.reads >= 1, "the conversation's look");
    await wait(20);
    expect(questionOn(q.call)).toBeDefined();
  });
});

/*
 * Codex, on the pull request. The approval's own page registers the question on a line of its own;
 * with the shell's watch on that page too, the same question was on two lines, and the sidebar's
 * 기다리는 일 listed it twice — the second row leading to a card that is on no conversation.
 */
describe("one question on two lines", () => {
  const asking = (approvalId: string) => ({
    approvalId,
    botId: BOT,
    subject: undefined,
    rule: null,
    expiresAt: "",
  });

  test("is listed once, on the conversation's line", () => {
    const q = fresh();
    openQuestion(approvePageCall(q.id), asking(q.id));
    openQuestion(q.call, asking(q.id));
    expect(openFor(BOT)).toBe(1);
    const calls = openQuestionCalls().filter(
      ({ question }) => question.approvalId === q.id,
    );
    expect(calls.map((entry) => entry.toolCallId)).toEqual([q.call]);
    closeQuestion(q.call);
    closeQuestion(approvePageCall(q.id));
  });

  test("whichever line was registered first", () => {
    const q = fresh();
    openQuestion(q.call, asking(q.id));
    openQuestion(approvePageCall(q.id), asking(q.id));
    expect(
      openQuestionCalls()
        .filter(({ question }) => question.approvalId === q.id)
        .map((entry) => entry.toolCallId),
    ).toEqual([q.call]);
    closeQuestion(q.call);
    closeQuestion(approvePageCall(q.id));
  });

  test("with only the page's line, that is the one — the page alone is a place to answer it", () => {
    const q = fresh();
    openQuestion(approvePageCall(q.id), asking(q.id));
    expect(
      openQuestionCalls()
        .filter(({ question }) => question.approvalId === q.id)
        .map((entry) => entry.toolCallId),
    ).toEqual([approvePageCall(q.id)]);
    // Both lines are still there for the card that draws each.
    expect(questionOn(approvePageCall(q.id))).toBeDefined();
    closeQuestion(approvePageCall(q.id));
  });
});
