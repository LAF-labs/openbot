import { t } from "@/lib/i18n";
import { type ReadLine, unavailableText } from "@/lib/read-line";
import type { Reading } from "@/lib/reading";

/**
 * WHAT THE SIDEBAR SAYS ABOUT ITS BOT BESIDES DRAWING IT — DECIDED FROM TWO READS.
 *
 * The Bot's row is drawn from two lists: the Bots (`/api/agents`) and their conversations
 * (`/api/channels`). Before this, the only line was the empty one, drawn whenever the Bots list was
 * not pending and had no rows — so a roster whose read FAILED said 아직 봇이 없습니다 (measured
 * 2026-09-18, `/api/agents` answering 500): somebody with a Bot told they had none, in the one
 * column that is on screen all day.
 *
 * The line is what the reads came to — a failure, a refresh that failed over what is drawn, a Bot
 * this place does not offer — for the sidebar's `ReadNotice`, which is mounted before it speaks.
 * A pure function over the facts, so every combination is pinned without drawing the sidebar
 * (`roster-state.test.ts`).
 *
 * THERE IS NO EMPTY LINE ANY MORE (2026-09-24). A person has one Bot, and somebody with none is
 * sent to make it (`routes/_authed/_app/index.tsx`); a roster with a search, hidden rows and a
 * "none of your Bots match" went with the roster.
 */
export function rosterNotice({
  bots,
  conversations,
}: {
  bots: Reading<unknown>;
  conversations: Reading<unknown>;
}): ReadLine {
  if (bots.state === "unavailable") {
    return {
      kind: "unavailable",
      message: unavailableText(bots.why, t("Bots are not offered here.")),
    };
  }
  if (bots.state === "failed" && !bots.previous) {
    return {
      kind: "failed",
      message: t("Your Bot could not be loaded."),
      isRetrying: false,
    };
  }
  // The skeleton says it: nothing about the Bot is known yet.
  if (bots.state === "loading") return null;
  // The conversations are a second list; failing to read them is said, and the Bot stays drawn.
  if (conversations.state === "failed" && !conversations.previous) {
    return {
      kind: "failed",
      message: t("Your conversations could not be loaded."),
      isRetrying: false,
    };
  }
  if (bots.state === "failed" || conversations.state === "failed") {
    return {
      kind: "stale",
      isRetrying:
        (bots.state === "failed" && bots.isRetrying) ||
        (conversations.state === "failed" && conversations.isRetrying),
    };
  }
  return null;
}
