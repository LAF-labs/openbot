/**
 * A place as somebody says it, to the forecast cell 기상청 files it under — and a cell back to a name.
 *
 * WHY A TABLE AND NOT A GEOCODER. The forecast is asked for by cell, and 기상청 publishes which
 * cell each 시·도, 시·군·구 and 읍·면·동 sits in. That table is the only name a weather answer can
 * honestly be given under: a geocoder would return a point, and the point's cell is not always the
 * cell 기상청 means by that district. So a name is looked up in 기상청's own rows or it is not found.
 *
 * WHAT PEOPLE ACTUALLY SAY. Nobody types "서울특별시 종로구 청운효자동". They say 서울 종로, 춘천,
 * 해운대, 분당, 역삼동 — the short name of a 시·도, a district without its 시·군·구, a 동 without its
 * number — and they leave the spaces wherever they fall. So a query is read with its spaces taken
 * out, as the name of ONE row's last level, optionally led by that row's parents in order, each in
 * any spelling this file knows for it. "서울종로" is 서울 + 종로(구); "경기 광주" is 경기(도) + 광주(시)
 * and cannot be 광주광역시, which has no parent called 경기.
 *
 * THE COARSEST ROW WINS, AND A TIE IS SAID RATHER THAN BROKEN. 광주 alone is 광주광역시 before it
 * is 경기도 광주시; 양평 is the 군 before it is 영등포구 양평동; 제주 is the 도. But 중구 is six
 * districts in six cities and 고성 is a 군 in 강원 and another in 경남, three hundred kilometres
 * apart — picking one would be an answer about the wrong sea. Those come back `ambiguous`, and the
 * caller tells the Bot to name the 시·도.
 *
 * Rows that are the same place for a forecast are not a tie: 역삼동 is 역삼1동 and 역삼2동, one
 * cell apart. Anything within two cells of each other (ten kilometres) is answered with the first.
 *
 * THE OTHER DIRECTION is for honesty about coordinates. A latitude and longitude come from a
 * device or from a model that may have invented them; naming the 시·군·구 whose 동 sit in that
 * cell lets the Bot say "서울 종로구 기준" — or notice that the numbers it sent are 과천.
 */
import { isKmaCell, type KmaCell } from "./kma-grid";
import { KMA_PLACES_TABLE } from "./kma-places-table";

/** One row of the table: the names from the 시·도 down to where the row stops, and its cell. */
export type KmaPlace = { levels: readonly string[]; nx: number; ny: number };

export type KmaPlaceAnswer =
  | { kind: "found"; name: string; cell: KmaCell }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "unknown" };

export type KmaPlaces = {
  /** How many of 기상청's rows this was built from. Zero is "no table": offer no `place`. */
  size: number;
  find(query: string): KmaPlaceAnswer;
  /** What to call a cell: the districts whose 동 sit in it, or the nearest row and "부근". */
  nameOf(cell: KmaCell): string | null;
};

/**
 * 기상청 writes a district of a city as one word: 수원시장안구, 성남시분당구, 고양시일산동구. People
 * say 수원 or 분당 or 수원 장안구, so the word is taken apart into the city and its district.
 * Lazy on the city so 고양시일산동구 is 고양시 + 일산동구.
 */
const CITY_WITH_DISTRICT = /^(.+?시)\s*(.+구)$/;

/** The table's rows, from the generated module's lines. A line that is not a row is skipped. */
export function parseKmaPlaces(table: string): KmaPlace[] {
  const places: KmaPlace[] = [];
  for (const line of table.split("\n")) {
    const [first = "", second = "", third = "", x = "", y = ""] =
      line.split("|");
    const nx = Number(x);
    const ny = Number(y);
    if (!first.trim() || !x.trim() || !isKmaCell(nx, ny)) continue;
    places.push({ levels: levelsOf(first, second, third), nx, ny });
  }
  return places;
}

function levelsOf(first: string, second: string, third: string): string[] {
  const levels = [first.trim()];
  const middle = second.trim();
  const city = CITY_WITH_DISTRICT.exec(middle);
  if (city?.[1] && city[2]) levels.push(city[1], city[2]);
  else if (middle) levels.push(middle);
  if (third.trim()) levels.push(third.trim());
  // 세종 is written 세종특별자치시 | 세종특별자치시 | 조치원읍: the same name twice is one level.
  return levels.filter(
    (name, index) => index === 0 || name !== levels[index - 1],
  );
}

/**
 * What a 시·도 is called, beside its full name.
 *
 * Both names of the three that were renamed (강원 2023, 전북 2024) are here, because which one the
 * spreadsheet carries depends on its date and a person may say either. 광주시 is deliberately not
 * an alias of 광주광역시: it is the exact name of a city in 경기도, and that is what it finds.
 */
const SIDO_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze(
  {
    서울특별시: ["서울", "서울시"],
    부산광역시: ["부산", "부산시"],
    대구광역시: ["대구", "대구시"],
    인천광역시: ["인천", "인천시"],
    광주광역시: ["광주"],
    대전광역시: ["대전", "대전시"],
    울산광역시: ["울산", "울산시"],
    세종특별자치시: ["세종", "세종시"],
    경기도: ["경기"],
    강원특별자치도: ["강원", "강원도"],
    강원도: ["강원", "강원특별자치도"],
    충청북도: ["충북"],
    충청남도: ["충남"],
    전북특별자치도: ["전북", "전라북도"],
    전라북도: ["전북", "전북특별자치도"],
    전라남도: ["전남"],
    경상북도: ["경북"],
    경상남도: ["경남"],
    제주특별자치도: ["제주", "제주도"],
  },
);

/** What an administrative name ends in, below a 시·도. */
const LOWER_SUFFIX = /(시|군|구|읍|면|동)$/;

/**
 * The spellings of a 시·군·구 or 읍·면·동: as written, without its number, without its suffix.
 *
 * A stem shorter than two characters is not a spelling. 중구 without 구 is 중, and "부산 중" is
 * nothing anybody says — but it would be the tail of every query that ends in 중.
 */
function lowerSpellings(name: string): string[] {
  const spellings = new Set([name]);
  const unnumbered = name.replace(/제?\d+/g, "").replace(/[.·]/g, "");
  if ([...unnumbered].length >= 2) spellings.add(unnumbered);
  for (const spelling of [...spellings]) {
    const stem = spelling.replace(LOWER_SUFFIX, "");
    if (stem !== spelling && [...stem].length >= 2) spellings.add(stem);
  }
  return [...spellings];
}

/** A query with nothing in it but the names: spaces and commas are where people put them. */
const squeeze = (text: string) => text.normalize("NFC").replace(/[\s,]+/g, "");

/** Rows this close to each other are one place for a forecast: two cells is ten kilometres. */
const SAME_PLACE_CELLS = 2;
/** How far a cell may be from the nearest row and still be called "부근": thirty kilometres. */
const NEAR_CELLS = 6;
/** The most candidates a tie names. More than this is a 동 name half the country has. */
const MAX_CANDIDATES = 8;

type Entry = {
  levels: readonly string[];
  /** One list of spellings per level, the 시·도 first. */
  spellings: readonly (readonly string[])[];
  nx: number;
  ny: number;
  /** A city this file put together from its districts, which 기상청 has no row for. */
  made: boolean;
};

const display = (levels: readonly string[]) => levels.join(" ");

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)] ?? 0;

export function createKmaPlaces(rows: readonly KmaPlace[]): KmaPlaces {
  const spellingsBy = new Map<string, readonly string[]>();
  const spellingsOf = (name: string, isSido: boolean) => {
    const key = `${isSido ? "1" : "2"}${name}`;
    let known = spellingsBy.get(key);
    if (!known) {
      known = isSido
        ? [name, ...(SIDO_ALIASES[name] ?? [])]
        : lowerSpellings(name);
      spellingsBy.set(key, known);
    }
    return known;
  };
  const entryOf = (
    levels: readonly string[],
    nx: number,
    ny: number,
    made: boolean,
  ): Entry => ({
    levels,
    spellings: levels.map((name, index) => spellingsOf(name, index === 0)),
    nx,
    ny,
    made,
  });

  const entries: Entry[] = rows.map((row) =>
    entryOf(row.levels, row.nx, row.ny, false),
  );

  /*
   * A CITY LISTED ONLY BY ITS DISTRICTS IS STILL A CITY. Where the table has 수원시장안구,
   * 수원시권선구, 수원시팔달구 and 수원시영통구 and no row called 수원시, "수원" would find nothing in a
   * table that holds all of 수원. So a city with district rows and no row of its own is put
   * together here: the cell in the middle of its districts' own, under the city's name. Never when
   * 기상청 has the row — this was written before the spreadsheet was on this machine, and whichever
   * way it lists a city, the city is found once.
   */
  const paths = new Set(entries.map((entry) => display(entry.levels)));
  const districtsBy = new Map<string, Entry[]>();
  for (const entry of entries) {
    const [, cityName, district] = entry.levels;
    if (entry.levels.length !== 3) continue;
    if (!cityName?.endsWith("시") || !district?.endsWith("구")) continue;
    const city = display(entry.levels.slice(0, 2));
    districtsBy.set(city, [...(districtsBy.get(city) ?? []), entry]);
  }
  for (const [city, districts] of districtsBy) {
    if (paths.has(city)) continue;
    const [first] = districts;
    if (!first) continue;
    entries.push(
      entryOf(
        first.levels.slice(0, 2),
        median(districts.map((district) => district.nx)),
        median(districts.map((district) => district.ny)),
        true,
      ),
    );
  }

  /** Every spelling of every row's LAST level, to the rows that end in it. */
  const byLast = new Map<string, Entry[]>();
  for (const entry of entries) {
    for (const spelling of entry.spellings[entry.levels.length - 1] ?? []) {
      byLast.set(spelling, [...(byLast.get(spelling) ?? []), entry]);
    }
  }

  const cellKey = (cell: KmaCell) => `${cell.nx},${cell.ny}`;
  const byCell = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (entry.made) continue;
    const key = cellKey(entry);
    byCell.set(key, [...(byCell.get(key) ?? []), entry]);
  }

  /** Whether `head` is this row's parents, in order, each in some spelling, any of them left out. */
  function leads(head: string, entry: Entry, from: number): boolean {
    if (head === "") return true;
    for (let level = from; level < entry.levels.length - 1; level++) {
      for (const spelling of entry.spellings[level] ?? []) {
        if (
          head.startsWith(spelling) &&
          leads(head.slice(spelling.length), entry, level + 1)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /** The rows a query names, by one way of reading its last word. */
  function matching(
    asked: string,
    endingIn: (tail: string) => readonly Entry[],
  ): Entry[] {
    const hits = new Set<Entry>();
    for (let start = 0; start <= asked.length - 2; start++) {
      const head = asked.slice(0, start);
      for (const entry of endingIn(asked.slice(start))) {
        if (leads(head, entry, 0)) hits.add(entry);
      }
    }
    return [...hits];
  }

  /*
   * The last word as the table spells it — or as an island is called. 울릉도, 거제도, 강화도 and
   * 여의도 are how people name 울릉군, 거제시, 강화군 and 여의동, so a trailing 도 is tried without.
   */
  const spelled = (tail: string): readonly Entry[] => [
    ...(byLast.get(tail) ?? []),
    ...([...tail].length >= 3 && tail.endsWith("도")
      ? (byLast.get(tail.slice(0, -1)) ?? [])
      : []),
  ];
  /*
   * And, only when nothing is spelled that way, the last word as the START of a name: 일산 is
   * 일산동구 and 일산서구, 마산 is 마산합포구 and 마산회원구, and neither is anywhere as itself.
   */
  const starting = (tail: string): readonly Entry[] =>
    [...tail].length < 2
      ? []
      : entries.filter((entry) =>
          entry.levels[entry.levels.length - 1]?.startsWith(tail),
        );

  function nameOf(cell: KmaCell): string | null {
    const here = (byCell.get(cellKey(cell)) ?? []).filter(
      (entry) => entry.levels.length >= 2,
    );
    if (here.length > 0) {
      const depth = Math.max(...here.map((entry) => entry.levels.length));
      // A 동 is named by its district: the cell is five kilometres and holds a dozen of them.
      const count = new Map<string, number>();
      for (const entry of here) {
        if (entry.levels.length !== depth) continue;
        const named = display(
          depth >= 3 ? entry.levels.slice(0, -1) : entry.levels,
        );
        count.set(named, (count.get(named) ?? 0) + 1);
      }
      const names = [...count.entries()]
        .sort(([, a], [, b]) => b - a)
        .map(([name]) => name);
      const [first = "", second] = names;
      const more = names.length > 2 ? " 등" : "";
      if (!second) return first;
      // 서울특별시 종로구·중구, not the 시·도 written twice.
      const sido = `${first.split(" ")[0]} `;
      return second.startsWith(sido)
        ? `${first}·${second.slice(sido.length)}${more}`
        : `${first}, ${second}${more}`;
    }
    let nearest: Entry | null = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const entry of entries) {
      if (entry.made || entry.levels.length < 2) continue;
      const apart = (entry.nx - cell.nx) ** 2 + (entry.ny - cell.ny) ** 2;
      if (apart < distance) {
        nearest = entry;
        distance = apart;
      }
    }
    return nearest && distance <= NEAR_CELLS ** 2
      ? `${display(nearest.levels)} 부근`
      : null;
  }

  /**
   * What a found row is called in the answer.
   *
   * A 도 is one cell — where 기상청 put its row, which is the provincial office — and 강원 is not
   * one weather. So a province is named with the place its cell actually is.
   */
  function nameFor(entry: Entry): string {
    const [sido = ""] = entry.levels;
    if (entry.levels.length > 1 || !sido.endsWith("도")) {
      return display(entry.levels);
    }
    const where = nameOf(entry);
    if (!where) return sido;
    const within = where.startsWith(`${sido} `)
      ? where.slice(sido.length + 1)
      : where;
    return `${sido}(대표 지점: ${within})`;
  }

  return {
    size: rows.length,
    nameOf,
    find(query) {
      const asked = squeeze(query);
      if ([...asked].length < 2) return { kind: "unknown" };
      let hits = matching(asked, spelled);
      if (hits.length === 0) hits = matching(asked, starting);
      if (hits.length === 0) return { kind: "unknown" };

      const coarsest = Math.min(...hits.map((entry) => entry.levels.length));
      const candidates = hits.filter(
        (entry) => entry.levels.length === coarsest,
      );
      const [first] = candidates;
      if (!first) return { kind: "unknown" };
      const spread = (pick: (entry: Entry) => number) =>
        Math.max(...candidates.map(pick)) - Math.min(...candidates.map(pick));
      if (
        candidates.length === 1 ||
        (spread((entry) => entry.nx) <= SAME_PLACE_CELLS &&
          spread((entry) => entry.ny) <= SAME_PLACE_CELLS)
      ) {
        return {
          kind: "found",
          name: nameFor(first),
          cell: { nx: first.nx, ny: first.ny },
        };
      }
      return {
        kind: "ambiguous",
        candidates: candidates
          .slice(0, MAX_CANDIDATES)
          .map((entry) => display(entry.levels)),
      };
    },
  };
}

/** The table this deployment ships. No rows until the generator has run. */
export const KMA_PLACES: KmaPlaces = createKmaPlaces(
  parseKmaPlaces(KMA_PLACES_TABLE),
);
