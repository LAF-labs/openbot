import { randomUUID } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import type { RefusalCode } from "../failure-text";
import { routineForwarded } from "../runner/unattended";

/**
 * A routine's run when the deployment wired the routine service without tools: the instruction in,
 * the assistant's text out, or a deadline.
 *
 * Production always hands the service a toolkit (`runner/unattended.ts`), because a scheduled Bot
 * that can only think and never look answers "check the supplier's prices" with confident fiction.
 * This is the fallback for a service built without one, which is what most routine tests build.
 *
 * IT LIVED IN `agents/coworker-call.ts` until 2026-09-24, as the run a Bot being ASKED by another
 * Bot got, and routines borrowed it. One Bot asking another went with rooms when a person came to
 * have one Bot (docs/laf/deployment-model.md, "봇은 하나다"); this is the half that was a routine's.
 * It composes the routine prompt now, not the coworker one, which no longer exists.
 */
export class RunOnceError extends Error {
  constructor(
    message: string,
    /** Mirrors HTTP so a caller does not re-derive it from prose. */
    readonly status: 409 | 504,
    readonly code: RefusalCode,
  ) {
    super(message);
    this.name = "RunOnceError";
  }
}

/**
 * A person pressed `모두 멈추기` while the run was going. 409, not a failure status: nothing went
 * wrong. The routine decides "stopped" from its own signal, not from this.
 */
function stopped(): RunOnceError {
  return new RunOnceError(
    "A person stopped everything that was running, this run included.",
    409,
    "laf:run_stopped",
  );
}

export async function runAgentOnce(
  target: AbstractAgent,
  message: string,
  timeoutMs: number,
  /**
   * A person's stop (`모두 멈추기`). The run is aborted — the model told, not walked away from —
   * and this rejects. A stop that came first asks the model nothing.
   */
  signal?: AbortSignal,
  /** When the run was meant for, told to the Bot by the prompt middleware. See `runUnattended`. */
  routineRun?: { scheduledFor: Date | null },
): Promise<string> {
  if (signal?.aborted) throw stopped();
  target.setMessages([{ id: randomUUID(), role: "user", content: message }]);

  let onStop: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    if (!signal) return;
    onStop = () => {
      reject(stopped());
      // Optional in practice: a test's stand-in agent has no transport to abort.
      target.abortRun?.();
    };
    signal.addEventListener("abort", onStop, { once: true });
  });

  const outcome = await Promise.race([
    stop,
    target.runAgent({
      forwardedProps: {
        mode: "routine",
        ...(routineRun ? { routine: routineForwarded(routineRun) } : {}),
      },
    }),
    new Promise<never>((_, reject) => {
      setTimeout(
        () =>
          reject(
            // The routine deadline's own sentence, which `channels/turn-failures.ts` reads as
            // "ran out of time" rather than "no answer came back".
            new RunOnceError(
              "The run did not finish in time.",
              504,
              "laf:run_timed_out",
            ),
          ),
        timeoutMs,
      ).unref?.();
    }),
  ]).finally(() => {
    if (onStop) signal?.removeEventListener("abort", onStop);
  });

  return outcome.newMessages
    .filter((entry) => entry.role === "assistant")
    .map((entry) => (typeof entry.content === "string" ? entry.content : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
