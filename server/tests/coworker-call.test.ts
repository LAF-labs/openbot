import { describe, expect, test } from "bun:test";
import type { AbstractAgent } from "@ag-ui/client";
import type { AuditEventInput } from "../src/audit";
import {
  CoworkerCallError,
  createCoworkerCall,
} from "../src/agents/coworker-call";

/**
 * What the briefing path promises: the right coworker answers, the wrong requests are refused with
 * reasons a route can map, and a row lands in the trail whichever way it went.
 */

const ACTOR = { id: "dev-local-user", role: "administrator" } as never;

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

function harness(agents: Record<string, AbstractAgent>, timeoutMs?: number) {
  const rows: AuditEventInput[] = [];
  const call = createCoworkerCall({
    resolveAgents: async () => agents,
    auditStore: {
      insert: async (event) => {
        rows.push(event);
      },
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { call, rows };
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
      caller: "general-assistant",
      ok: true,
    });
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
