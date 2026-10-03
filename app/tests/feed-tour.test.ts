import { describe, expect, test } from "bun:test";
import { PERSONAS } from "@shared/persona";
import { tourStops } from "@/components/feed/feed-tour";
import { ko } from "@/lib/i18n-ko";

/**
 * 소식's first-day tour (2026-09-28): the same five stops for everybody, in the persona's order,
 * and every word of it in Korean — read through `t(variable)`, which the coverage test cannot see.
 *
 * A stop is two things since 2026-10-04: what the place does, and what the place is called. Its
 * two sentences more went (`everyday-screens.test.tsx` holds what is drawn).
 */
describe("the first-day tour on 소식", () => {
  test("every persona gets the same five stops; only the order differs", () => {
    const all = tourStops(null)
      .map((stop) => stop.key)
      .sort();
    expect(all).toHaveLength(5);
    for (const persona of PERSONAS) {
      expect(
        tourStops(persona)
          .map((stop) => stop.key)
          .sort(),
      ).toEqual(all);
    }
    expect(tourStops("student")[0]?.key).toBe("ideas");
    expect(tourStops("owner")[0]?.key).toBe("connections");
  });

  test("every word on a stop is in Korean, and a stop has no words but its line and its place", () => {
    for (const stop of tourStops(null)) {
      for (const words of [stop.topic, stop.title]) {
        expect(ko[words as keyof typeof ko]).toBeTruthy();
      }
      expect(Object.keys(stop).sort()).toEqual([
        "icon",
        "key",
        "title",
        "to",
        "topic",
      ]);
    }
  });
});
