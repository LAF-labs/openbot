import {
  composePrompt,
  type PromptMode,
  type PromptPerson,
  type RoutineNote,
} from "../../../shared/prompt";
import {
  type AgentStandingProfile,
  composeInputOf,
  promptMessageId,
  type StandingRoleMessage,
} from "../../src/copilot";

/**
 * Everything the Bot reads before the first word of the conversation, as one system message.
 *
 * An ordinary AG-UI system message rather than `forwardedProps` or framework-specific state,
 * because the endpoint on the other side may be LangGraph, Mastra, ADK or a hand-written server
 * and a system message is the only thing all of them already understand.
 *
 * IT IS THE WHOLE PROMPT. `agent-bot` used to prepend a system prompt of its own — upstream's
 * English original — and this message was the second one after it. Two authors for one prompt is
 * how a rule gets contradicted by a rule nobody remembered writing, so the service now sends
 * nothing of its own and this is all there is.
 *
 * HERE, AND NOT IN `server/src/copilot.ts`, because nothing in the product has called it since the
 * prompt was frozen per conversation (2026-09-25): the middleware composes the same message in two
 * layers and hands the context layer to the conversation's store. What a profile is mapped to is
 * still the server's own `composeInputOf`, and that mapping is what the tests calling this hold —
 * the prompt a new epoch would freeze, composed without a run's tool names.
 */
export function botPromptMessage(
  profile: AgentStandingProfile,
  options: {
    mode: PromptMode;
    now: Date;
    timeZone: string;
    /** A routine's notepad, as the run forwarded it. The composer draws it in routine mode only. */
    notepad?: readonly RoutineNote[];
    /** The person as this run knows them: the profile's, with the device's clock over it. */
    person?: PromptPerson;
  },
): StandingRoleMessage {
  return {
    id: promptMessageId(profile.id),
    role: "system",
    content: composePrompt(composeInputOf(profile, options)),
  };
}
