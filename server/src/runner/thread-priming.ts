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
  runner: Pick<
    LafPostgresRunner,
    | "prime"
    | "primeThreadList"
    | "getThreadMessages"
    | "stepState"
    | "abandonStep"
  >;
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
  return (
    new Hono()
      .use("/api/copilotkit/threads", async (context, next) => {
        if (context.req.method === "GET") {
          const actor = await input.actorOf(context.req.raw);
          if (!actor) {
            return context.json(
              { error: "laf:unauthenticated", code: "laf:unauthenticated" },
              401,
            );
          }
          await input.runner.primeThreadList(actor.id);
        }
        return next();
      })
      .use("/api/copilotkit/threads/:threadId/*", async (context, next) => {
        const actor = await input.actorOf(context.req.raw);
        if (!actor) {
          return context.json(
            { error: "laf:unauthenticated", code: "laf:unauthenticated" },
            401,
          );
        }
        /*
         * REFUSED HERE, not merely left unprimed.
         *
         * `getThreadMessages` reads the vendored runner's live copy as well as the primed one, and that
         * copy is a process-wide singleton — so a thread of somebody else's that has been run on this
         * VM since boot would be answered out of memory however carefully this middleware declined to
         * prime it. The request has to stop.
         */
        // Read before `next()`: once the runtime's own routing has matched, `param` answers for its
        // route rather than this one (measured: undefined, and the messages read came back empty).
        const threadId = context.req.param("threadId");
        const mine = await input.runner.prime(threadId, actor.id);
        if (!mine) {
          return context.json(
            { error: "laf:thread_not_found", code: "laf:thread_not_found" },
            404,
          );
        }
        await next();
        if (
          context.req.method !== "GET" ||
          !context.req.path.endsWith("/messages") ||
          !context.res.ok
        ) {
          return;
        }
        const answered = (await context.res
          .clone()
          .json()
          .catch(() => null)) as { messages?: unknown } | null;
        if (!answered || !Array.isArray(answered.messages)) return;
        const kept = withCarriedReasoning(
          answered.messages,
          input.runner.getThreadMessages(threadId),
        );
        if (kept !== answered.messages) {
          context.res = Response.json({ ...answered, messages: kept });
        }
      })
      /*
       * WHETHER THE TURN IS STILL GOING ON SOMEWHERE, AND A WINDOW LETTING GO OF ITS STEP (UX review
       * 0.5.4, candidate 1). Behind the middleware above, so only the thread's own person reaches
       * either. Answered here rather than by the runtime, which has no notion of a step with a window.
       */
      .get("/api/copilotkit/threads/:threadId/step", (context) =>
        context.json(input.runner.stepState(context.req.param("threadId"))),
      )
      .post("/api/copilotkit/threads/:threadId/step-abandoned", (context) =>
        context.json({
          abandoned: input.runner.abandonStep(context.req.param("threadId")),
        }),
      )
  );
}

/**
 * The runtime's messages route, with each message's `encryptedValue` put back.
 *
 * The route rebuilds every message from a fixed list of keys (`handleGetThreadMessages` in
 * `@copilotkit/runtime`), and AG-UI's `encryptedValue` is not on it. That field is where a MiMo
 * tool-call turn carries the reasoning Xiaomi asks to be handed back in every later request
 * (`agent-bot/src/reasoning.ts`), so a tab reloaded from this route sent the thread back without
 * it: the store kept the poorer copy (`appendMessages` rewrites a message it holds with the one that
 * arrives), and the prefix the provider had cached was no longer the prefix it was sent. Put back
 * from the messages the route was answered from, by id; nothing else is touched.
 *
 * Returns `mapped` itself when no message carries one.
 */
export function withCarriedReasoning(
  mapped: readonly unknown[],
  source: readonly { id: string; encryptedValue?: unknown }[],
): unknown[] {
  const carried = new Map<string, string>();
  for (const message of source) {
    if (typeof message.encryptedValue === "string" && message.encryptedValue) {
      carried.set(message.id, message.encryptedValue);
    }
  }
  if (carried.size === 0) return mapped as unknown[];
  return mapped.map((message) => {
    if (!message || typeof message !== "object") return message;
    const id = (message as { id?: unknown }).id;
    const value = typeof id === "string" ? carried.get(id) : undefined;
    return value ? { ...message, encryptedValue: value } : message;
  });
}
