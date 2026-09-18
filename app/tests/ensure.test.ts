import { describe, expect, test } from "bun:test";
import { ensure } from "../src/lib/ensure";

/**
 * `ensure` IS `try`…`finally`, OR IT IS NOT ALLOWED TO REPLACE ONE.
 *
 * Four components hand their `finally` blocks to it so that the React Compiler can compile them, and
 * every one of those blocks clears a busy flag: a Stop button, a send in flight, a poll that
 * schedules the next one. A version of this that ran `after` too early, or not at all when `work`
 * threw, would leave a button spinning or a screen that stops refreshing — so each way the
 * statement behaves is held here, against the statement itself where the two could differ.
 */

describe("ensure", () => {
  test("calls work at once, before it returns", () => {
    const seen: string[] = [];
    const running = ensure(
      () => {
        seen.push("work");
        return Promise.resolve();
      },
      () => seen.push("after"),
    );
    seen.push("returned");
    expect(seen).toEqual(["work", "returned"]);
    return running;
  });

  test("runs after once work has settled, and passes work's value on", async () => {
    const seen: string[] = [];
    let finish = (_value: number) => {};
    const running = ensure(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
      () => seen.push("after"),
    );
    await Promise.resolve();
    expect(seen).toEqual([]);
    finish(7);
    expect(await running).toBe(7);
    expect(seen).toEqual(["after"]);
  });

  test("runs after before the caller sees work's failure, and passes the same error on", async () => {
    const seen: string[] = [];
    const failure = new Error("refused");
    const outcome = await ensure(
      () => Promise.reject(failure),
      () => seen.push("after"),
    ).catch((error: unknown) => {
      seen.push("caught");
      return error;
    });
    expect(outcome).toBe(failure);
    expect(seen).toEqual(["after", "caught"]);
  });

  test("treats work throwing before it returns a promise the way the statement does", async () => {
    const failure = new Error("thrown at once");
    const statement = async (after: () => void) => {
      try {
        await (() => {
          throw failure;
        })();
      } finally {
        after();
      }
    };
    const viaStatement: string[] = [];
    const viaEnsure: string[] = [];
    await statement(() => viaStatement.push("after")).catch((error) =>
      viaStatement.push(error === failure ? "same error" : "other error"),
    );
    await ensure(
      () => {
        throw failure;
      },
      () => viaEnsure.push("after"),
    ).catch((error) =>
      viaEnsure.push(error === failure ? "same error" : "other error"),
    );
    expect(viaEnsure).toEqual(viaStatement);
    expect(viaEnsure).toEqual(["after", "same error"]);
  });
});
