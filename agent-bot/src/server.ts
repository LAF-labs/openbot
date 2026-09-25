import type { RunAgentInput } from "@ag-ui/core";
import { serve } from "bun";
import { buildOf, reportCrashes } from "../../shared/log";
import { log } from "./log";
import {
  BASE_URL,
  MODEL,
  PROVIDER_ROUTING,
  REQUEST_TIMEOUT_MS,
} from "./provider";
import { runAgent } from "./run";

/**
 * The AG-UI HTTP service: one endpoint, a health line, and the two things a process owes an
 * operator — a refusal to start without a model, and a last log line on the way out.
 *
 * The built-in Bot is an AG-UI HTTP service registered the same way as any customer-provided Bot.
 * Nothing in here knows what a run is; that is `./run`'s.
 */

const PORT = Number.parseInt(process.env.PORT ?? "4200", 10);

export function startServer(): void {
  reportCrashes(log);
  /*
   * Loudly, and here rather than at module scope: a throw while a module is being imported would
   * take the test suite's own import of `runAgent` with it, and a suite that never runs reports
   * nothing rather than failing. Nothing that serves a person gets past this line without a model.
   */
  if (!MODEL) {
    log.error("boot_refused", {
      reason: "bot_model_unset",
      hint: "This service sends the model name verbatim to OPENAI_BASE_URL and has no default of its own — the deployment's model is declared once, in the tenant package's model.yaml, and docker-compose passes BOT_MODEL through from .env. Set it there (.env.example ships it set) and start again.",
    });
    process.exit(1);
  }

  const server = serve({
    port: PORT,
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return Response.json({ status: "ok", model: MODEL });
      }

      if (url.pathname === "/ag-ui" && request.method === "POST") {
        const input = (await request.json()) as RunAgentInput;
        return runAgent(input);
      }

      return Response.json({ error: "Not found." }, { status: 404 });
    },
  });

  /*
   * `server.port` rather than `PORT`: a test starts this service on port 0 and reads the port it
   * was actually given from this line, which is also what an operator wants to know.
   */
  log.info("boot", {
    ...buildOf(),
    model: MODEL,
    baseUrl: BASE_URL ?? "https://api.openai.com/v1",
    port: server.port,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    // Which endpoints may answer this model, or none: the policy is keyed by model (`./provider`).
    providerRouting: PROVIDER_ROUTING ?? "none",
  });

  /*
   * Said before leaving, with the reason. `docker stop` sends SIGTERM; a log that ends mid-run
   * with no last line cannot be told from a process that was killed by the kernel, and the two
   * want different next steps. Registering the handler means Bun no longer exits on its own, so
   * the exit is explicit.
   */
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      log.info("shutdown", { reason: signal });
      server.stop(true);
      process.exit(0);
    });
  }
}
