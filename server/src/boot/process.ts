import { describeFailure } from "../failure-text";
import { log } from "../log";

/**
 * One Bot's endpoint must not take down the platform.
 *
 * Restarting a remote agent while a run is in flight resets the socket. The rejection reaches the top
 * of the process, and Bun kills the whole server: every other person's conversation, every other Bot
 * and the admin surface go with it, because somebody redeployed their own agent.
 *
 * That blast radius is created by design the moment people can register their own endpoints,
 * so it belongs to that feature. A remote agent is untrusted infrastructure: it will restart, it will
 * time out, it will close a stream halfway through, and none of that is exceptional.
 *
 * Logged loudly rather than swallowed. A process that hides unhandled rejections is worse than one
 * that dies, so this prints the full reason and keeps serving; what it must never do is stay quiet.
 */
export function keepServingThroughUnhandledRejections(): void {
  process.on("unhandledRejection", (reason) => {
    // `describeFailure` rather than `reason.message`: a rejected Drizzle promise lands here too, and
    // its message is the statement and its parameters.
    log.error("unhandled_rejection", {
      reason: describeFailure(reason),
      code:
        reason && typeof reason === "object" && "code" in reason
          ? String((reason as { code: unknown }).code)
          : undefined,
      note: "The server kept running. A remote agent's connection failing must not stop everyone else.",
    });
  });
}
