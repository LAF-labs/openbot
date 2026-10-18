/**
 * The company's budget, as a run on this VM meets it: asked before the run starts, told after.
 *
 * THE LEDGER IS THE HUB'S, THE HARD STOP IS THIS VM'S (lafi-dev-design §7). The cost happens here and
 * is already guarded here — a question's requests and dollars (agent-bot's `guards.ts`), a trial's
 * day (`usage/daily-budget.ts`), the deployment key's own daily limit at the provider. The hub holds
 * no model key and sees two numbers per run: what was set aside before it started, and what it cost.
 *
 * BEFORE: `POST /budget/reserve {runId, scopes, amount: 0.2}`. Any refusal stops the run, before
 * anything is asked of the model. AFTER: `POST /budget/settle {runId, actual, scopes}` through the
 * outbox, so a hub that is down, or a process that dies a second after
 * the run, loses no settle — the row is offered again at boot, every five minutes, and when the line
 * comes back. The hub takes a settle twice as once, and a settle with no reservation as a record.
 *
 * A HUB THAT DOES NOT ANSWER DOES NOT STOP A RUN (fail-open). Chosen because the hub is the ledger
 * and not the guard: the run still meets every guard this VM has, and the deployment key's daily
 * limit is the ceiling behind them, so what a hub outage can cost is bounded by what this VM could
 * already spend alone. Failing closed would turn a hub upgrade at seven in the morning into every
 * member's morning routine not running, and a company's whole board not moving — the failure this
 * product is least allowed to have, for a number the hub catches up on through the settle anyway.
 *
 * A HUB THAT ANSWERS "NO" STOPS IT, whatever the reason. Only silence is the outage above; a refusal
 * is the hub saying something about this run, and it is refused whole before any limit is read — a
 * job that was deleted or moved to another member (403), a task this member no longer sees (404), a
 * pass the hub no longer takes. Going ahead on any of those would run the company's work past its
 * day with nobody counting it (`laf:budget_refused`, the hub's own code in the log line).
 *
 * ONE ATTEMPT, FIVE SECONDS AT MOST. A reservation is asked once (`retry: false`): the run is
 * waiting on it, and retrying a hub that is down for fifteen seconds before going ahead anyway would
 * only make every run that much later.
 */
import { HUB_FACTS } from "../../../shared/hub/protocol";
import { log } from "../log";
import type { HubHttp } from "./http";
import type { HubOutbox } from "./outbox";
import {
  budgetReserveBody,
  budgetSettleBody,
  HUB_BUDGET_CODES,
  HUB_BUDGET_PATHS,
  HUB_BUDGET_RESERVE_USD,
  type HubBudgetScope,
} from "./wire";

/** Which kind of run asked, for the hub's trail (`x-laf-origin`). */
export type BudgetOrigin = "job" | "room" | "chat";

export type BudgetVerdict =
  /** Go. `reserved` is false where the hub did not answer and the run goes ahead on the VM's guards. */
  | { go: true; reserved: boolean }
  /**
   * Stop: the company's day for one of the scopes is spent (`reached`), or the hub refused the run
   * for another reason (`refused`). Nothing is asked of the model.
   */
  | {
      go: false;
      code: typeof HUB_BUDGET_CODES.reached | typeof HUB_BUDGET_CODES.refused;
    };

export type RunBudget = {
  reserve(input: {
    runId: string;
    /** Beside the workspace, which the hub counts whether or not it is named: a job's, a task's. */
    scopes: readonly HubBudgetScope[];
    origin: BudgetOrigin;
  }): Promise<BudgetVerdict>;
  /** What the run cost, sent through the outbox. Never throws: a lost settle is a log line. */
  settle(input: {
    runId: string;
    actual: number;
    /** The reservation's own, so a run the hub never heard about counts against them too. */
    scopes: readonly HubBudgetScope[];
  }): Promise<void>;
};

/** The workspace first and always, then the run's own, once each. */
function withWorkspace(scopes: readonly HubBudgetScope[]): HubBudgetScope[] {
  return ["workspace", ...scopes.filter((scope) => scope !== "workspace")];
}

export function createRunBudget(input: {
  http: HubHttp;
  outbox: Pick<HubOutbox, "enqueue">;
  /** True while the hub refuses this VM's pass: nothing is asked, and the run does not start. */
  passRefused?: () => boolean;
}): RunBudget {
  return {
    async reserve({ runId, scopes, origin }) {
      if (input.passRefused?.()) {
        log.warn("hub_budget_refused", {
          run: runId,
          code: HUB_FACTS.passRefused,
        });
        return { go: false, code: HUB_BUDGET_CODES.refused };
      }
      const named = withWorkspace(scopes);
      const answer = await input.http.request({
        method: "POST",
        path: HUB_BUDGET_PATHS.reserve,
        body: budgetReserveBody({
          runId,
          scopes: named,
          amount: HUB_BUDGET_RESERVE_USD,
        }),
        // The run's own id: a reservation the hub took and whose answer was lost is answered again.
        idempotencyKey: `reserve-${runId}`,
        run: runId,
        origin,
        retry: false,
      });
      if (answer.ok) return { go: true, reserved: true };
      if (answer.code === HUB_BUDGET_CODES.reached) {
        log.info("hub_budget_reached", { run: runId });
        return { go: false, code: HUB_BUDGET_CODES.reached };
      }
      if (answer.code === HUB_FACTS.unreachable) {
        log.warn("hub_budget_open", { run: runId, code: answer.code });
        return { go: true, reserved: false };
      }
      log.warn("hub_budget_refused", { run: runId, code: answer.code });
      return { go: false, code: HUB_BUDGET_CODES.refused };
    },

    async settle({ runId, actual, scopes }) {
      await input.outbox
        .enqueue({
          method: "POST",
          path: HUB_BUDGET_PATHS.settle,
          body: budgetSettleBody({
            runId,
            actual,
            scopes: withWorkspace(scopes),
          }),
          origin: "job",
          runId,
        })
        .catch((error: unknown) => {
          log.warn("hub_budget_settle_lost", {
            run: runId,
            reason: error instanceof Error ? error.name : "unknown",
          });
        });
    },
  };
}
