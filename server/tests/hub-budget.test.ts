import { describe, expect, test } from "bun:test";
import { createRunBudget } from "../src/hub/budget";
import type { HubAnswer, HubHttp, HubRequest } from "../src/hub/http";
import type { HubOutboxWrite } from "../src/hub/outbox";
import { budgetSettleBody } from "../src/hub/wire";

/**
 * What the company's budget answers a run, by what the hub said. Only a hub that does not answer
 * lets a run go on the VM's own guards (`budget.ts`, fail-open); every answer that is a refusal —
 * the day spent, a job deleted or moved away, a task gone, a refused pass — stops it.
 */

function hubAnswering(answer: HubAnswer<unknown>) {
  const seen: HubRequest[] = [];
  const http: HubHttp = {
    async request(request) {
      seen.push(request);
      return answer as never;
    },
    socket: () => ({ url: "ws://unused", headers: {} }),
  };
  return { http, seen };
}

const outbox = () => {
  const written: HubOutboxWrite[] = [];
  return {
    written,
    enqueue: async (write: HubOutboxWrite) => {
      written.push(write);
      return "row-1";
    },
  };
};

describe("the company's budget, before a run", () => {
  test.each([
    [
      "the hub took it",
      { ok: true, status: 200, body: { ok: true } },
      { go: true, reserved: true },
    ],
    [
      "a scope's day is spent",
      { ok: false, status: 409, code: "laf:budget_reached" },
      { go: false, code: "laf:budget_reached" },
    ],
    [
      "the hub did not answer",
      { ok: false, status: null, code: "laf:hub_unreachable" },
      { go: true, reserved: false },
    ],
    [
      "a task this member no longer sees",
      { ok: false, status: 404, code: "laf:hub_not_found" },
      { go: false, code: "laf:budget_refused" },
    ],
    [
      "a job deleted, or moved to another member",
      { ok: false, status: 403, code: "laf:hub_forbidden" },
      { go: false, code: "laf:budget_refused" },
    ],
    [
      "a body the hub would not take",
      { ok: false, status: 400, code: "laf:request_invalid" },
      { go: false, code: "laf:budget_refused" },
    ],
  ] as const)("%s", async (_name, answer, verdict) => {
    const hub = hubAnswering(answer as HubAnswer<unknown>);
    const budget = createRunBudget({ http: hub.http, outbox: outbox() });
    expect(
      await budget.reserve({
        runId: "run-1",
        scopes: ["task:t1"],
        origin: "job",
      }),
    ).toEqual(verdict);
    // Asked once, with the workspace first, the run's own key, and no retries.
    expect(hub.seen).toEqual([
      {
        method: "POST",
        path: "/budget/reserve",
        body: { runId: "run-1", scopes: ["workspace", "task:t1"], amount: 0.2 },
        idempotencyKey: "reserve-run-1",
        run: "run-1",
        origin: "job",
        retry: false,
      },
    ]);
  });

  test("with the pass refused, nothing is asked and the run does not start", async () => {
    const hub = hubAnswering({ ok: true, status: 200, body: {} });
    const budget = createRunBudget({
      http: hub.http,
      outbox: outbox(),
      passRefused: () => true,
    });
    expect(
      await budget.reserve({ runId: "run-2", scopes: [], origin: "job" }),
    ).toEqual({ go: false, code: "laf:budget_refused" });
    expect(hub.seen).toEqual([]);
  });

  test("the settle is a row in the outbox, with the run's scopes, the cost to the sixth place and never below nothing", async () => {
    const box = outbox();
    const budget = createRunBudget({
      http: hubAnswering({ ok: true, status: 200, body: {} }).http,
      outbox: box,
    });
    await budget.settle({
      runId: "run-3",
      actual: 0.01234567,
      scopes: ["job:j1"],
    });
    expect(box.written).toEqual([
      {
        method: "POST",
        path: "/budget/settle",
        // The scopes ride along: a run whose reservation never reached the hub is counted against
        // its job's or task's day too, not only the workspace's.
        body: {
          runId: "run-3",
          actual: 0.012346,
          scopes: ["workspace", "job:j1"],
        },
        origin: "job",
        runId: "run-3",
      },
    ]);
    expect(
      budgetSettleBody({ runId: "r", actual: -4, scopes: ["workspace"] }).actual,
    ).toBe(0);
    expect(
      budgetSettleBody({
        runId: "r",
        actual: Number.NaN,
        scopes: ["workspace"],
      }).actual,
    ).toBe(0);
  });
});
