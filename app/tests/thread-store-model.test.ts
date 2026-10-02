/**
 * The conversation's store against everything that can happen to it, in any order
 * (`support/thread-model.ts`): the real store, the real hub, and a seed that picks what happens
 * next. The other store tests each pin one interleaving somebody found; this looks for the next.
 *
 * A failure prints the seed's whole story — what happened, in order, and what the store and the
 * record held at the end — which is the reproduction.
 */
import { describe, expect, test } from "bun:test";
import { MODEL_CONFIGS, runModel } from "./support/thread-model";

/** Seeds for each length of run: enough to meet every way it has failed, in a few seconds. */
const SEEDS = 150;
/** Short runs find what goes wrong at once; long ones, what needs a history to go wrong. */
const LENGTHS = [8, 14, 22, 40, 70];

describe("the conversation's store, whatever happens to it and in whatever order", () => {
  for (const [name, options] of Object.entries(MODEL_CONFIGS)) {
    test(name, async () => {
      const failures: string[] = [];
      for (const steps of LENGTHS) {
        for (let seed = 1; seed <= SEEDS; seed += 1) {
          const { problems, trace } = await runModel(
            seed * 31 + steps,
            steps,
            options,
          );
          if (problems.length === 0) continue;
          failures.push(
            [
              `seed ${seed}, ${steps} steps:`,
              ...trace.map((line) => `    ${line}`),
              ...problems.map((problem) => `  !! ${problem}`),
            ].join("\n"),
          );
          if (failures.length >= 2) break;
        }
        if (failures.length >= 2) break;
      }
      // As text, so a failure is its story and not a diff of two arrays.
      expect(failures.join("\n\n")).toBe("");
    }, 60_000);
  }
});
