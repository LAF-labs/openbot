/**
 * Several browser steps in one reply, and where they stop (`runner/round-stop.ts`).
 *
 * The loop has always carried out every call of a reply in the order the model wrote them. What it
 * did not have was a stop: a step that was refused, held for a person, or that moved the page left
 * the steps after it to run anyway — written for a page that was no longer there. On a routine that
 * meant 검색 pressed over a field nobody was there to approve.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import {
  noteCodesOf,
  toolResultText,
} from "../../shared/prompt/tool-results.ko";
import { computerReplyOutcome } from "../../shared/tools/computer-reply";
import { createApprovalRegistry } from "../src/computer/approvals";
import { createComputerClient } from "../src/computer/client";
import {
  ActionNeedsApprovalError,
  type ComputerGateway,
  createComputerGateway,
} from "../src/computer/gateway";
import {
  ACTING_COMPUTER_TOOLS,
  roundEndsAfter,
} from "../src/runner/round-stop";
import {
  type LoopAgent,
  type LoopExecutor,
  runTurnLoop,
} from "../src/runner/turn-loop";
import {
  createUnattendedTools,
  outcomeOfError,
} from "../src/runner/unattended";
import { createChatTools } from "../src/turns/chat-tools";
import { createPersonAnswers } from "../src/turns/people";
import { A_CLICK } from "./support/subjects";

type Asked = {
  id: string;
  name: string;
  args?: Record<string, unknown> | string;
};

/** One reply of the model asking for these calls, in this order. */
const reply = (...calls: Asked[]): Message => ({
  id: `a-${calls.map((one) => one.id).join("-")}`,
  role: "assistant",
  content: "",
  toolCalls: calls.map((one) => ({
    id: one.id,
    type: "function",
    function: {
      name: one.name,
      arguments:
        typeof one.args === "string"
          ? one.args
          : JSON.stringify(one.args ?? {}),
    },
  })),
});
const say = (text: string): Message => ({
  id: `s-${text.length}`,
  role: "assistant",
  content: text,
});

/**
 * A model that says each of these in turn, and finishes every run it is asked for. A run given as a
 * list adds all of it: a reply and the answers the Bot service filed for it inside the same run.
 */
function scripted(turns: Array<Message | Message[]>): LoopAgent {
  let runs = 0;
  const agent = {
    messages: [] as Message[],
    setMessages(messages: Message[]) {
      agent.messages = [...messages];
    },
    addMessage(message: Message) {
      agent.messages.push(message);
    },
    async runAgent(
      _parameters?: unknown,
      subscriber?: { onRunFinishedEvent?: () => unknown },
    ) {
      const turn = turns[runs] ?? say("끝.");
      runs += 1;
      const added = Array.isArray(turn) ? turn : [turn];
      agent.messages.push(...added);
      subscriber?.onRunFinishedEvent?.();
      return { result: undefined, newMessages: added };
    },
  };
  return agent as unknown as LoopAgent;
}

/** Run the loop over these replies with this executor, and keep what each part of it saw. */
async function run(turns: Array<Message | Message[]>, execute: LoopExecutor) {
  const agent = scripted(turns);
  const executed: string[] = [];
  const started: string[] = [];
  const filed = new Map<string, Record<string, unknown> | string>();
  const result = await runTurnLoop(agent, {
    tools: [],
    execute: async (name, args, call) => {
      executed.push(call.id);
      return execute(name, args, call);
    },
    timeoutMs: 10_000,
    maxSteps: 6,
    forwardedProps: {},
    onToolStart: (call) => started.push(call.id),
    onToolResult: (message) => {
      const content = String(message.content);
      try {
        filed.set(message.toolCallId, JSON.parse(content));
      } catch {
        filed.set(message.toolCallId, content);
      }
    },
  });
  /** Every call the model made, and whether a tool message answers it. */
  const asked = agent.messages.flatMap((message) =>
    message.role === "assistant" ? (message.toolCalls ?? []) : [],
  );
  const answered = new Set(
    agent.messages
      .filter((message) => message.role === "tool")
      .map((message) => (message as { toolCallId: string }).toolCallId),
  );
  const codeOf = (id: string) => {
    const said = filed.get(id);
    return typeof said === "object" ? said.code : undefined;
  };
  return {
    ...result,
    agent,
    executed,
    started,
    filed,
    codeOf,
    unanswered: asked.filter((call) => !answered.has(call.id)).map((c) => c.id),
  };
}

/** The answer the Bot service files for a call it refused inside the run (`factResult`). */
const answeredInRun = (toolCallId: string, code: string): Message =>
  ({
    id: `tool-${toolCallId}`,
    role: "tool",
    toolCallId,
    content: JSON.stringify({ ok: false, code, reason: toolResultText(code) }),
  }) as Message;

/** A computer whose page raises an alert on every field typed into, as a page's own check does. */
const alerting = {
  type: async () => ({
    action: "type",
    url: "https://shop.example/form",
    characters: 2,
    notes: [{ code: "laf:dialog", message: "주소를 입력하세요" }],
  }),
} as unknown as ComputerGateway;

/** A chat turn's toolkit over this gateway, as the turn engine builds it. */
const chatToolsOver = (gateway: ComputerGateway) =>
  createChatTools({ gateway, people: createPersonAnswers() })(
    {
      botId: "bot-1",
      owner: { id: "owner-1", role: "user" },
      threadId: "t-1",
      runId: "r-1",
    },
    null,
  );

const NOT_REACHED = {
  ok: false,
  code: "laf:step_not_reached",
  reason: toolResultText("laf:step_not_reached"),
};

const field = (id: string, ref: string, text = "값") => ({
  id,
  name: "computer_type",
  args: { ref, snapshotId: 1, text },
});
const press = (id: string, ref = "e9") => ({
  id,
  name: "computer_click",
  args: { ref, snapshotId: 1 },
});

describe("a round of browser steps stops where one of them stops", () => {
  test("a refusal in the middle: the steps after it are answered, never carried out", async () => {
    const outcome = await run(
      [
        reply(
          field("t1", "e1"),
          field("t2", "e2"),
          field("t3", "e3"),
          press("c4"),
        ),
        say("전화번호 칸은 규칙이 막았어요."),
      ],
      async (_name, args) =>
        args.ref === "e2"
          ? {
              ok: false,
              refused: true,
              code: "laf:policy_denied",
              reason: toolResultText("laf:policy_denied"),
            }
          : { ok: true },
    );
    expect(outcome.executed).toEqual(["t1", "t2"]);
    // Not announced either: a window must not draw a step as running that never ran.
    expect(outcome.started).toEqual(["t1", "t2"]);
    expect(outcome.filed.get("t3")).toEqual(NOT_REACHED);
    expect(outcome.filed.get("c4")).toEqual(NOT_REACHED);
    // Every call has its answer, or the provider refuses the conversation's next request.
    expect(outcome.unanswered).toEqual([]);
    expect(outcome.steps[0]?.calls).toEqual([
      { name: "computer_type", ok: true },
      { name: "computer_type", ok: false },
      { name: "computer_type", ok: false },
      { name: "computer_click", ok: false },
    ]);
  });

  test("a routine's question nobody answers: 검색 is not pressed over the field it held", async () => {
    /*
     * THE HOLE THIS CLOSES. A routine has nobody to ask, so a field the deployment wants a yes for
     * comes back as the routine's own envelope (`outcomeOfError`): not done, waiting. The loop used
     * to file that and go straight on to the press — over a field that was never filled.
     */
    const approvals = createApprovalRegistry();
    const question = await approvals.request({
      botId: "bot-1",
      actor: "owner-1",
      rule: "ask",
      subject: A_CLICK,
      fingerprint: "round-stop-1",
      target: { type: "computer", id: "bot-1" },
    });
    const pressed: string[] = [];
    const outcome = await run(
      [reply(field("t1", "e1"), press("c2")), say("승인을 기다리고 있어요.")],
      async (name) => {
        if (name === "computer_click") pressed.push("c2");
        return outcomeOfError(new ActionNeedsApprovalError(question));
      },
    );
    expect(pressed).toEqual([]);
    expect(outcome.executed).toEqual(["t1"]);
    expect(outcome.codeOf("t1")).toBe("laf:nobody_answered");
    expect(outcome.filed.get("c2")).toEqual(NOT_REACHED);
    // What the run was waiting on is still what the routine's record says it stopped for.
    expect(outcome.awaiting).toBe(toolResultText("laf:nobody_answered"));
  });

  test("a control renamed under the Bot: the rest of the round is void", async () => {
    const outcome = await run(
      [reply(field("t1", "e1"), press("c2", "e8"), press("c3"))],
      async (name) =>
        name === "computer_click"
          ? computerReplyOutcome(409, { error: "laf:label_changed" })
          : computerReplyOutcome(200, { action: "type", characters: 2 }),
    );
    expect(outcome.executed).toEqual(["t1", "c2"]);
    expect(outcome.codeOf("c2")).toBe("laf:label_changed");
    expect(outcome.filed.get("c3")).toEqual(NOT_REACHED);
  });

  test("a password field: the fields and the press after it are not reached, and nothing typed is filed", async () => {
    const typed = ["hunter2-비밀", "010-1234-5678", "서울시 어딘가"];
    const outcome = await run(
      [
        reply(
          field("t1", "e1", typed[0]),
          field("t2", "e2", typed[1]),
          field("t3", "e3", typed[2]),
          press("c4"),
        ),
      ],
      async (_name, args) =>
        args.ref === "e1"
          ? computerReplyOutcome(403, {
              error: "laf:use_request_secret",
              code: "laf:use_request_secret",
              rule: "element.type == 'password'",
            })
          : computerReplyOutcome(200, { action: "type", characters: 3 }),
    );
    expect(outcome.executed).toEqual(["t1"]);
    for (const id of ["t2", "t3", "c4"]) {
      expect(outcome.filed.get(id)).toEqual(NOT_REACHED);
    }
    // What the Bot meant to type is in its own arguments and nowhere in what came back.
    const told = JSON.stringify(
      outcome.agent.messages.filter((message) => message.role === "tool"),
    );
    for (const value of typed) expect(told).not.toContain(value);
  });

  test("arguments that did not parse leave the field empty, so the press after them does not land", async () => {
    const outcome = await run(
      [
        reply(
          { id: "t1", name: "computer_type", args: '{"ref": "e1", "text": ' },
          press("c2"),
        ),
      ],
      async () => ({ ok: true }),
    );
    expect(outcome.executed).toEqual([]);
    expect(outcome.codeOf("t1")).toBe("laf:tool_arguments_invalid");
    expect(outcome.filed.get("c2")).toEqual(NOT_REACHED);
  });

  /*
   * THE PATH PRODUCTION TAKES. The Bot service answers arguments that are not an object — and the
   * same call a third time — inside the run (`agent-bot/src/run.ts`), and forwards the rest of the
   * reply. So the broken `computer_type` arrives already answered, never in the loop's `pending`, and
   * only the press after it is left for the loop to carry out. The case above reaches the loop's own
   * parse instead, which no deployed Bot does.
   */
  test("a field the Bot service refused inside the run: the press after it in the same reply does not land", async () => {
    const outcome = await run(
      [
        [
          reply(
            { id: "t1", name: "computer_type", args: '{"ref": "e1", "text": ' },
            press("c2"),
            { id: "s3", name: "computer_snapshot" },
          ),
          answeredInRun("t1", "laf:tool_arguments_invalid"),
        ],
        say("다시 해 볼게요."),
      ],
      async () => ({ ok: true }),
    );
    expect(outcome.executed).toEqual(["s3"]);
    expect(outcome.filed.get("c2")).toEqual(NOT_REACHED);
    expect(outcome.unanswered).toEqual([]);
    // In the record the service's answer comes first, then the open calls in their order.
    expect(outcome.steps[0]?.calls).toEqual([
      { name: "computer_type", ok: false },
      { name: "computer_click", ok: false },
      { name: "computer_snapshot", ok: true },
    ]);
  });

  test("a reply the Bot service answered whole was read before the next: the next reply's steps are carried out", async () => {
    const first = reply({
      id: "t1",
      name: "computer_type",
      args: '{"ref": "e1", "text": ',
    });
    const second = { ...reply(field("t2", "e1"), press("c3")), id: "a-second" };
    const outcome = await run(
      [[first, answeredInRun("t1", "laf:tool_arguments_invalid"), second]],
      async () => ({ ok: true }),
    );
    expect(outcome.executed).toEqual(["t2", "c3"]);
  });

  test("a lookup the Bot service answered inside the run ends nothing", async () => {
    const outcome = await run(
      [
        [
          reply(
            { id: "q1", name: "tool_search", args: { query: "browser" } },
            field("t2", "e1"),
            press("c3"),
          ),
          {
            id: "tool-q1",
            role: "tool",
            toolCallId: "q1",
            content: "computer_type: …",
          } as Message,
        ],
      ],
      async () => ({ ok: true }),
    );
    expect(outcome.executed).toEqual(["t2", "c3"]);
  });
});

describe("a step that moved the page ends the round, and a look at the page still runs", () => {
  test("a press that went to another page: the field after it is not typed, the snapshot and the read and the search still run", async () => {
    const outcome = await run(
      [
        reply(
          press("c1"),
          field("t2", "e2"),
          { id: "s3", name: "computer_snapshot" },
          { id: "r4", name: "computer_read" },
          { id: "w5", name: "web_search", args: { query: "날씨" } },
        ),
      ],
      async (name) =>
        name === "computer_click"
          ? computerReplyOutcome(200, {
              action: "click",
              url: "https://shop.example/result",
              // The computer's report that the click moved the page (`actions.ts`, `pageArrivedAt`).
              page: {
                url: "https://shop.example/result",
                title: "결과",
                text: "",
              },
            })
          : { ok: true },
    );
    expect(outcome.executed).toEqual(["c1", "s3", "r4", "w5"]);
    expect(outcome.filed.get("t2")).toEqual(NOT_REACHED);
  });

  test("an alert ends the round; the model reads its words, never the codes kept for the loop", async () => {
    const toolkit = await chatToolsOver(alerting);
    const outcome = await run(
      [reply(field("t1", "e1"), press("c2"))],
      (name, args, call) => toolkit.execute(name, args, call),
    );
    expect(outcome.executed).toEqual(["t1"]);
    expect(outcome.filed.get("c2")).toEqual(NOT_REACHED);
    const said = outcome.filed.get("t1") as Record<string, unknown>;
    expect(said.notes).toEqual([
      `${toolResultText("laf:dialog")} (주소를 입력하세요)`,
    ]);
    // The same bytes the model read before the codes were kept beside the words.
    expect(said).not.toHaveProperty("noteCodes");
  });

  test("an ordinary scroll, click or field does not end the round", async () => {
    const outcome = await run(
      [
        reply(
          { id: "k1", name: "computer_scroll", args: { deltaY: 600 } },
          press("c2", "e5"),
          field("t3", "e1"),
          press("c4"),
        ),
      ],
      async () =>
        computerReplyOutcome(200, {
          action: "click",
          url: "https://shop.example/form",
        }),
    );
    expect(outcome.executed).toEqual(["k1", "c2", "t3", "c4"]);
  });

  for (const ending of [
    { name: "computer_navigate", args: { url: "https://shop.example" } },
    { name: "computer_switch_tab", args: { index: 1 } },
    { name: "computer_request_help", args: { reason: "인증" } },
    {
      name: "computer_request_secret",
      args: { ref: "e1", snapshotId: 1, label: "비밀번호" },
    },
  ]) {
    test(`${ending.name} ends the round even when it worked`, async () => {
      const outcome = await run(
        [reply({ id: "x1", ...ending }, press("c2"))],
        async () => ({ ok: true }),
      );
      expect(outcome.executed).toEqual(["x1"]);
      expect(outcome.filed.get("c2")).toEqual(NOT_REACHED);
    });
  }

  test("the next reply is a new round: what the model asks for after reading the stop is carried out", async () => {
    let refused = true;
    const outcome = await run(
      [
        reply(field("t1", "e1"), press("c2")),
        reply({ id: "s3", name: "computer_snapshot" }),
        reply(field("t4", "e1"), press("c5")),
        say("신청했어요."),
      ],
      async (name) => {
        if (name === "computer_type" && refused) {
          refused = false;
          return computerReplyOutcome(409, { error: "laf:stale_refs" });
        }
        return { ok: true };
      },
    );
    expect(outcome.executed).toEqual(["t1", "s3", "t4", "c5"]);
    expect(outcome.filed.get("c2")).toEqual(NOT_REACHED);
  });
});

describe("the rule's own reading", () => {
  test("only the browser's acting tools are ever stopped", () => {
    expect([...ACTING_COMPUTER_TOOLS].sort()).toEqual([
      "computer_click",
      "computer_key",
      "computer_navigate",
      "computer_request_help",
      "computer_request_secret",
      "computer_scroll",
      "computer_switch_tab",
      "computer_type",
      "computer_upload_file",
    ]);
    for (const name of [
      "computer_snapshot",
      "computer_read",
      "computer_read_file",
      "computer_write_file",
      "computer_list_files",
      "web_search",
    ]) {
      expect(roundEndsAfter(name, { ok: false })).toBe(false);
    }
  });

  test("both server executors keep the notes' codes beside their words; the shared mapping does not", async () => {
    const asked = { ref: "e1", snapshotId: 1, text: "값" };
    const chat = await (await chatToolsOver(alerting)).execute(
      "computer_type",
      asked,
      { id: "n1", signal: new AbortController().signal },
    );
    const routine = await (
      await createUnattendedTools({ gateway: alerting })("bot-1", {
        id: "owner-1",
      })
    ).execute("computer_type", asked, { id: "n2" });
    for (const outcome of [chat, routine]) {
      expect(typeof outcome === "object" && outcome.noteCodes).toEqual([
        "laf:dialog",
      ]);
    }
    /*
     * What the window (`SERVER_TURNS=off`) and the eval hand a model straight from the mapping: no
     * field of the loop's. Neither files through `forTheModel`, which is where the loop strips it.
     */
    expect(
      computerReplyOutcome(200, {
        action: "type",
        notes: [{ code: "laf:dialog", message: "확인하세요" }],
      }),
    ).not.toHaveProperty("noteCodes");
    expect(
      noteCodesOf([
        { code: "laf:dialog", message: "확인하세요" },
        { code: "laf:downloaded", path: "downloads/a.pdf" },
        "not a note",
      ]),
    ).toEqual(["laf:dialog", "laf:downloaded"]);
    // A chat handover's `notes` is a sentence, not a list of facts.
    expect(noteCodesOf("페이지가 바뀌었다")).toEqual([]);
  });
});

/*
 * ROUTINE AND CHAT STOP IN THE SAME PLACE. The two paths carry a call out differently — a routine's
 * executor reads the gateway's result itself (`unattended.ts`), chat's reads it the way the window
 * read an HTTP reply (`chat-tools.ts`) — and translate the computer's notes in two places. The same
 * replies, the same computer, the same rules: the same answers filed, in the same order.
 *
 * Through the real client against a computer over HTTP, so `page` and `notes` arrive the way the
 * container sends them (`agent-computer/src/actions.ts`), not as an object a test built.
 */
describe("a routine and a chat turn stop at the same step", () => {
  const hits: string[] = [];
  const computer = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const body =
        request.method === "POST"
          ? ((await request.json().catch(() => ({}))) as { ref?: string })
          : {};
      if (pathname === "/snapshot") {
        return Response.json({
          snapshotId: 1,
          url: "https://shop.example/form",
          title: "신청",
          truncated: false,
          elements: [
            { ref: "e1", role: "textbox", name: "이름" },
            { ref: "e2", role: "textbox", name: "전화번호" },
            { ref: "e3", role: "textbox", name: "주소" },
            { ref: "e9", role: "button", name: "신청" },
          ],
        });
      }
      hits.push(`${pathname}:${body.ref ?? ""}`);
      if (pathname === "/type") {
        return Response.json({
          action: "type",
          ref: body.ref,
          url: "https://shop.example/form",
          characters: 2,
          // The address field raises an alert, as a page's own validation does.
          ...(body.ref === "e3"
            ? { notes: [{ code: "laf:dialog", message: "주소를 확인하세요" }] }
            : {}),
        });
      }
      if (pathname === "/click") {
        return Response.json({
          action: "click",
          ref: body.ref,
          url: "https://shop.example/done",
          page: { url: "https://shop.example/done", title: "완료", text: "" },
        });
      }
      return Response.json(
        { error: "laf:computer_route_unknown" },
        { status: 404 },
      );
    },
  });
  afterAll(() => computer.stop(true));

  const gatewayFor = async () => {
    const gateway = createComputerGateway({
      client: createComputerClient({
        baseUrl: `http://127.0.0.1:${computer.port}`,
        token: "test-token",
        allowPrivateHosts: true,
      }),
      auditStore: { insert: async () => {} },
      policy: () => ({
        deny: ['contains(element.name, "전화")'],
        ask: [],
        allow: ["true"],
      }),
    });
    await gateway.snapshot("bot-1");
    return gateway;
  };

  const turns = () => [
    // The phone field is refused: the address and the press are not reached.
    reply(field("a1", "e1"), field("a2", "e2"), field("a3", "e3"), press("a4")),
    // The address raises an alert: the press after it is not reached.
    reply(field("b1", "e3"), press("b2")),
    // The press moves the page: the field after it is not typed, the look still happens.
    reply(press("c1"), field("c2", "e1"), {
      id: "c3",
      name: "computer_snapshot",
    }),
    say("신청했어요."),
  ];
  const sequenceOf = (outcome: Awaited<ReturnType<typeof run>>) =>
    [...outcome.filed.entries()].map(([id, said]) => [
      id,
      typeof said === "object" ? said.ok : "text",
      typeof said === "object" ? (said.code ?? null) : null,
    ]);
  const EXPECTED = [
    ["a1", true, null],
    ["a2", false, "laf:policy_denied"],
    ["a3", false, "laf:step_not_reached"],
    ["a4", false, "laf:step_not_reached"],
    ["b1", true, null],
    ["b2", false, "laf:step_not_reached"],
    ["c1", true, null],
    ["c2", false, "laf:step_not_reached"],
    ["c3", true, null],
  ];
  const REACHED = ["/type:e1", "/type:e3", "/click:e9"];

  test("a routine", async () => {
    hits.length = 0;
    const toolkit = await createUnattendedTools({
      gateway: await gatewayFor(),
    })("bot-1", { id: "owner-1", userId: "owner-1" });
    const outcome = await run(turns(), (name, args, call) =>
      toolkit.execute(name, args, call),
    );
    expect(sequenceOf(outcome)).toEqual(EXPECTED);
    expect(hits).toEqual(REACHED);
  });

  test("a chat turn", async () => {
    hits.length = 0;
    const toolkit = await createChatTools({
      gateway: await gatewayFor(),
      people: createPersonAnswers(),
    })(
      {
        botId: "bot-1",
        owner: { id: "owner-1", role: "user" },
        threadId: "t-1",
        runId: "r-1",
      },
      null,
    );
    const outcome = await run(turns(), (name, args, call) =>
      toolkit.execute(name, args, call),
    );
    expect(sequenceOf(outcome)).toEqual(EXPECTED);
    expect(hits).toEqual(REACHED);
  });
});
