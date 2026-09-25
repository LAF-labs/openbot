/**
 * A thread's history, as a window that joins it is shown: every past run closed, none of them failed.
 *
 * The vendored runner's `connect` replays every run this process holds for the thread, compacted
 * into one stream, and a window runs that stream through AG-UI's `verifyEvents` like a live one.
 * A run a person stopped while the Bot was thinking ends in a RUN_ERROR ("The operation was
 * aborted."), and verifyEvents takes no event after one — so the next run's RUN_STARTED threw
 * "The run has already errored", and every window that opened the conversation afterwards logged
 * `agent_connect_failed`, counted the replay as a failed turn and fell back to fetching the thread
 * (MEASURED 2026-09-26 on the 0.5.4 stack: Stop mid-thought, one more message, a new window).
 *
 * UPSTREAM has no fix to take: `connect` in CopilotKit's in-memory runner is unchanged at v1.73.3,
 * and the change that would tell a replayed error from a live one (CopilotKit#7353) is open and
 * spans the client, the runtime and the wire. So the replay is settled here, where it leaves.
 *
 * EVERY PAST ERROR, NOT ONLY A STOP'S. A past run that failed on its own breaks the replay in
 * exactly the same way, and a window joining a conversation is not where it failed: the transcript
 * says so from the ledger (`GET /channels/:id/failures`), with its own words and 다시 시도. A past
 * RUN_ERROR becomes the RUN_FINISHED verifyEvents needs, after closing whatever that run had open.
 * A closed tool call is not an answered one — no result is made up, so a step that never got its
 * answer still reads 멈춤 on its card. Only the replayed part is touched: an error a run still going
 * on sends reaches every window as it happens.
 */
import type { BaseEvent } from "@ag-ui/client";
import { Observable } from "rxjs";

type Loose = BaseEvent & {
  runId?: string;
  threadId?: string;
  messageId?: string;
  toolCallId?: string;
  stepName?: string;
};

/**
 * A stepper over the replayed events: hand it each one in order, and it hands back what to send in
 * its place — itself, or for a RUN_ERROR, the closers and a RUN_FINISHED.
 */
export function createReplaySettler(): (event: BaseEvent) => BaseEvent[] {
  let run: { threadId?: string; runId?: string } | null = null;
  const messages = new Set<string>();
  const calls = new Set<string>();
  const steps = new Set<string>();

  return (raw) => {
    const event = raw as Loose;
    switch (String(event.type)) {
      case "RUN_STARTED":
        run = { threadId: event.threadId, runId: event.runId };
        messages.clear();
        calls.clear();
        steps.clear();
        return [raw];
      case "RUN_FINISHED":
        run = null;
        return [raw];
      case "TEXT_MESSAGE_START":
        if (event.messageId) messages.add(event.messageId);
        return [raw];
      case "TEXT_MESSAGE_END":
        if (event.messageId) messages.delete(event.messageId);
        return [raw];
      case "TOOL_CALL_START":
        if (event.toolCallId) calls.add(event.toolCallId);
        return [raw];
      case "TOOL_CALL_END":
        if (event.toolCallId) calls.delete(event.toolCallId);
        return [raw];
      case "STEP_STARTED":
        if (event.stepName) steps.add(event.stepName);
        return [raw];
      case "STEP_FINISHED":
        if (event.stepName) steps.delete(event.stepName);
        return [raw];
      case "RUN_ERROR": {
        // An error outside any run has nothing to close and nothing to finish.
        if (run === null) return [];
        const closing: BaseEvent[] = [
          ...[...messages].map(
            (messageId) =>
              ({ type: "TEXT_MESSAGE_END", messageId }) as unknown as BaseEvent,
          ),
          ...[...calls].map(
            (toolCallId) =>
              ({ type: "TOOL_CALL_END", toolCallId }) as unknown as BaseEvent,
          ),
          ...[...steps].map(
            (stepName) =>
              ({ type: "STEP_FINISHED", stepName }) as unknown as BaseEvent,
          ),
          {
            type: "RUN_FINISHED",
            threadId: run.threadId,
            runId: run.runId,
          } as unknown as BaseEvent,
        ];
        run = null;
        messages.clear();
        calls.clear();
        steps.clear();
        return closing;
      }
      default:
        return [raw];
    }
  };
}

/**
 * The connection's stream with its first `replayed` events settled and everything after passed
 * through untouched. `replayed` is how many the vendored `connect` replays from history, counted
 * with the same compaction in the same tick (`getThreadEvents`).
 */
export function settleReplay(
  source: Observable<BaseEvent>,
  replayed: number,
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    const settle = createReplaySettler();
    let seen = 0;
    const subscription = source.subscribe({
      next: (event) => {
        seen += 1;
        if (seen > replayed) {
          subscriber.next(event);
          return;
        }
        for (const out of settle(event)) subscriber.next(out);
      },
      error: (error: unknown) => subscriber.error(error),
      complete: () => subscriber.complete(),
    });
    return () => subscription.unsubscribe();
  });
}
