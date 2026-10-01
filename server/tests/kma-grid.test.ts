import { describe, expect, test } from "bun:test";
import {
  isKmaCell,
  KMA_GRID,
  kmaCellCentre,
  kmaCellOf,
  kmaGridPosition,
} from "../src/plugins/kma-grid";

/**
 * A coordinate to a cell of the 기상청 forecast grid, held to what 기상청 itself publishes.
 *
 * The projection's constants are eight numbers that circulate from one blog post to the next, and
 * a wrong one does not fail: it answers the weather of the next valley. So they are pinned to
 * three things that are 기상청's own. The two city halls are the pair every copy of the conversion
 * is checked against. The four corners are stronger: the API hub's page for its converter
 * (apihub.kma.go.kr, 예특보 2.4, read 2026-10-02) gives the ranges it accepts — x 1–149, y 1–253,
 * longitude 123.310165–132.774963, latitude 31.651814–43.393490 — and those are the grid's own
 * corners, to six decimals. A grid shifted by one cell misses them in the second.
 *
 * And the strongest is 기상청's spreadsheet of 읍·면·동 (동네예보지점좌표(위경도)_260701.xlsx),
 * where every row is a coordinate and the cell 기상청 put it in. The generator reports the whole
 * sheet — 3,793 of the 3,836 rows that carry a coordinate land in their own cell, 36 more are
 * within 500 m of its edge, 7 are further off — and a handful of those rows are pinned here.
 */

describe("a coordinate to a forecast cell", () => {
  test("서울 and 부산 city halls land where everybody's table says", () => {
    expect(kmaCellOf(37.5665, 126.978)).toEqual({ nx: 60, ny: 127 });
    expect(kmaCellOf(35.1796, 129.0756)).toEqual({ nx: 98, ny: 76 });
  });

  test("rows of 기상청's own sheet land in the cell the sheet gives them", () => {
    // (latitude, longitude) → (격자 X, 격자 Y), as the 2026-07-01 edition has them.
    const rows: [string, number, number, number, number][] = [
      ["서울특별시", 37.5635694444444, 126.980008333333, 60, 127],
      ["서울 종로구 청운효자동", 37.5841367, 126.9706519, 60, 127],
      ["세종특별자치시", 36.4800121, 127.2890691, 66, 103],
      ["경기도 수원시장안구", 37.3010111111111, 127.012222222222, 60, 121],
      ["인천광역시 제물포구", 37.4709333333333, 126.623566666666, 54, 125],
      ["전남광주통합특별시", 34.8130444444444, 126.465, 51, 67],
      ["전남광주통합특별시 순천시", 34.9476055555555, 127.489330555555, 70, 70],
      ["전남광주통합특별시 광산구", 35.1364277777777, 126.795788888888, 57, 74],
    ];
    for (const [name, latitude, longitude, nx, ny] of rows) {
      expect({ name, cell: kmaCellOf(latitude, longitude) }).toEqual({
        name,
        cell: { nx, ny },
      });
    }
  });

  test("a position is the cell before it is rounded", () => {
    expect(kmaGridPosition(38, 126)).toEqual({ x: 43, y: 136 });
    // 서울 시청 is a little west and south of its cell's centre.
    const cityHall = kmaGridPosition(37.5665, 126.978);
    expect(cityHall?.x).toBeCloseTo(59.808, 2);
    expect(cityHall?.y).toBeCloseTo(126.708, 2);
    // 수유1동, the sheet's closest call: two metres over the line into the next cell east.
    const suyu = kmaGridPosition(37.6307333333333, 127.019297222222);
    expect(suyu?.x).toBeGreaterThan(60.5);
    expect(suyu?.x).toBeLessThan(60.501);
    expect(kmaGridPosition(Number.NaN, 127)).toBeNull();
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
