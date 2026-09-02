import { useAgent } from "@copilotkit/react-core/v2";
import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";

/**
 * Why the last turn ended without an answer, for a surface that has to say so itself.
 *
 * A run can end three ways. It finishes, which needs no explanation. It fails in the browser, which
 * arrives as an error. Or the Bot's own stream stops producing anything and this deployment ends the
 * turn for it, which arrives as a RUN_ERROR carrying the sentence the server wrote (see
 * server/src/channels/stall-guard.ts). The last two both leave the same hole on screen: the composer
 * unlocks, the spinner disappears, and nothing says what happened.
 *
 * The reason is kept as a sentence rather than a flag because the reasons are not interchangeable. A
 * Bot that refused, a Bot whose endpoint is down and a Bot that simply stopped talking are three
 * different things to be told, and only the thing that ended the turn knows which one it was.
 */

/**
 * The sentence to show, in the words of whatever ended the turn.
 *
 * Falls back only when there is genuinely nothing to pass on. Saying "the Bot stopped without saying
 * why" is honest about that; inventing a cause would not be, and this is the one moment a person has
 * no other way to find out what went wrong.
 */
/**
 * The three ways the model service itself can fail, translated here because the code is a fact and
 * this surface owns the words (agent-bot emits the code, logs the vendor's sentence for operators,
 * and a customer never reads either vendor prose or English). Three, not one: a rate limit wants
 * waiting and says so, where "try again" in front of a refusal makes a working product look broken.
 */
export const MODEL_FAILURES: Record<string, string> = {
  "laf:model_rate_limited":
    "Answers are coming faster than the model can take right now. Give it a moment and ask again.",
  "laf:model_unavailable":
    "The Bot's model did not accept the request. If this keeps happening, the deployment needs a look.",
  "laf:model_failed": "The Bot could not reach its model. Ask again.",
  "laf:model_timed_out":
    "The model took too long and the turn was ended. Ask again, or ask for less at once.",
};

/**
 * A turn that ARRIVED and is still not the whole answer.
 *
 * Not failures — a RUN_ERROR would throw away the half that came — so `agent-bot` says them as
 * CUSTOM events on its own stream, the same channel it reports token counts on. Two things a
 * person cannot otherwise tell apart from an ordinary short answer:
 *
 * - `laf.answer_truncated`: the model hit its length limit mid-sentence. There IS more, and asking
 *   it to carry on works.
 * - `laf.empty_answer`: nothing came back at all, twice — a reasoning model that spent its whole
 *   budget deliberating. Asking again is the right move and nothing about the question was wrong.
 */
export const TURN_NOTICES: Record<string, string> = {
  "laf.answer_truncated":
    "The answer was cut off before it finished. Ask the Bot to carry on.",
  "laf.empty_answer":
    "The Bot thought about it and answered with nothing. Ask again.",
};

export function stoppedReason(reported: unknown): string {
  const said =
    reported instanceof Error
      ? reported.message
      : typeof reported === "string"
        ? reported
        : "";
  const known = MODEL_FAILURES[said.trim()];
  if (known) return t(known);
  return said.trim() || t("The Bot stopped without saying why.");
}

/** The sentence for a CUSTOM event the Bot's own stream carries, or null for one this ignores. */
export function turnNotice(name: unknown): string | null {
  const known = typeof name === "string" ? TURN_NOTICES[name] : undefined;
  return known ? t(known) : null;
}

/**
 * Watch one Bot's runs and hold on to the reason the last one ended, if it ended badly.
 *
 * Bound by agent id rather than handed an agent, so a caller that only renders the packaged chat
 * does not have to reach for one: `useAgent` returns the same shared instance the chat itself binds
 * to, so this watches exactly the runs that chat starts.
 *
 * Cleared when the next run begins rather than on a timer. A sentence about a turn that is over
 * should stay until there is something newer to look at, and the person deciding when that is is the
 * one who sends the next message.
 */
export function useStoppedTurn(agentId: string): string | null {
  const { agent } = useAgent({ agentId });
  const [stopped, setStopped] = useState<string | null>(null);

  useEffect(() => {
    const subscription = agent.subscribe?.({
      onRunInitialized: () => setStopped(null),
      onRunErrorEvent: ({ event }) => setStopped(stoppedReason(event?.message)),
      onRunFailed: ({ error }) => setStopped(stoppedReason(error)),
      /*
       * A truncated or empty answer arrives here, not as an error.
       *
       * The same stream carries `laf.model.usage`, which is nothing to a person, so anything this
       * does not have words for is left alone rather than shown as a name.
       */
      onCustomEvent: ({ event }) => {
        const notice = turnNotice((event as { name?: unknown })?.name);
        if (notice) setStopped(notice);
      },
    });
    return () => subscription?.unsubscribe();
  }, [agent]);

  return stopped;
}
