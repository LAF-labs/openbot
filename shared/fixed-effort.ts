/**
 * The one effort the main conversation is ever sent, where it is sent one at all.
 *
 * Here, and not beside the code that sends it (`server/src/copilot.ts`, which says why it is fixed
 * and why this word), because the evals have to send what production sends and cannot import the
 * server's runtime to learn one word: a second copy of it in `evals/` would be the eval measuring a
 * request no deployment makes, on the day one of the two was changed.
 */
export const FIXED_EFFORT = "balanced";
