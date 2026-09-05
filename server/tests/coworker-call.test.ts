import { describe, expect, test } from "bun:test";
import type { AbstractAgent } from "@ag-ui/client";
import {
  CoworkerCallError,
  createCoworkerCall,
} from "../src/agents/coworker-call";
import type { AgentActor } from "../src/agents/profile-types";
import type { AuditEventInput } from "../src/audit";

/**
 * What the briefing path promises: the right coworker answers, the wrong requests are refused with
 * reasons a route can map, and a row lands in the trail whichever way it went.
 */

// `as never` here erased the type AND hid that "administrator" is not a role this deployment has:
// `UserRole` is "admin" | "user". Typed properly, so a fixture cannot claim a role that does not
// exist and the assertions below can read `ACTOR.id` at all.
const ACTOR: AgentActor = { id: "dev-local-user", role: "admin" };

function fakeAgent(reply: string | Error, delayMs = 0) {
  let received: string | undefined;
  const agent = {
    setMessages(messages: { content?: string }[]) {
      received = messages[0]?.content;
    },
    async runAgent() {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (reply instanceof Error) throw reply;
      return {
        result: undefined,
        newMessages: [
          { id: "m1", role: "assistant", content: reply },
          // A tool-ish interim entry, to prove only assistant text is collected.
          { id: "m2", role: "tool", content: "ignored" },
        ],
      };
    },
  };
  return {
    agent: agent as unknown as AbstractAgent,
    question: () => received,
  };
}

type Exchange = {
  actorId: string;
  callerId: string;
  targetId: string;
  question: string;
  answer: string;
  at: Date;
};

function harness(agents: Record<string, AbstractAgent>, timeoutMs?: number) {
  const rows: AuditEventInput[] = [];
  const recorded: Exchange[] = [];
  const call = createCoworkerCall({
    resolveAgents: async () => agents,
    auditStore: {
      insert: async (event) => {
        rows.push(event);
      },
    },
    recordExchange: async (exchange) => {
      recorded.push(exchange);
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { call, rows, recorded };
}

describe("one Bot asking another", () => {
  test("delivers the question and returns the coworker's text", async () => {
    const knowledge = fakeAgent("The Q3 numbers are in the wiki.");
    const { call, rows } = harness({ knowledge: knowledge.agent });

    const answer = await call.ask(
      ACTOR,
      "general-assistant",
      "knowledge",
      "Where are the Q3 numbers?",
    );

    expect(knowledge.question()).toBe("Where are the Q3 numbers?");
    expect(answer).toBe("The Q3 numbers are in the wiki.");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("coworker.asked");
    expect(rows[0]?.payload).toMatchObject({
      // Both: the Bot the request CLAIMED was asking, and the person who was actually signed in.
      // `from` is not authorisation (see the route), so a trail carrying only the claim cannot
      // answer "who set this off" on a deployment with more than one person in it.
      actor: ACTOR.id,
      caller: "general-assistant",
      ok: true,
    });
  });

  test("the answering Bot gets its own record of what it was asked", async () => {
    /*
     * The gap this closes: a handoff lived in the caller's window and one audit row, and the Bot
     * that ANSWERED kept nothing — ask it tomorrow what it told its colleague and it had never
     * heard of it. Borrowed from Hermes Bot Mode, whose A2A replies land in each agent's own chat
     * "so conversations between agents are durable and inspectable, not fire-and-forget".
     */
    const knowledge = fakeAgent("The Q3 numbers are in the wiki.");
    const { call, recorded } = harness({ knowledge: knowledge.agent });

    await call.ask(
      ACTOR,
      "general-assistant",
      "knowledge",
      "Where are the Q3 numbers?",
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      actorId: ACTOR.id,
      callerId: "general-assistant",
      targetId: "knowledge",
      question: "Where are the Q3 numbers?",
      answer: "The Q3 numbers are in the wiki.",
    });
  });

  test("a coworker that said nothing leaves no record to read", async () => {
    // An empty answer is not a conversation, and a transcript entry holding a question and a blank
    // would read as the Bot having ignored somebody.
    const silent = fakeAgent("");
    const { call, recorded } = harness({ knowledge: silent.agent });

    await call.ask(ACTOR, "general-assistant", "knowledge", "Anything?");

    expect(recorded).toEqual([]);
  });

  test("recording the exchange never costs the answer", async () => {
    // The same stance the audit row and the ledger take: losing the record must not lose the work.
    const knowledge = fakeAgent("Filed under Q3.");
    const call = createCoworkerCall({
      resolveAgents: async () => ({ knowledge: knowledge.agent }),
      recordExchange: async () => {
        throw new Error("the thread write failed");
      },
    });

    await expect(
      call.ask(ACTOR, "general-assistant", "knowledge", "Where?"),
    ).resolves.toBe("Filed under Q3.");
  });

  test("refuses a question too long to be a question", async () => {
    const knowledge = fakeAgent("never reached");
    const { call } = harness({ knowledge: knowledge.agent });

    await expect(
      call.ask(ACTOR, "a", "knowledge", "x".repeat(8_001)),
    ).rejects.toThrow(/8000/);
    // Refused before the coworker was woken: nothing is spent on a question that cannot be sent.
    expect(knowledge.question()).toBeUndefined();
  });

  test("cuts an answer that would spend the caller's whole window, and says so", async () => {
    const flood = fakeAgent("y".repeat(20_050));
    const { call } = harness({ knowledge: flood.agent });

    const answer = await call.ask(ACTOR, "a", "knowledge", "Everything?");

    // Truncated rather than refused: the work is done, and throwing it away would be worse than
    // handing back most of it with a mark that says what happened.
    expect(answer.length).toBeLessThan(20_200);
    expect(answer).toContain("[truncated: the coworker answered with 20050");
  });

  test("refuses a Bot asking itself", async () => {
    const { call } = harness({});
    await expect(
      call.ask(ACTOR, "knowledge", "knowledge", "hello?"),
    ).rejects.toThrow(CoworkerCallError);
  });

  test("refuses an empty question before touching the roster", async () => {
    const { call } = harness({});
    await expect(call.ask(ACTOR, "a", "b", "   ")).rejects.toThrow(
      "Ask the coworker something.",
    );
  });

  test("names a coworker that does not exist as the problem", async () => {
    const { call } = harness({});
    const outcome = call.ask(ACTOR, "a", "nobody", "hello?");
    await expect(outcome).rejects.toThrow('no coworker with the id "nobody"');
    await expect(outcome).rejects.toMatchObject({ status: 404 });
  });

  test("a coworker that throws is a 502, and the trail says so", async () => {
    const broken = fakeAgent(new Error("the endpoint is gone"));
    const { call, rows } = harness({ risk: broken.agent });

    await expect(call.ask(ACTOR, "a", "risk", "hello?")).rejects.toMatchObject({
      status: 502,
    });
    expect(rows[0]?.payload).toMatchObject({ ok: false });
  });

  test("a coworker that never answers is a timeout, not a hang", async () => {
    const slow = fakeAgent("too late", 5_000);
    const { call } = harness({ slow: slow.agent }, 50);

    await expect(call.ask(ACTOR, "a", "slow", "hello?")).rejects.toMatchObject({
      status: 504,
    });
  });

  test("an answer with no text still reads as a sentence", async () => {
    const silent = fakeAgent("");
    const { call } = harness({ silent: silent.agent });

    const answer = await call.ask(ACTOR, "a", "silent", "hello?");
    expect(answer).toBe("The coworker finished without saying anything.");
  });
});

/*
 * ONE HOP, AS A RULE AND NOT ONLY AS A PROPERTY OF TODAY'S CODE.
 *
 * A coworker runs with no tools, so it cannot ask a third coworker and cannot reach a boundary —
 * by construction. These pin the rule the construction was relying on: a question from inside a
 * delegated turn is refused with a fact, the trail records the attempt, and the run a coworker
 * gets is told it is delegated so the other half of the rule (`settle.ts`) has something to read.
 */
describe("how deep a question may go", () => {
  test("a coworker answering a question cannot ask a third: refused with a fact, on the trail", async () => {
    const third = fakeAgent("I would have answered.");
    const { call, rows } = harness({ third: third.agent });

    const outcome = call.ask(ACTOR, "second", "third", "and you?", {
      depth: 1,
    });
    await expect(outcome).rejects.toMatchObject({
      status: 403,
      code: "laf:delegation_too_deep",
    });
    // Never reached: a refusal that ran the coworker anyway would be a refusal in name only.
    expect(third.question()).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      ok: false,
      refusal: "laf:delegation_too_deep",
      caller: "second",
      depth: 1,
    });
  });

  test("a Bot a person is driving asks at depth 0, and the coworker runs at depth 1", async () => {
    let forwarded: unknown;
    const agent = {
      setMessages() {},
      async runAgent(parameters?: { forwardedProps?: unknown }) {
        forwarded = parameters?.forwardedProps;
        return {
          result: undefined,
          newMessages: [{ id: "m1", role: "assistant", content: "ok" }],
        };
      },
    } as unknown as AbstractAgent;
    const { call } = harness({ knowledge: agent });

    await call.ask(ACTOR, "general-assistant", "knowledge", "what is Q3?");
    expect(forwarded).toEqual({
      mode: "coworker",
      delegation: { callerId: "general-assistant", depth: 1 },
    });
  });

  test("the depth outranks every other check: an empty question from a delegate is still the chain", async () => {
    const { call } = harness({});
    await expect(
      call.ask(ACTOR, "second", "third", "   ", { depth: 2 }),
    ).rejects.toMatchObject({ code: "laf:delegation_too_deep" });
  });
});
