import { describe, expect, test } from "bun:test";
import { HUB_DOC_LOCK_TTL_MS } from "../../shared/hub/protocol";
import { createDocLocks } from "../src/docs/locks";
import {
  evenRanks,
  isRank,
  RANK_MAX_CHARS,
  rankBetween,
} from "../src/docs/rank";

describe("rankBetween", () => {
  test("the first rank, one before it and one after it", () => {
    const first = rankBetween(null, null);
    expect(first).toBe("i");
    expect(rankBetween(null, first) < first).toBe(true);
    expect(rankBetween(first, null) > first).toBe(true);
  });

  test("500 inserts always right after the same block stay between it and the next, in order", () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    // Each new block goes right after `a`, before every block inserted there before it.
    const inserted: string[] = [];
    let next = b;
    for (let index = 0; index < 500; index += 1) {
      const rank = rankBetween(a, next);
      expect(isRank(rank)).toBe(true);
      expect(a < rank && rank < next).toBe(true);
      inserted.unshift(rank);
      next = rank;
    }
    const all = [a, ...inserted, b];
    expect([...all].sort()).toEqual(all);
    expect(new Set(all).size).toBe(all.length);
    // It grows: this is what the renumbering past RANK_MAX_CHARS is for.
    expect(Math.max(...all.map((rank) => rank.length))).toBeGreaterThan(
      RANK_MAX_CHARS,
    );
  });

  test("refuses ranks out of order", () => {
    expect(() => rankBetween("b", "a")).toThrow();
  });

  test("a rank with no room above it in its digit still has room", () => {
    const rank = rankBetween("a", "a1");
    expect("a" < rank && rank < "a1").toBe(true);
    expect(rank.endsWith("0")).toBe(false);
  });
});

describe("evenRanks", () => {
  test.each([1, 2, 17, 5000])(
    "%i ranks: ascending, distinct, short, valid",
    (count) => {
      const ranks = evenRanks(count);
      expect(ranks).toHaveLength(count);
      expect([...ranks].sort()).toEqual(ranks);
      expect(new Set(ranks).size).toBe(count);
      for (const rank of ranks) {
        expect(isRank(rank)).toBe(true);
        expect(rank.length).toBeLessThanOrEqual(4);
      }
    },
  );
});

describe("holds", () => {
  test("one member's hold refuses another until it runs out, and its owner renews it", () => {
    let now = 1_000_000;
    const locks = createDocLocks(() => now);
    expect(locks.take("d", "b", "ann", "앤").ok).toBe(true);
    const refused = locks.take("d", "b", "bob", "밥");
    expect(refused).toEqual({
      ok: false,
      holder: {
        member: "ann",
        name: "앤",
        until: 1_000_000 + HUB_DOC_LOCK_TTL_MS,
      },
    });
    now += HUB_DOC_LOCK_TTL_MS - 1;
    expect(locks.take("d", "b", "ann", "앤")).toEqual({
      ok: true,
      hold: { member: "ann", name: "앤", until: now + HUB_DOC_LOCK_TTL_MS },
    });
    now += HUB_DOC_LOCK_TTL_MS;
    expect(locks.holder("d", "b")).toBeNull();
    expect(locks.take("d", "b", "bob", "밥").ok).toBe(true);
  });

  test("letting go is the holder's alone", () => {
    const locks = createDocLocks(() => 0);
    locks.take("d", "b", "ann", null);
    expect(locks.release("d", "b", "bob")).toBe(false);
    expect(locks.holder("d", "b")?.member).toBe("ann");
    expect(locks.release("d", "b", "ann")).toBe(true);
    expect(locks.holder("d", "b")).toBeNull();
    expect(locks.standing("d")).toEqual([]);
  });
});
