/**
 * 기상청's table of 시·도, 시·군·구 and 읍·면·동 with the forecast cell each one sits in.
 *
 * EMPTY UNTIL THE GENERATOR HAS RUN, AND THE TOOL KNOWS IT. The rows come from one spreadsheet
 * 기상청 publishes beside the 동네예보 service ("동네예보 지점 좌표(위경도)", on apihub.kma.go.kr
 * under 예특보 → 4), and fetching a file onto this machine is the owner's decision, not a build
 * step's. So this module ships with no rows and `kma-weather-rest.ts` offers no `place` argument
 * while it has none — a name the tool cannot look up is not an argument it should advertise.
 *
 * To fill it, with the spreadsheet on disk:
 *
 *   bun server/scripts/kma-places-table.ts "<path>/동네예보지점좌표(위경도)_YYMMDD.xlsx"
 *
 * which rewrites this file whole: one row per line, `시도|시군구|읍면동|nx|ny`, nothing else of the
 * spreadsheet kept. `server/tests/kma-places.test.ts` then runs its second half against the rows.
 */

/** The spreadsheet these rows were read from, or null while there are none. */
export const KMA_PLACES_SOURCE: string | null = null;

export const KMA_PLACES_TABLE = "";
