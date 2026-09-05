import { describe, expect, test } from "bun:test";
import { DATA_FUNCTIONS } from "../../server/src/components/functions";
import { DATA_FUNCTION_COPY } from "../src/lib/components/queries";
import { ko } from "../src/lib/i18n-ko";

/**
 * THE TWO ENGLISH LINES UNDER EVERY COMPONENT ON `/admin/components`.
 *
 * A data function is described twice on that page — what it does, in the button's tooltip, and what
 * it reads, beside its name — and both strings came from the server. `functions.ts` says outright
 * that they are for an administrator and never for a model, which is exactly what makes them copy:
 * a person reads them, so the surface owns them (CLAUDE.md). They were printed verbatim under every
 * component in the list, in English, on a Korean screen.
 *
 * Walked against the server's own catalogue, the way `audit-labels.test.ts` walks the event types.
 * A function added there and not here falls back to the server's English rather than to a blank —
 * visible and fixable — and this is what makes somebody fix it.
 */
describe("what a data function says on the admin page", () => {
  test("every function this build ships has words of its own", () => {
    const unwritten = DATA_FUNCTIONS.map((fn) => fn.name).filter(
      (name) => !(name in DATA_FUNCTION_COPY),
    );
    expect(unwritten).toEqual([]);
    // A catalogue that stopped exporting anything would pass the line above by walking nothing.
    expect(DATA_FUNCTIONS.length).toBeGreaterThan(0);
  });

  test("every one of those has Korean", () => {
    const missing: string[] = [];
    for (const [name, copy] of Object.entries(DATA_FUNCTION_COPY)) {
      for (const value of [copy.description, copy.reads]) {
        if (!(value in ko)) missing.push(`${name}: ${value}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the keys are the server's own sentences, so a stale one is visible", () => {
    /*
     * The English here is a KEY, and it has to be the string the server actually sends: that is
     * what makes the fallback readable when this table has not caught up, and what makes a
     * reworded server sentence show up as an English line rather than as silence.
     */
    for (const fn of DATA_FUNCTIONS) {
      const copy = DATA_FUNCTION_COPY[fn.name];
      expect({ name: fn.name, description: copy?.description }).toEqual({
        name: fn.name,
        description: fn.description,
      });
      expect({ name: fn.name, reads: copy?.reads }).toEqual({
        name: fn.name,
        reads: fn.reads,
      });
    }
  });
});
