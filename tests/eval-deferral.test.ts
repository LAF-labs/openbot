import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * `bun run eval:deferral` says what it measured.
 *
 * It used to run, exit 0, and print nothing — `evals/deferral.ts` had no main block, so the
 * script built the realistic toolset and ended (audit A2 §4). A measurement that exists only as a
 * claim is worse than no measurement; this pins that the script prints its table, and that the
 * table says what the bridge saves in the two units the doc quotes.
 */

const root = join(import.meta.dir, "..");

describe("bun run eval:deferral", () => {
  test("prints the schema table, by family and in total, with the saving", async () => {
    const run = Bun.spawn(["bun", "evals/deferral.ts"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(run.stdout).text();
    expect(await run.exited).toBe(0);

    expect(out).toContain("computer (core)");
    expect(out).toContain("gmail");
    expect(out).toContain("without bridge");
    expect(out).toContain("with bridge");
    // A saving, with its sign: the bridge must take bytes off, not add them.
    expect(out).toMatch(/bytes\s+[\d,]+ B\s+[\d,]+ B\s+−\d+%/);
    expect(out).toMatch(/chars\s+[\d,]+\s+[\d,]+\s+−\d+%/);
  });

  test("the table's totals are the measurement the model arm reports", async () => {
    const { measureSchema, REALISTIC_TOOLSET, schemaTable } = await import(
      "../evals/deferral"
    );
    const schema = measureSchema(REALISTIC_TOOLSET);
    const table = (await schemaTable()).join("\n");
    expect(table).toContain(schema.bytes.toLocaleString("en-US"));
    expect(table).toContain(schema.bytesDeferred.toLocaleString("en-US"));
    expect(schema.bytesDeferred).toBeLessThan(schema.bytes);
  });
});
