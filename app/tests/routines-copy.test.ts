import { describe, expect, test } from "bun:test";
import { ko } from "../src/lib/i18n-ko";
import { ROUTINE_REFUSALS } from "../src/lib/routines/queries";

/**
 * The routines API's refusals, which the Routines page renders straight into the create and delete
 * forms.
 *
 * It rendered the server's own sentence — "This account holds 20 routines already. Delete one to
 * make room." — on a Korean screen, because the body carried prose and nothing else. The server
 * sends a fact code now and this table owns the words, which puts `t()` on a variable and so out of
 * `i18n-coverage.test.ts`'s sight; the table is checked in and finite, so it is walked instead.
 */
describe("the routines refusal copy", () => {
  test("every refusal in the table has Korean", () => {
    const missing = Object.values(ROUTINE_REFUSALS).filter(
      (sentence) => !(sentence in ko),
    );
    expect(missing).toEqual([]);
  });

  test("the table names every code the server can send", async () => {
    /*
     * The server is the source of truth for WHICH codes exist. Read out of its source rather than
     * copied, so a code added there fails here until somebody decides what it says in Korean — the
     * failure mode being a refusal that falls through to the server's English sentence, which is
     * exactly what this pair was written to end.
     */
    const source = await Bun.file(
      new URL("../../server/src/routines/service.ts", import.meta.url),
    ).text();
    const routes = await Bun.file(
      new URL("../../server/src/routines/routes.ts", import.meta.url),
    ).text();
    const codes = new Set(
      [...`${source}${routes}`.matchAll(/"(laf:routine_[a-z_]+)"/g)].map(
        (match) => match[1] as string,
      ),
    );

    expect(codes.size).toBeGreaterThan(0);
    expect([...codes].sort()).toEqual(Object.keys(ROUTINE_REFUSALS).sort());
  });
});
