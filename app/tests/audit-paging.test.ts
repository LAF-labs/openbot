import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AUDIT_PAGE_SIZE,
  type AuditPage,
  auditEventsQueryOptions,
} from "../src/lib/audit/queries";
import { stubFetch } from "./support/fetch";

/**
 * The trail is read a page at a time, and the filters still have to work.
 *
 * The filter chips are query strings written by hand (`?eventType=a,b,c`) and the page size and
 * cursor are added to them, so the join is the thing that can go wrong: a lost `?`, a `?` where an
 * `&` belongs, or a cursor that quietly replaces the filter. Each of those looks like "the filter
 * does nothing" on a screen whose whole job is finding one event among thousands.
 */

let asked: string[] = [];
let answer: AuditPage;
let originalFetch: typeof fetch;

beforeEach(() => {
  asked = [];
  answer = { events: [] };
  originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(async (input) => {
    asked.push(String(input));
    return new Response(JSON.stringify(answer), { status: 200 });
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Run = (context: { pageParam: string | undefined }) => Promise<AuditPage>;

const run = (search: string, pageParam?: string) =>
  (auditEventsQueryOptions(search).queryFn as unknown as Run)({ pageParam });

describe("the audit trail's pages", () => {
  test("asks for a hundred rows, which is the server's ceiling", async () => {
    await run("");
    const url = new URL(asked[0] as string, "http://laf.local");
    expect(url.searchParams.get("limit")).toBe(String(AUDIT_PAGE_SIZE));
    expect(url.searchParams.get("cursor")).toBeNull();
  });

  test("keeps a filter's own query string alongside the page size", async () => {
    await run("?eventType=computer.action_refused,approval.denied");
    const url = new URL(asked[0] as string, "http://laf.local");
    expect(url.searchParams.get("eventType")).toBe(
      "computer.action_refused,approval.denied",
    );
    expect(url.searchParams.get("limit")).toBe(String(AUDIT_PAGE_SIZE));
  });

  test("carries the cursor back without losing the filter", async () => {
    await run("?eventType=agent.stream_stalled", "page-2");
    const url = new URL(asked[0] as string, "http://laf.local");
    expect(url.searchParams.get("cursor")).toBe("page-2");
    expect(url.searchParams.get("eventType")).toBe("agent.stream_stalled");
  });

  test("a page with no cursor is the last one", () => {
    const { getNextPageParam } = auditEventsQueryOptions("");
    // FOUR arguments. TanStack Query hands `getNextPageParam` the page, every page, this page's
    // param AND every param; called with three, this was calling a function of a different arity
    // than the one the library calls, which is the whole reason `app/tests` is typechecked now.
    expect(
      getNextPageParam({ events: [], nextCursor: "more" }, [], undefined, []),
    ).toBe("more");
    expect(getNextPageParam({ events: [] }, [], undefined, [])).toBeUndefined();
  });

  test("a failure is a rejection, not an empty trail", async () => {
    globalThis.fetch = stubFetch(
      async () => new Response("{}", { status: 500 }),
    );
    // An audit screen that answers "no events" to a broken request is the one lie it must not tell.
    expect(run("")).rejects.toThrow();
  });
});
