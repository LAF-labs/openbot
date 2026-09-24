import type { PromptPerson } from "../../../shared/prompt";
import type { Whereabouts } from "../../../shared/whereabouts";
import type { LoadAgentsForActor } from "../copilot";
import { log } from "../log";

/**
 * The person's clock and place, carried on every Bot's profile so the prompt can say them.
 *
 * The same wrapper `shop-context.ts` is, for the same reasons: a fact about the PERSON asking, read
 * once per request for their roster, never inside the synchronous prompt middleware — and every run
 * path (the chat runtime, a routine) resolves its agents through the loader this wraps, so a routine
 * at 07:30 with nobody's device present reads the zone the person's last session left here.
 *
 * WHAT A CHAT RUN'S DEVICE SAYS WINS OVER THIS, in the middleware (`copilot.ts`): this is the last
 * thing the person's device reported; the run's `forwardedProps.device` is what it reports now.
 *
 * A READ THAT FAILS IS LOGGED AND THE RUN GOES ON WITHOUT IT — on the deployment's clock, with the
 * place unknown, which the prompt then says honestly rather than guessing.
 */
export function withPersonContext(
  loadAgents: LoadAgentsForActor,
  readWhereabouts: (userId: string) => Promise<Whereabouts>,
): LoadAgentsForActor {
  return async (actor) => {
    const registered = await loadAgents(actor);
    const remote = registered.filter((agent) => agent.type === "remote_ag_ui");
    if (remote.length === 0) return registered;

    let person: PromptPerson;
    try {
      person = promptPersonOf(await readWhereabouts(actor.id));
    } catch (error) {
      log.warn("whereabouts_read_failed", { error });
      return registered;
    }
    for (const agent of remote) agent.profile.person = person;
    return registered;
  };
}

/** The kept facts as the prompt takes them: a missing one is absent, never an empty string. */
export function promptPersonOf(whereabouts: Whereabouts): PromptPerson {
  return {
    ...(whereabouts.timeZone ? { timeZone: whereabouts.timeZone } : {}),
    ...(whereabouts.locale ? { locale: whereabouts.locale } : {}),
    ...(whereabouts.place ? { place: whereabouts.place } : {}),
    ...(whereabouts.coordinates
      ? { coordinates: whereabouts.coordinates }
      : {}),
  };
}
