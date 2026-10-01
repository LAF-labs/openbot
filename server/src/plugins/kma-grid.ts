/**
 * Latitude and longitude to a cell of the 기상청 forecast grid (동네예보 격자), and back.
 *
 * WHY THIS IS ARITHMETIC AND NOT A CALL. Every 동네예보 operation takes a cell, `nx` and `ny`, and
 * never a coordinate or a name. The API hub has a converter of its own (`nph-dfs_xy_lonlat`), which
 * the fleet's key has not been applied for (403 "활용신청이 필요한 API", measured 2026-10-02) and
 * which would be a round trip in front of every weather question for a sum this short. The
 * projection is a Lambert conformal conic with two standard parallels, and its constants are the
 * ones 기상청 publishes with the service.
 *
 * THE CONSTANTS WERE CHECKED AGAINST 기상청, NOT AGAINST THE BRIEF. The hub's page for that
 * converter (apihub.kma.go.kr, 예특보 2.4) states what it accepts: x 1–149, y 1–253, longitude
 * 123.310165–132.774963, latitude 31.651814–43.393490. Those four numbers are the corners of the
 * grid, and this projection reproduces them: cell (149, 1) is latitude 31.651814; cell (1, 253) is
 * latitude 43.393489 and longitude 123.310166; cell (149, 253) is longitude 132.774969. The last
 * digits differ by what a single-precision float on their side costs, and a grid moved by one cell
 * would differ in the second decimal. `tests/kma-grid.test.ts` holds the corners and the two city
 * halls everybody quotes (서울 60/127, 부산 98/76).
 *
 * A CELL OUTSIDE THE GRID IS REFUSED HERE, BECAUSE THE VENDOR DOES NOT. Measured the same day: cell
 * (150, 254) answered `resultCode 00` with a temperature, a humidity and a rainfall of exactly 0 —
 * a place that does not exist, answered as a mild dry night. So `kmaCellOf` returns null for
 * anything outside 1–149 × 1–253 and a caller never gets a cell it should not ask about.
 */

/** Earth's radius in km, as 기상청 rounds it. */
const EARTH_RADIUS_KM = 6371.00877;
/** One cell is five kilometres on a side. */
const CELL_KM = 5.0;
/** The two standard parallels, in degrees north. */
const STANDARD_PARALLEL_1 = 30.0;
const STANDARD_PARALLEL_2 = 60.0;
/** The origin of the projection: 126°E 38°N … */
const ORIGIN_LONGITUDE = 126.0;
const ORIGIN_LATITUDE = 38.0;
/**
 * … which is cell (43, 136). 기상청's own sample code says 210 km and 675 km from the grid's corner
 * (42 and 135 cells) and adds 1.5 before truncating; this is the same thing with the one folded in.
 */
const ORIGIN_X = 43;
const ORIGIN_Y = 136;

/** 동서 149 × 남북 253: "총 37,697개", in the hub's own description of the grid. */
export const KMA_GRID = Object.freeze({ columns: 149, rows: 253 });

export type KmaCell = { nx: number; ny: number };

const RADIANS = Math.PI / 180;
const QUARTER_TURN = Math.PI * 0.25;

/* The projection's three derived numbers. Worked out once: they depend on nothing but the above. */
const radiusInCells = EARTH_RADIUS_KM / CELL_KM;
const parallel1 = STANDARD_PARALLEL_1 * RADIANS;
const parallel2 = STANDARD_PARALLEL_2 * RADIANS;
/** The cone constant: how much a degree of longitude is squeezed. */
const cone =
  Math.log(Math.cos(parallel1) / Math.cos(parallel2)) /
  Math.log(
    Math.tan(QUARTER_TURN + parallel2 * 0.5) /
      Math.tan(QUARTER_TURN + parallel1 * 0.5),
  );
const scale =
  (Math.tan(QUARTER_TURN + parallel1 * 0.5) ** cone * Math.cos(parallel1)) /
  cone;
/** Distance, in cells, from the pole's projection to a latitude. */
const distanceFromPole = (latitudeRadians: number) =>
  (radiusInCells * scale) /
  Math.tan(QUARTER_TURN + latitudeRadians * 0.5) ** cone;
const originDistance = distanceFromPole(ORIGIN_LATITUDE * RADIANS);

/** Whether a pair of numbers names a cell the forecast actually covers. */
export function isKmaCell(nx: number, ny: number): boolean {
  return (
    Number.isInteger(nx) &&
    Number.isInteger(ny) &&
    nx >= 1 &&
    nx <= KMA_GRID.columns &&
    ny >= 1 &&
    ny <= KMA_GRID.rows
  );
}

/**
 * The cell a coordinate falls in, or null when it is not a coordinate or the grid does not reach it.
 *
 * Rounded to the nearest cell centre (`floor(x + 0.5)`), which is what 기상청's sample does and what
 * its own table of 읍·면·동 was made with.
 */
export function kmaCellOf(latitude: number, longitude: number): KmaCell | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  // Past the pole the tangent turns over and the answer is a cell on the wrong side of the world.
  if (Math.abs(latitude) >= 90 || Math.abs(longitude) > 180) return null;

  const distance = distanceFromPole(latitude * RADIANS);
  let angle = (longitude - ORIGIN_LONGITUDE) * RADIANS;
  if (angle > Math.PI) angle -= 2 * Math.PI;
  if (angle < -Math.PI) angle += 2 * Math.PI;
  angle *= cone;

  const nx = Math.floor(distance * Math.sin(angle) + ORIGIN_X + 0.5);
  const ny = Math.floor(
    originDistance - distance * Math.cos(angle) + ORIGIN_Y + 0.5,
  );
  return isKmaCell(nx, ny) ? { nx, ny } : null;
}

/**
 * The coordinate at the centre of a cell — the projection run backwards.
 *
 * Nothing at run time asks for this. It exists so the constants can be held to the corner
 * coordinates 기상청 publishes, and so the table generator can say how many of 기상청's own rows the
 * forward direction agrees with.
 */
export function kmaCellCentre(cell: KmaCell): {
  latitude: number;
  longitude: number;
} {
  const east = cell.nx - ORIGIN_X;
  const north = originDistance - cell.ny + ORIGIN_Y;
  const distance = Math.sqrt(east * east + north * north);
  const latitude =
    2 * Math.atan(((radiusInCells * scale) / distance) ** (1 / cone)) -
    Math.PI * 0.5;
  const angle = east === 0 ? 0 : Math.atan2(east, north);
  return {
    latitude: latitude / RADIANS,
    longitude: angle / cone / RADIANS + ORIGIN_LONGITUDE,
  };
}
