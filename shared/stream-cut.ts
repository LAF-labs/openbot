/**
 * A CALL WHOSE ARGUMENTS NEVER FINISHED ARRIVING: how it is answered, and how it is recognised.
 *
 * SEEN 2026-09-27 (the 지원사업 walk): a provider cut the stream in the middle of a round of
 * `remember` calls; the thread was left holding `remember` calls with empty arguments, answered
 * "적을 내용이 비어 있다", and every 다시 시도 failed the same way. Measured behind it: every later
 * request handed each half-written call back to the model as a call it had made — as
 * `remember({})`, because half an argument list is not an object and goes back as an empty one
 * (`agent-bot/src/transcript.ts`) — and a model shown itself calling a tool with nothing is shown
 * how to call it.
 *
 * So there is one answer for such a call, written wherever the cut is noticed — `agent-bot` when
 * its stream from the provider stops (`run.ts`), the server when the Bot's own stream stops before
 * the call was answered (`turns/engine.ts`) — and the model is never shown the call again: the
 * provider's transcript leaves out every call answered this way, and the answer with it. The thread
 * keeps both, so the person still reads that something was cut and where.
 */
import { toolResultText } from "./prompt/tool-results.ko";

/** The fact itself: in the call's answer, and the run's RUN_ERROR. */
export const STREAM_CUT = "laf:provider_stream_cut";

/** The answer a call cut partway through its arguments is filed with. The same envelope as any fact. */
export function streamCutResult(): string {
  return JSON.stringify({
    ok: false,
    code: STREAM_CUT,
    reason: toolResultText(STREAM_CUT),
  });
}

/** Whether a tool result is that answer. By its code: `ok: false` is every refusal's. */
export function isStreamCutResult(content: unknown): boolean {
  if (typeof content !== "string" || !content.includes(STREAM_CUT)) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    return (
      !!parsed &&
      typeof parsed === "object" &&
      (parsed as { code?: unknown }).code === STREAM_CUT
    );
  } catch {
    return false;
  }
}
