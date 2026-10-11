/**
 * The one effort the main conversation is ever sent, where it is sent one at all.
 *
 * Here, and not beside the code that sends it (`server/src/copilot.ts`, which says why it is fixed
 * and why this word), because the evals have to send what production sends and cannot import the
 * server's runtime to learn one word: a second copy of it in `evals/` would be the eval measuring a
 * request no deployment makes, on the day one of the two was changed.
 */
export const FIXED_EFFORT = "balanced";

/**
 * The effort a run handed deep reasoning is sent (`delegate` to `think`, piece 6-3).
 *
 * THE ONE RUN THAT IS NOT SENT THE DEPLOYMENT'S ONE EFFORT, and still nobody's setting: no person
 * and no Bot chooses it. The server sends it to a run by what the run is — its mode — and to
 * nothing else (`server/src/copilot.ts`). What a Bot chooses is whether to hand a piece of work
 * over at all; how hard the one it is handed to thinks is fixed here.
 *
 * `thorough` is our word, like `balanced` above; each model spells it its own way or not at all
 * (`agent-bot/src/transcript.ts`, `MODEL_EFFORTS`) — a model that defines no effort is sent
 * nothing, and its deep run is the same model in a conversation of its own.
 *
 * MEASURED 2026-10-11 on the fleet's model (meta/muse-spark-1.3-contributor, three hard problems
 * with one right answer, three runs each, no tools): sent as `high` it is a different request —
 * 27% to 61% more reasoning tokens than the model's default (1,886 → 2,388, 2,669 → 4,302,
 * 6,280 → 8,611 on average), the cost and the wait up with them. It was not shown to be a more
 * correct one: 9 of 9 at the default and 9 of 9 at `high`. So this buys a longer think today and
 * a place to stand a stronger model tomorrow (the record's open question 4), and no more is
 * claimed for it.
 */
export const DEEP_EFFORT = "thorough";
