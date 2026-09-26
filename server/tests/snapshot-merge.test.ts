/**
 * The merge that keeps a delivered message alive across a client's next turn.
 *
 * Every run's input is the caller's copy of the thread, and it used to replace the snapshot
 * wholesale. A routine can deliver an answer into the thread while no tab is open; a tab hydrated
 * before that would then, on its next turn, overwrite the thread with a history that never had it.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { mergeKeepingStoredOnly } from "../src/runner/laf-runner";

const m = (id: string, role = "user"): Message =>
  ({ id, role, content: id }) as Message;
const ids = (messages: Message[]) => messages.map((x) => x.id);

describe("merging the client's history with the store", () => {
  test("a stored message the client never saw is kept where it was", () => {
    const stored = [m("u1"), m("a1", "assistant"), m("routine", "assistant")];
    const incoming = [m("u1"), m("a1", "assistant"), m("u2")];
    expect(ids(mergeKeepingStoredOnly(stored, incoming))).toEqual([
      "u1",
      "a1",
      "routine",
      "u2",
    ]);
  });

  test("a live copy without the reasoning the store filed gets the store's", () => {
    const thought = '{"model":"m","reasoning_details":[]}';
    const stored = [
      m("u1"),
      { ...m("a1", "assistant"), encryptedValue: thought } as Message,
    ];
    const incoming = [m("u1"), m("a1", "assistant")];
    const merged = mergeKeepingStoredOnly(stored, incoming);
    expect(merged[1]).toHaveProperty("encryptedValue", thought);
    // Where the live copy has its own, the live copy's stands.
    const own = [
      m("u1"),
      { ...m("a1", "assistant"), encryptedValue: "live" } as Message,
    ];
    expect(mergeKeepingStoredOnly(stored, own)[1]).toHaveProperty(
      "encryptedValue",
      "live",
    );
  });

  test("the client's own order wins where both agree", () => {
    const stored = [m("u1"), m("a1", "assistant")];
    const incoming = [
      m("u1"),
      m("a1", "assistant"),
      m("u2"),
      m("a2", "assistant"),
    ];
    expect(ids(mergeKeepingStoredOnly(stored, incoming))).toEqual(
      ids(incoming),
    );
  });

  test("an empty store changes nothing", () => {
    expect(ids(mergeKeepingStoredOnly([], [m("u1")]))).toEqual(["u1"]);
  });

  test("a store the client has never seen goes first, in order", () => {
    const stored = [m("old1"), m("old2", "assistant")];
    expect(ids(mergeKeepingStoredOnly(stored, [m("new1")]))).toEqual([
      "old1",
      "old2",
      "new1",
    ]);
  });
});

/**
 * The merge as it was written before 2026-09-26, kept verbatim as the reference the linear one must
 * agree with: `findIndex` and `splice` over the result for every stored message. Correct and
 * quadratic — 3.9 s at 40,000 messages, twice per read of the messages route.
 */
function quadraticReference(
  stored: readonly Message[],
  incoming: readonly Message[],
): Message[] {
  const incomingIds = new Set(incoming.map((message) => message.id));
  const result = [...incoming];
  let insertAfter = -1;
  for (const message of stored) {
    const at = result.findIndex((candidate) => candidate.id === message.id);
    if (at !== -1) {
      insertAfter = at;
      const live = result[at];
      const kept = (message as { encryptedValue?: unknown }).encryptedValue;
      if (
        live &&
        typeof kept === "string" &&
        (live as { encryptedValue?: unknown }).encryptedValue === undefined
      ) {
        result[at] = { ...live, encryptedValue: kept } as Message;
      }
      continue;
    }
    if (incomingIds.has(message.id)) continue;
    result.splice(insertAfter + 1, 0, message);
    insertAfter += 1;
  }
  return result;
}

describe("the merge is linear and says exactly what it said", () => {
  const reasoned = (id: string, value: string): Message =>
    ({ ...m(id, "assistant"), encryptedValue: value }) as Message;

  test("a mixed history: interleaved, stored-only runs, reasoning, a duplicate id", () => {
    const stored = [
      m("s0"),
      m("u1"),
      reasoned("a1", "thought-1"),
      m("routine-1", "assistant"),
      m("routine-2", "assistant"),
      m("u2"),
      m("s-late", "assistant"),
      reasoned("a2", "thought-2"),
      m("u1"),
      m("after-u1-again", "assistant"),
    ];
    const incoming = [
      m("u1"),
      m("a1", "assistant"),
      m("u2"),
      reasoned("a2", "live"),
      m("u1"),
      m("u3"),
    ];
    const merged = mergeKeepingStoredOnly(stored, incoming);
    expect(merged).toEqual(quadraticReference(stored, incoming));
    expect(ids(merged)).toEqual([
      "s0",
      "u1",
      "after-u1-again",
      "a1",
      "routine-1",
      "routine-2",
      "u2",
      "s-late",
      "a2",
      "u1",
      "u3",
    ]);
    // The store's reasoning where the live copy had none; the live copy's own where it had one.
    expect(merged[3]).toHaveProperty("encryptedValue", "thought-1");
    expect(merged[8]).toHaveProperty("encryptedValue", "live");
  });

  test("agrees with the reference on many random histories", () => {
    // A fixed-seed generator, so a failure names the case that produced it.
    let seed = 20260926;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 500; round += 1) {
      const pool = Array.from({ length: 12 }, (_, index) => `id-${index}`);
      const pick = (count: number) =>
        Array.from({ length: count }, () => {
          const id = pool[Math.floor(next() * pool.length)] ?? "id-0";
          return next() < 0.3 ? reasoned(id, `r-${round}`) : m(id);
        });
      const stored = pick(Math.floor(next() * 10));
      const incoming = pick(Math.floor(next() * 10));
      expect(mergeKeepingStoredOnly(stored, incoming)).toEqual(
        quadraticReference(stored, incoming),
      );
    }
  });

  test("a long conversation merges in well under a second", () => {
    // 50,000 messages, the client missing every tenth: the old merge took ~6 s here.
    const stored = Array.from({ length: 50_000 }, (_, index) =>
      m(`m-${index}`, index % 2 ? "assistant" : "user"),
    );
    const incoming = stored.filter((_, index) => index % 10 !== 0);
    const started = performance.now();
    const merged = mergeKeepingStoredOnly(stored, incoming);
    const took = performance.now() - started;
    expect(merged).toHaveLength(50_000);
    expect(ids(merged)).toEqual(ids(stored));
    // Generous on purpose: this is a ceiling against quadratic, not a benchmark.
    expect(took).toBeLessThan(1_500);
  });
});
