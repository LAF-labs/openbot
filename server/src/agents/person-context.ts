import type { PromptPerson } from "../../../shared/prompt";
import type { Coordinates, Whereabouts } from "../../../shared/whereabouts";
import type { LoadAgentsForActor } from "../copilot";
import { log } from "../log";
import { kmaCellOf } from "../plugins/kma-grid";
import { KMA_PLACES } from "../plugins/kma-places";

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

/**
 * What the place a device's coordinates fall in is called, where 기상청's table has a name for it:
 * the districts whose 동 sit in that forecast cell ("서울특별시 강남구·서초구"). Null abroad, at sea,
 * and on a deployment whose table is empty.
 *
 * The same name the weather tool hands back with an answer for coordinates
 * (`kma-weather-rest.ts`, `located`) — read from the table, never worked out from the numbers.
 */
export function nameNear(coordinates: Coordinates): string | null {
  const cell = kmaCellOf(coordinates.latitude, coordinates.longitude);
  return cell ? KMA_PLACES.nameOf(cell) : null;
}

/**
 * The kept facts as the prompt takes them: a missing one is absent, never an empty string.
 *
 * COORDINATES WITH NO WORDS ARE GIVEN A NAME (`near`). A Bot holding only "위도 37.50, 경도 127.03"
 * and asked for a pharmacy nearby either asked which neighbourhood — of somebody whose device had
 * just said where it is — or named one itself from the numbers ("강남역 근처로 보여서"), which is
 * a guess said as a fact (measured 2026-10-05). With words, the words are the place and no name is
 * added: what a person said is not annotated with where their device happens to be.
 */
export function promptPersonOf(
  whereabouts: Whereabouts,
  nameOf: (coordinates: Coordinates) => string | null = nameNear,
): PromptPerson {
  const near =
    whereabouts.coordinates && !whereabouts.place
      ? nameOf(whereabouts.coordinates)
      : null;
  return {
    ...(whereabouts.timeZone ? { timeZone: whereabouts.timeZone } : {}),
    ...(whereabouts.locale ? { locale: whereabouts.locale } : {}),
    ...(whereabouts.place ? { place: whereabouts.place } : {}),
    ...(whereabouts.coordinates
      ? { coordinates: whereabouts.coordinates }
      : {}),
    ...(near ? { near } : {}),
  };
}
