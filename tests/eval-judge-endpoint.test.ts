import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/*
 * AN EVAL REACHES THE JUDGE WHERE THE PRODUCT DOES, OR NOT AT ALL. The key an eval hands a judge
 * is `OPENAI_API_KEY`, the deployment's model key; three evals dialled Jev at OpenRouter's address
 * written out, so with `OPENAI_BASE_URL` pointing at another company that key was sent to
 * OpenRouter regardless (found by reading, 2026-10-13). An eval that builds a judge's call either
 * resolves the address the way the server does (`decisionBaseUrlOf`, which is null off
 * OpenRouter) or refuses to run unless the base URL is OpenRouter's, as `auto-review.ts` and
 * `high-risk.ts` do.
 *
 * A walk of the sources, so an eval written next month is held to it too.
 */
const evals = resolve(import.meta.dir, "..", "evals");

const BUILDS_A_JUDGE = /\bjevAsker\(|\bDecisionCall\b/;
// `decisionEndpointFor` is `memory-days-facts.ts`'s wrapping of it (the switch, then the address).
const RESOLVES = /\b(?:decisionBaseUrlOf|decisionEndpointFor)\(/;
const GUARDS = /\.includes\("openrouter\.ai"\)/;
const WRITTEN_OUT = /baseUrl:\s*"https:\/\/openrouter\.ai\/api/;

const judges = readdirSync(evals)
  .filter((name) => name.endsWith(".ts"))
  .filter((name) =>
    BUILDS_A_JUDGE.test(readFileSync(join(evals, name), "utf8")),
  )
  .sort();

test("the evals that build a judge's call are the ones this walks", () => {
  expect(judges).toEqual(
    expect.arrayContaining(["cache-days.ts", "compaction.ts", "memory.ts"]),
  );
});

test.each(judges)(
  "%s reaches the judge through the deployment's endpoint, or refuses to run",
  (name) => {
    const text = readFileSync(join(evals, name), "utf8");
    const resolved = RESOLVES.test(text) && !WRITTEN_OUT.test(text);
    expect(resolved || GUARDS.test(text)).toBe(true);
  },
);
