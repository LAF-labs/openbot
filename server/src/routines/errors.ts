/**
 * What a routine call refused, as a status, a code and a sentence.
 *
 * The code is the part a surface may read. English prose from the server reaching a Korean screen
 * is the thing this deployment does not do — the server sends facts and the surface owns the words
 * (see `MODEL_FAILURES` in app/src/lib/copilot/stopped-turn.ts for the same shape) — so the two
 * refusals a person can actually provoke carry one. The sentence stays for operators and for logs.
 */
export class RoutineError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    /**
     * Required, not optional. It used to be `code?`, and the route sent the sentence when it was
     * absent — which is how "The daily time must be HH:MM." reached a Korean screen. Every
     * construction names one now, so the boundary and the route always have a fact to answer with.
     */
    readonly code: `laf:${string}`,
  ) {
    super(message);
    this.name = "RoutineError";
  }
}

/**
 * A routine that is not this person's does not exist, as far as they can tell.
 *
 * 404 rather than 403, and the choice follows `agents/routes.ts`: a Bot somebody cannot see is an
 * `AgentNotFoundError` and answers 404, and 403 there is reserved for a resource they CAN see and
 * may not change — a public Bot they do not own, or one a package shipped. A routine has no public
 * visibility, so the second case has no routine equivalent and every refusal here is the first one.
 * The webhook (`service.ts`, `trigger`) already argued it: one answer for a missing routine and a
 * wrong token, so a prober cannot tell which of the two it guessed.
 */
export const noSuchRoutine = () =>
  new RoutineError("There is no such routine.", 404, "laf:routine_not_found");
