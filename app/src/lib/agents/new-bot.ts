import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";
import { nextBotName, randomFaceSeed } from "./bot-names";
import { agentInputFrom, emptyAgentForm } from "./form";
import { type AgentInput, createAgentMutationOptions } from "./mutations";
import { type AgentProfile, agentListQueryOptions } from "./queries";
import { type Seats, seatsFrom, seatsFullMessage } from "./seats";

/**
 * A BOT EXISTS THE MOMENT SOMEBODY PRESSES THE BUTTON.
 *
 * What used to happen: a 320px pane slid out with a form asking for a name, a job title it then
 * threw away, a role description, and thirty-five faces crammed into 256 pixels — all of it in front
 * of somebody who had not yet seen a Bot say a single word. Everything on that form is a thing the
 * Bot itself can ask about, and the one field that mattered is one the product can answer.
 *
 * So it makes the Bot, gives it a name and a face, and opens its conversation. The profile card at
 * the top of that empty conversation is where the name, the face and the job are changed — beside
 * the Bot, not instead of it.
 */

/**
 * HIDDEN BOTS ARE COUNTED, because the server counts them.
 *
 * `list()` answers with either the visible roster or the hidden one, never both, so a person who
 * tidied two Bots away would have read "봇 3/5" on a full account and been refused by a server that
 * was right. The hidden list is a second request and it is cached under its own key, so it is asked
 * for once and every entry point reads the same answer.
 */
export function useSeats(): Seats {
  const { data: visible } = useQuery(agentListQueryOptions());
  const { data: hidden } = useQuery(agentListQueryOptions(true));
  const { data: user } = useQuery(currentUserQueryOptions());
  const mine = (list: AgentProfile[] | undefined) =>
    (list ?? []).filter((agent) => agent.mine).length;
  return seatsFrom(mine(visible) + mine(hidden), user?.deployment.seats);
}

/**
 * The press itself, with the React taken out of it.
 *
 * Four steps and every one of them can be wrong without anything throwing: refusing before the
 * request when the seats are gone, naming the Bot something nothing else is called, asking for it,
 * and OPENING IT. That last one is the step a screen quietly loses — a Bot created and left behind
 * on the page that made it looks exactly like a button that did nothing — so it is here, in the
 * same function as the create, where a test can watch the order.
 */
export async function createBotNow(deps: {
  seats: Seats;
  /** Names already on the roster, so the new one is not a second 초롱. */
  taken: readonly string[];
  create: (input: AgentInput) => Promise<{ id: string }>;
  open: (agentId: string) => Promise<unknown>;
}): Promise<{ ok: true; agentId: string } | { ok: false; problem: string }> {
  // Asked before the request rather than after it: the answer is already on the roster, and being
  // refused by a server after a spinner is a worse way to learn a thing the screen knew.
  if (deps.seats.isFull) {
    return { ok: false, problem: seatsFullMessage(deps.seats) };
  }
  try {
    const agent = await deps.create({
      ...agentInputFrom({ ...emptyAgentForm, name: nextBotName(deps.taken) }),
      avatarSeed: randomFaceSeed(),
    });
    // Into the Bot's own conversation, not into a settings pane. The profile card at the top of it
    // is the whole of what the form used to ask, beside a Bot that can answer for itself.
    await deps.open(agent.id);
    return { ok: true, agentId: agent.id };
  } catch (caught) {
    return {
      ok: false,
      problem:
        caught instanceof Error
          ? caught.message
          : t("That Bot could not be created. Try again."),
    };
  }
}

export function useNewBot(): {
  create: () => Promise<void>;
  isPending: boolean;
  /** Why nothing happened, in Korean, or null. */
  problem: string | null;
  seats: Seats;
} {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createAgent = useMutation(createAgentMutationOptions(queryClient));
  const { data: visible } = useQuery(agentListQueryOptions());
  const seats = useSeats();
  const [problem, setProblem] = useState<string | null>(null);
  /*
   * A REF, NOT `isPending`, for the reason welcome.tsx records: the mutation's flag is a render-time
   * value, so two clicks in the same frame both read false and both create a Bot — and here that is
   * a seat spent on a Bot nobody meant to make.
   */
  const busy = useRef(false);

  const create = async () => {
    if (busy.current) return;
    busy.current = true;
    setProblem(null);
    const outcome = await createBotNow({
      create: (input) => createAgent.mutateAsync(input),
      open: (agentId) =>
        navigate({ search: { agent: agentId }, to: "/channel/new" }),
      seats,
      taken: (visible ?? []).map((profile) => profile.name),
    });
    busy.current = false;
    if (!outcome.ok) setProblem(outcome.problem);
  };

  return { create, isPending: createAgent.isPending, problem, seats };
}
