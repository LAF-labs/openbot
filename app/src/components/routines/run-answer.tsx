import { LazyMarkdown } from "@/lib/markdown";
import type { RunOutcome } from "@/lib/routines/list-state";

/**
 * What one run left, in a routine's history.
 *
 * A RUN'S ANSWER IS THE BOT'S PROSE, AND IT WAS PRINTED AS SOURCE. The same briefing that reads as
 * a bold heading in the conversation read `**9월 27일 (일) 아침 브리핑**` here, asterisks and all
 * (measured 2026-09-27, the first morning briefing somebody pressed 지금 실행 on) — the one screen
 * where a shop owner goes to check what their routine said. It is drawn the way the conversation
 * draws it, behind the lazy boundary.
 *
 * A stop or a failure is not the Bot's: it is this surface's own sentence (`runOutcome`), plain text,
 * and never parsed as markdown. And a block, not a `<p>`: the renderer emits paragraphs, lists and
 * tables of its own.
 */
export function RunAnswer({ outcome }: { outcome: RunOutcome }) {
  if (outcome.tone !== "done") {
    return (
      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
        {outcome.text}
      </p>
    );
  }
  return (
    <div
      className="mt-1 min-w-0 wrap-break-word text-sm leading-relaxed"
      data-slot="run-answer"
    >
      <LazyMarkdown>{outcome.text}</LazyMarkdown>
    </div>
  );
}
