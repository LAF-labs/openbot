/**
 * A READ OF THE RECORD THAT IS NEVER ANSWERED IS GIVEN UP ON.
 *
 * Words kept for a card are settled against the record, and read for again only once a read has
 * come back without it — the page a time, back to their question (`readRecord` in
 * `server-channel-chat.tsx`), or the whole conversation on the screen that drives its own turns
 * (`readRecordAgain` in `channel-chat.tsx`). A request the server accepted and never answered came
 * back with nothing at all: the loop never reached its next try, nor saw that the screen had gone,
 * and the words stayed hidden or under their card for as long as the page was open (review, ninth
 * round). Each read has its own wait now (`deadline`).
 */
import { afterEach, describe, expect, jest, test } from "bun:test";
import { loadThreadHistory } from "@/lib/channels/thread-history";
import { readHistory } from "@/lib/turns/client";

const fetched = globalThis.fetch;
afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = fetched;
});

/** A server that takes the request and never answers it — until the request is called off. */
function neverAnswers() {
  const called: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    called.push(String(input));
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The request was called off.", "AbortError")),
      );
    });
  }) as typeof fetch;
  return called;
}

async function settle() {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe("a read of the record that is never answered", () => {
  test("is given up on after half a minute: a page of it", async () => {
    jest.useFakeTimers();
    const called = neverAnswers();
    let read: unknown = "out";
    void readHistory("thread-1", 470).then((page) => {
      read = page;
    });
    await settle();
    expect(called).toEqual(["/api/turns/thread-1/history?before=470"]);
    jest.advanceTimersByTime(29_999);
    await settle();
    expect(read).toBe("out");
    jest.advanceTimersByTime(1);
    await settle();
    expect(read).toBeNull();
  });

  test("and after a minute, the whole of it, on the screen that drives its own turns", async () => {
    jest.useFakeTimers();
    neverAnswers();
    let read: unknown = "out";
    void loadThreadHistory("thread-1", "agent-1").then((messages) => {
      read = messages;
    });
    await settle();
    jest.advanceTimersByTime(59_999);
    await settle();
    expect(read).toBe("out");
    jest.advanceTimersByTime(1);
    await settle();
    expect(read).toBeNull();
  });
});
