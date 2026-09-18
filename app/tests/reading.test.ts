import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  hasFailedOutright,
  isStale,
  type QueryFacts,
  readingOf,
  refusalCodeOf,
  settledOf,
  UNAVAILABLE_REFUSALS,
} from "../src/lib/reading";
import { RequestRefusedError, refusedRequest } from "../src/lib/refusals";

/**
 * ONE READING OF A QUERY'S FACTS, HELD TO EACH OF ITS FIVE ANSWERS.
 *
 * `readingOf` is the only place a screen's "is it loading, is it empty, did it fail, can it be had
 * at all" is decided, so every screen that reads through it inherits whatever it gets wrong. The
 * facts are handed in by hand here, which is what makes it testable without a DOM — and then once
 * through a real `QueryClient`, because the helper is only as right as its reading of what TanStack
 * Query actually reports, and the case it exists for (a failed refetch over good data) is a state
 * TanStack reaches in its own way: `status` error, `data` still in hand.
 */

const facts = <T>(overrides: Partial<QueryFacts<T>>): QueryFacts<T> => ({
  status: "pending",
  fetchStatus: "fetching",
  data: undefined,
  error: null,
  ...overrides,
});

const refused = (code: string | null, status = 500) =>
  new RequestRefusedError("the screen's own words", status, code);

describe("nothing yet", () => {
  test("is loading while the first read is out", () => {
    expect(readingOf(facts({}))).toEqual({ state: "loading" });
    // A query that has not started (idle) has nothing to show either.
    expect(readingOf(facts({ fetchStatus: "idle" }))).toEqual({
      state: "loading",
    });
  });

  test("a first read the network parked is a failure, not a skeleton for the afternoon", () => {
    /*
     * Offline, TanStack Query parks the read — `pending`, `paused` — rather than failing it, and it
     * does the same with the retry of a read that failed while the window was hidden (measured in a
     * hidden browser pane on this branch). Neither is on its way.
     */
    expect(readingOf(facts({ fetchStatus: "paused" }))).toEqual({
      state: "failed",
      previous: null,
      isRetrying: false,
    });
  });
});

describe("an answer", () => {
  test("a list with something in it is ready, and an empty one is empty", () => {
    expect(
      readingOf(facts({ status: "success", fetchStatus: "idle", data: [1] })),
    ).toEqual({ state: "ready", data: [1] });
    expect(
      readingOf(facts({ status: "success", fetchStatus: "idle", data: [] })),
    ).toEqual({ state: "empty", data: [] });
  });

  test("anything that is not a list is never empty unless the screen says what empty is", () => {
    const answer = { accounts: [], sites: [] };
    expect(
      readingOf(facts({ status: "success", fetchStatus: "idle", data: answer }))
        .state,
    ).toBe("ready");
    expect(
      readingOf(
        facts({ status: "success", fetchStatus: "idle", data: answer }),
        {
          isEmpty: (overview) =>
            overview.accounts.length === 0 && overview.sites.length === 0,
        },
      ).state,
    ).toBe("empty");
  });

  test("a refetch in flight over an answer is still that answer", () => {
    expect(
      readingOf(
        facts({ status: "success", fetchStatus: "fetching", data: [1] }),
      ),
    ).toEqual({ state: "ready", data: [1] });
    // And a refetch parked offline takes nothing away from it.
    expect(
      readingOf(facts({ status: "success", fetchStatus: "paused", data: [1] })),
    ).toEqual({ state: "ready", data: [1] });
  });
});

describe("a read that failed", () => {
  test("with nothing from before, is failed with nothing to show", () => {
    for (const error of [
      refused("laf:internal"),
      // What a proxy says with no server behind it (`app/Caddyfile`), and a bare 502.
      refused("laf:api_unreachable", 503),
      refused(null, 502),
      new TypeError("Failed to fetch"),
      new Error("anything else"),
      "not even an error",
    ]) {
      const reading = readingOf(
        facts({ status: "error", fetchStatus: "idle", error }),
      );
      expect(reading).toEqual({
        state: "failed",
        previous: null,
        isRetrying: false,
      });
      expect(hasFailedOutright(reading)).toBe(true);
      expect(settledOf(reading)).toBeNull();
    }
  });

  test("over an answer, keeps the answer — drawn the way it was drawn — and says it is old", () => {
    const reading = readingOf(
      facts({
        status: "error",
        fetchStatus: "idle",
        data: ["a routine"],
        error: refused("laf:internal"),
      }),
    );
    expect(reading).toEqual({
      state: "failed",
      previous: { state: "ready", data: ["a routine"] },
      isRetrying: false,
    });
    expect(isStale(reading)).toBe(true);
    expect(hasFailedOutright(reading)).toBe(false);
    expect(settledOf(reading)).toEqual({ state: "ready", data: ["a routine"] });

    // An empty answer from before stays an empty one: "none yet" was true when it was read.
    expect(
      settledOf(
        readingOf(
          facts({
            status: "error",
            fetchStatus: "idle",
            data: [],
            error: refused(null),
          }),
        ),
      ),
    ).toEqual({ state: "empty", data: [] });
  });

  test("asked again, says so — the button that asks is busy until the answer", () => {
    const reading = readingOf(
      facts({
        status: "error",
        fetchStatus: "fetching",
        data: [1],
        error: refused("laf:internal"),
      }),
    );
    expect(reading.state === "failed" && reading.isRetrying).toBe(true);
  });
});

describe("a read this place or this account cannot have", () => {
  test("is unavailable for every shared refusal, whatever the status beside it", () => {
    for (const [code, why] of Object.entries(UNAVAILABLE_REFUSALS)) {
      expect(
        readingOf(
          facts({ status: "error", fetchStatus: "idle", error: refused(code) }),
        ),
      ).toEqual({ state: "unavailable", code, why });
    }
  });

  test("outranks what was read before: a refusal is not shown the old answer", () => {
    expect(
      readingOf(
        facts({
          status: "error",
          fetchStatus: "idle",
          data: ["what this account held"],
          error: refused("laf:no_access", 403),
        }),
      ),
    ).toEqual({
      state: "unavailable",
      code: "laf:no_access",
      why: "not_allowed",
    });
  });

  test("a screen may name a refusal of its own, and only that screen reads it so", () => {
    const gone = facts<string>({
      status: "error",
      fetchStatus: "idle",
      error: refused("laf:agent_not_found", 404),
    });
    expect(readingOf(gone).state).toBe("failed");
    expect(
      readingOf(gone, {
        unavailable: { "laf:agent_not_found": "not_allowed" },
      }),
    ).toEqual({
      state: "unavailable",
      code: "laf:agent_not_found",
      why: "not_allowed",
    });
  });

  test("is decided by the code, never by a status alone", () => {
    // A 404 with no code is a proxy or a typo, not a statement about this deployment.
    expect(
      readingOf(
        facts({
          status: "error",
          fetchStatus: "idle",
          error: refused(null, 404),
        }),
      ).state,
    ).toBe("failed");
    // And a 403 with no code is not somebody being refused.
    expect(
      readingOf(
        facts({
          status: "error",
          fetchStatus: "idle",
          error: refused(null, 403),
        }),
      ).state,
    ).toBe("failed");
  });
});

describe("the code on a thrown error", () => {
  test("is read off any class that carries one, and only when it is a `laf:` fact", () => {
    class SomeRefusal extends Error {
      readonly code = "laf:not_found";
    }
    expect(refusalCodeOf(new SomeRefusal("x"))).toBe("laf:not_found");
    expect(refusalCodeOf(refused("laf:no_access"))).toBe("laf:no_access");
    expect(
      refusalCodeOf(Object.assign(new Error("x"), { code: "ENOENT" })),
    ).toBe(null);
    expect(refusalCodeOf({ code: "laf:not_found" })).toBe(null);
    expect(refusalCodeOf(null)).toBe(null);
  });

  test("is read off the body of a refused response, and is null for a body that is not JSON", async () => {
    const withCode = await refusedRequest(
      new Response(JSON.stringify({ code: "laf:not_found" }), { status: 404 }),
      "words",
    );
    expect([withCode.status, withCode.code, withCode.message]).toEqual([
      404,
      "laf:not_found",
      "words",
    ]);
    const proxyPage = await refusedRequest(
      new Response("<html>Bad Gateway</html>", { status: 502 }),
      "words",
    );
    expect([proxyPage.status, proxyPage.code]).toEqual([502, null]);
  });
});

describe("the refusals it treats as 'not here'", () => {
  /*
   * "Read the server's codes; do not guess." Every code the shared table names has to be one the
   * server actually sends — a code that exists only here would be a guess at what "not here" looks
   * like, and the day the server said it differently the screen would offer 다시 시도 again.
   */
  const SERVER = join(import.meta.dir, "../../server/src");
  const serverSource = (directory: string): string =>
    readdirSync(directory)
      .map((entry) => join(directory, entry))
      .map((path) =>
        statSync(path).isDirectory()
          ? serverSource(path)
          : path.endsWith(".ts")
            ? readFileSync(path, "utf8")
            : "",
      )
      .join("\n");
  const source = serverSource(SERVER);

  test("are each sent by the server, by that name", () => {
    expect(
      Object.keys(UNAVAILABLE_REFUSALS).filter(
        (code) => !source.includes(`"${code}"`),
      ),
    ).toEqual([]);
  });

  test("do not include the ones that come right on their own", () => {
    // A proxy with no server behind it, a model refusing for now, the server throwing.
    for (const code of [
      "laf:api_unreachable",
      "laf:rate_limited",
      "laf:internal",
      "laf:computer_unreachable",
    ]) {
      expect(code in UNAVAILABLE_REFUSALS).toBe(false);
    }
  });
});

describe("through a real query client", () => {
  test("a refetch that fails keeps the answer, and the answer comes back when it succeeds", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let failing = false;
    const observer = new QueryObserver(client, {
      queryKey: ["reading-test"],
      queryFn: async () => {
        if (failing) throw refused("laf:internal");
        return ["the routine"];
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();
    expect(readingOf(observer.getCurrentResult())).toEqual({
      state: "ready",
      data: ["the routine"],
    });

    failing = true;
    await observer.refetch();
    expect(readingOf(observer.getCurrentResult())).toEqual({
      state: "failed",
      previous: { state: "ready", data: ["the routine"] },
      isRetrying: false,
    });

    failing = false;
    await observer.refetch();
    expect(readingOf(observer.getCurrentResult()).state).toBe("ready");
    unsubscribe();
    client.clear();
  });

  test("a first read refused as 'not here' is unavailable, and asking again goes back through loading", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const observer = new QueryObserver(client, {
      queryKey: ["reading-test-refused"],
      queryFn: async (): Promise<string[]> => {
        throw refused("laf:not_found", 404);
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();
    expect(readingOf(observer.getCurrentResult())).toEqual({
      state: "unavailable",
      code: "laf:not_found",
      why: "not_configured",
    });
    // Nothing held, so a new attempt is a new first read: `pending` again, not an error in flight.
    const again = observer.refetch();
    expect(readingOf(observer.getCurrentResult())).toEqual({
      state: "loading",
    });
    await again;
    unsubscribe();
    client.clear();
  });
});
