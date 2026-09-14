import { Hono } from "hono";
import type { LafPostgresRunner } from "./laf-runner";

/**
 * The runtime's own thread routes, with the thread they are about to answer for read first.
 *
 * CopilotKit's local thread endpoints reach the runner through SYNCHRONOUS methods —
 * `getThreadMessages` returns a `Message[]`, and the handler maps it straight into a `Response` —
 * so a read that has to reach Postgres cannot happen inside them. The runner used to sidestep that
 * by loading every thread in the deployment at boot and answering from memory. This is the
 * alternative: one read, for the one thread this request names, taken here where awaiting is
 * allowed. `/threads` itself takes a summary read that touches no message body.
 *
 * The runtime is mounted behind these by the caller (`.route("/", mountCopilotRuntime(…))`).
 */
export function primeThreadRoutes(input: {
  runner: Pick<LafPostgresRunner, "prime" | "primeThreadList">;
  /**
   * Who the priming is reading for, or a refusal.
   *
   * The resolver without the anonymous fallback: this is the read that decides WHOSE thread is
   * about to be served, and the fallback would answer that question with an actor who owns nothing —
   * which reads as "not yours" for a person whose session simply could not be checked. The routes
   * are already behind `requireUser` (see app.ts), so an unauthenticated caller never arrives; this
   * is the transient case, and it is refused rather than guessed at.
   */
  actorOf: (request: Request) => Promise<{ id: string } | null>;
}): Hono {
  return new Hono()
    .use("/api/copilotkit/threads", async (context, next) => {
      if (context.req.method === "GET") {
        const actor = await input.actorOf(context.req.raw);
        if (!actor) return context.json({ error: "laf:unauthenticated" }, 401);
        await input.runner.primeThreadList(actor.id);
      }
      return next();
    })
    .use("/api/copilotkit/threads/:threadId/*", async (context, next) => {
      const actor = await input.actorOf(context.req.raw);
      if (!actor) return context.json({ error: "laf:unauthenticated" }, 401);
      /*
       * REFUSED HERE, not merely left unprimed.
       *
       * `getThreadMessages` reads the vendored runner's live copy as well as the primed one, and that
       * copy is a process-wide singleton — so a thread of somebody else's that has been run on this
       * VM since boot would be answered out of memory however carefully this middleware declined to
       * prime it. The request has to stop.
       */
      const mine = await input.runner.prime(
        context.req.param("threadId"),
        actor.id,
      );
      if (!mine) return context.json({ error: "laf:thread_not_found" }, 404);
      return next();
    });
}
