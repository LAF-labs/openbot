/**
 * The group avatar's arithmetic, held to the invariant that was broken.
 *
 * What shipped was `tile = size / (length / 2)`, which for two participants is the whole box: two
 * full-size faces, the second dragged 75% of its own width over the first, leaving an 8px crescent
 * of the second Bot and an 8px overhang past the box. Nothing in the suite could see it, because
 * nothing tested the numbers. These do.
 */
import { describe, expect, it } from "bun:test";
import {
  drawnFaceCount,
  stackedFaces,
} from "@/components/channels/avatar-stack";

const SIZES = [20, 24, 32, 36, 40, 64, 80];

describe("stackedFaces", () => {
  it("draws one full-size face for a lone participant", () => {
    expect(stackedFaces(1, 36)).toEqual([{ diameter: 36, left: 0, top: 0 }]);
  });

  it("never lets a face leave the box, at any crowd size or scale", () => {
    for (const size of SIZES) {
      for (let count = 1; count <= 4; count += 1) {
        for (const face of stackedFaces(count, size)) {
          expect(face.left).toBeGreaterThanOrEqual(0);
          expect(face.top).toBeGreaterThanOrEqual(0);
          // The bug in one line: `left + diameter` used to reach 45 inside a 36px box.
          expect(face.left + face.diameter).toBeLessThanOrEqual(size);
          expect(face.top + face.diameter).toBeLessThanOrEqual(size);
          expect(face.diameter).toBeGreaterThan(0);
        }
      }
    }
  });

  it("gives every face in a stack the same diameter", () => {
    for (let count = 2; count <= 4; count += 1) {
      const diameters = new Set(
        stackedFaces(count, 36).map((face) => face.diameter),
      );
      expect(diameters.size).toBe(1);
    }
  });

  it("places two faces on a diagonal, each more than half visible", () => {
    const [first, second] = stackedFaces(2, 100);
    if (!first || !second) throw new Error("two faces expected");
    expect(first).toEqual({ diameter: 68, left: 0, top: 0 });
    expect(second).toEqual({ diameter: 68, left: 32, top: 32 });
    // Centres far enough apart that neither face is swallowed — the crescent is what went wrong.
    const centres = Math.hypot(
      second.left - first.left,
      second.top - first.top,
    );
    expect(centres).toBeGreaterThan(first.diameter / 2);
  });

  it("places three faces as a triangle, one over two", () => {
    const places = stackedFaces(3, 100);
    expect(places).toHaveLength(3);
    expect(places.map((face) => face.top)).toEqual([0, 40, 40]);
    // The apex is centred over the pair below it.
    expect(places[0]?.left).toBe(20);
    expect(places[1]?.left).toBe(0);
    expect(places[2]?.left).toBe(40);
  });

  it("packs four faces into a 2x2 cluster with distinct corners", () => {
    const places = stackedFaces(4, 100);
    expect(places).toHaveLength(4);
    const corners = new Set(places.map((face) => `${face.left},${face.top}`));
    expect(corners.size).toBe(4);
  });

  it("overlaps the faces rather than tiling them apart", () => {
    for (let count = 2; count <= 4; count += 1) {
      const places = stackedFaces(count, 100);
      const first = places[0];
      const second = places[1];
      if (!first || !second) throw new Error("two faces expected");
      const gap = Math.hypot(second.left - first.left, second.top - first.top);
      expect(gap).toBeLessThan(first.diameter);
    }
  });
});

describe("drawnFaceCount", () => {
  it("draws at least one face and never more than four", () => {
    expect(drawnFaceCount(0)).toBe(1);
    expect(drawnFaceCount(1)).toBe(1);
    expect(drawnFaceCount(3)).toBe(3);
    expect(drawnFaceCount(4)).toBe(4);
    // A room holds eight; eight faces at 36px is a smudge, so the row's name counts the rest.
    expect(drawnFaceCount(8)).toBe(4);
  });

  it("agrees with how many places the layout returns", () => {
    for (let count = 1; count <= 8; count += 1) {
      expect(stackedFaces(drawnFaceCount(count), 36)).toHaveLength(
        drawnFaceCount(count),
      );
    }
  });
});
