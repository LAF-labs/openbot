import { describe, expect, test } from "bun:test";
import {
  isKmaCell,
  KMA_GRID,
  kmaCellCentre,
  kmaCellOf,
} from "../src/plugins/kma-grid";

/**
 * A coordinate to a cell of the 기상청 forecast grid, held to what 기상청 itself publishes.
 *
 * The projection's constants are eight numbers that circulate from one blog post to the next, and
 * a wrong one does not fail: it answers the weather of the next valley. So they are pinned to two
 * things that are 기상청's own. The two city halls are the pair every copy of the conversion is
 * checked against. The four corners are stronger: the API hub's page for its converter
 * (apihub.kma.go.kr, 예특보 2.4, read 2026-10-02) gives the ranges it accepts — x 1–149, y 1–253,
 * longitude 123.310165–132.774963, latitude 31.651814–43.393490 — and those are the grid's own
 * corners, to six decimals. A grid shifted by one cell misses them in the second.
 */

describe("a coordinate to a forecast cell", () => {
  test("서울 and 부산 city halls land where everybody's table says", () => {
    expect(kmaCellOf(37.5665, 126.978)).toEqual({ nx: 60, ny: 127 });
    expect(kmaCellOf(35.1796, 129.0756)).toEqual({ nx: 98, ny: 76 });
  });

  test("the projection's origin is cell (43, 136)", () => {
    expect(kmaCellOf(38, 126)).toEqual({ nx: 43, ny: 136 });
    const origin = kmaCellCentre({ nx: 43, ny: 136 });
    expect(origin.latitude).toBeCloseTo(38, 9);
    expect(origin.longitude).toBeCloseTo(126, 9);
  });

  test("the grid's corners are the ranges 기상청 publishes for its own converter", () => {
    const { columns, rows } = KMA_GRID;
    expect({ columns, rows }).toEqual({ columns: 149, rows: 253 });
    // The lowest latitude is the south-east corner: the east edge is the far one from 126°E.
    const southEast = kmaCellCentre({ nx: columns, ny: 1 });
    expect(southEast.latitude).toBeCloseTo(31.651814, 5);
    // The published top latitude and the lowest longitude are one corner, the north-west.
    const northWest = kmaCellCentre({ nx: 1, ny: rows });
    expect(northWest.latitude).toBeCloseTo(43.39349, 5);
    expect(northWest.longitude).toBeCloseTo(123.310165, 5);
    // 132.774963 published, 132.774969 here: a single-precision float on their side.
    const northEast = kmaCellCentre({ nx: columns, ny: rows });
    expect(Math.abs(northEast.longitude - 132.774963)).toBeLessThan(0.00002);
  });

  test("every cell's centre comes back as that cell", () => {
    // The two directions are written separately; this is what says they are one projection.
    for (let nx = 1; nx <= KMA_GRID.columns; nx += 4) {
      for (let ny = 1; ny <= KMA_GRID.rows; ny += 4) {
        const centre = kmaCellCentre({ nx, ny });
        expect(kmaCellOf(centre.latitude, centre.longitude)).toEqual({
          nx,
          ny,
        });
      }
    }
  });

  test("a place the grid does not reach is no cell at all", () => {
    // The vendor answers cell (150, 254) with zeros and resultCode 00, so this is the only refusal.
    expect(kmaCellOf(35.6762, 139.6503)).toBeNull(); // 도쿄
    expect(kmaCellOf(40.7128, -74.006)).toBeNull(); // 뉴욕
    expect(kmaCellOf(-33.8688, 151.2093)).toBeNull(); // 시드니
    expect(kmaCellOf(0, 0)).toBeNull();
    // Half a cell past each corner.
    const justInside = kmaCellCentre({ nx: 1, ny: 1 });
    expect(kmaCellOf(justInside.latitude, justInside.longitude)).toEqual({
      nx: 1,
      ny: 1,
    });
    expect(
      kmaCellOf(justInside.latitude - 0.1, justInside.longitude),
    ).toBeNull();
    expect(
      kmaCellOf(justInside.latitude, justInside.longitude - 0.1),
    ).toBeNull();
  });

  test("something that is not a coordinate is no cell", () => {
    expect(kmaCellOf(Number.NaN, 127)).toBeNull();
    expect(kmaCellOf(37.5, Number.POSITIVE_INFINITY)).toBeNull();
    expect(kmaCellOf(91, 127)).toBeNull();
    expect(kmaCellOf(37.5, 181)).toBeNull();
  });

  test("a cell is whole numbers inside 149 × 253", () => {
    expect(isKmaCell(1, 1)).toBe(true);
    expect(isKmaCell(149, 253)).toBe(true);
    expect(isKmaCell(0, 1)).toBe(false);
    expect(isKmaCell(150, 253)).toBe(false);
    expect(isKmaCell(149, 254)).toBe(false);
    expect(isKmaCell(60.5, 127)).toBe(false);
  });
});
