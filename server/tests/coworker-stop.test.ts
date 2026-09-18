import { describe, expect, test } from "bun:test";
import type { AbstractAgent } from "@ag-ui/client";
import {
  CoworkerCallError,
  createCoworkerCall,
  runAgentOnce,
} from "../src/agents/coworker-call";
import type { AgentActor } from "../src/agents/profile-types";
import type { AuditEventInput } from "../src/audit";
import { createWorkInFlight } from "../src/runner/in-flight";
import type { RunLedger, RunOutcome } from "../src/runner/run-ledger";

/**
 * One Bot answering another is work too, and `모두 멈추기` reaches it.
 *
 * A coworker's answer runs on the server for up to ninety seconds after the conversation that asked
 * has been stopped in the browser — the ask route has no way to know its caller gave up — and the
 * roster says "다른 봇을 돕는 중" the whole time. So the ask says it is going on while it is, and a
 * stop ends it as a stop: the model is told, nothing is recorded as the coworker's answer, and the
 * ledger says `stopped` rather than that the coworker failed.
 */

const ACTOR: AgentActor = { id: "person-1", role: "user" };

/** A coworker still thinking until it is aborted. */
function thinkingCoworker() {
  let aborted = false;
  let asked = 0;
  let release: (() => void) | undefined;
  const agent = {
    setMessages() {},
    async runAgent() {
      asked += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { result: undefined, newMessages: [] };
    },
    abortRun() {
      aborted = true;
      release?.();
    },
  };
  return {
    agent: agent as unknown as AbstractAgent,
    aborted: () => aborted,
    asked: () => asked,
  };
}

function fakeLedger() {
  const settled: Array<{ runId: string; outcome: RunOutcome }> = [];
  const ledger: RunLedger = {
    begin: async () => "run-1",
    settle: async (runId, outcome) => {
      settled.push({ runId, outcome });
    },
    finish: async (runId, error) => {
      settled.push({
        runId,
        outcome: { status: error ? "error" : "done", error: error ?? null },
      });
    },
  };
  return { ledger, settled };
}

describe("a coworker's answer, stopped", () => {
  test("is work the asking person has going on, for exactly as long as it runs", async () => {
    const work = createWorkInFlight();
    const coworker = thinkingCoworker();
    const call = createCoworkerCall({
      resolveAgents: async () => ({ knowledge: coworker.agent }),
      work,
    });

    const asking = call.ask(ACTOR, "assistant", "knowledge", "재고 몇 개야?");
    await Bun.sleep(10);
    const going = work.of(ACTOR.id);
    expect(going.map(({ kind, agentId }) => ({ kind, agentId }))).toEqual([
      { kind: "handoff", agentId: "knowledge" },
    ]);
    // Nobody else's.
    expect(work.of("person-2")).toEqual([]);

    await going[0]?.stop();
    await asking.catch(() => undefined);
    expect(work.of(ACTOR.id)).toEqual([]);
  });

  test("ends as a stop: the model is told, no answer is kept, and the ledger says stopped", async () => {
    const work = createWorkInFlight();
    const coworker = thinkingCoworker();
    const rows: AuditEventInput[] = [];
    const recorded: unknown[] = [];
    const { ledger, settled } = fakeLedger();
    const call = createCoworkerCall({
      resolveAgents: async () => ({ knowledge: coworker.agent }),
      auditStore: { insert: async (row) => void rows.push(row) },
      recordExchange: async (exchange) => void recorded.push(exchange),
      ledger,
      work,
    });

    const asking = call.ask(ACTOR, "assistant", "knowledge", "재고 몇 개야?");
    await Bun.sleep(10);
    const at = Date.now();
    expect(await work.of(ACTOR.id)[0]?.stop()).toBe(true);

    const error = await asking.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CoworkerCallError);
    expect((error as CoworkerCallError).code).toBe("laf:coworker_stopped");
    expect(Date.now() - at).toBeLessThan(500);
    expect(coworker.aborted()).toBe(true);
    expect(recorded).toEqual([]);
    expect(settled).toEqual([
      { runId: "run-1", outcome: { status: "stopped", error: null } },
    ]);
    expect(rows.at(-1)?.payload).toMatchObject({ ok: false, stopped: true });
  });

  test("a run stopped before it was asked asks nothing", async () => {
    const coworker = thinkingCoworker();
    const stop = new AbortController();
    stop.abort();
    await expect(
      runAgentOnce(
        coworker.agent,
        "재고 몇 개야?",
        60_000,
        undefined,
        stop.signal,
      ),
    ).rejects.toBeInstanceOf(CoworkerCallError);
    expect(coworker.asked()).toBe(0);
  });
});
