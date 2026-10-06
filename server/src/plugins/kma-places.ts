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
 * and cannot be the other 광주, which has no parent called 경기.
 *
 * THE COARSEST ROW WINS, AND A TIE IS SAID RATHER THAN BROKEN. 양평 is the 군 before it is
 * 영등포구 양평동; 제주 is the 도 before it is 제주시. But 중구 is a district of five cities and 고성
 * is a 군 in 강원 and another in 경남, three hundred kilometres apart — picking one would be an
 * answer about the wrong sea. Those come back `ambiguous`, and the caller tells the Bot to name the
 * 시·도.
 *
 * Rows that are the same place for a forecast are not a tie: 역삼동 is 역삼1동 and 역삼2동, one
 * cell apart. Anything within two cells of each other (ten kilometres) is answered with the first.
 *
 * THE TABLE CHANGES UNDER THE NAMES PEOPLE KEEP. The edition of 2026-07-01 has no 광주광역시 and
 * no 전라남도: there is one 전남광주통합특별시, its row sits in 무안, and 광주's five districts are
 * 동구, 서구, 남구, 북구 and 광산구 directly under it, with nothing called 광주 at all. Read as
 * written, "광주" found 경기도 광주시 and "전남 순천" found nothing — measured on the real rows, the
 * first time they were on this machine. So the names a 시·도 used to have still lead to its rows
 * (`SIDO_NAMES`), and a city that stopped being a 시·도 is still a city (`CITIES_WITHIN`).
 *
 * THE OTHER DIRECTION is for honesty about coordinates. A latitude and longitude come from a
 * device or from a model that may have invented them; naming the 시·군·구 whose 동 sit in that
 * cell lets the Bot say "서울 종로구 기준" — or notice that the numbers it sent are 과천.
 */
import { isKmaCell, type KmaCell } from "./kma-grid";
import { KMA_PLACES_TABLE } from "./kma-places-table";

/**
 * One row of the table: the names from the 시·도 down to where the row stops, and its cell.
 *
 * `column` is which of the sheet's three name columns the row ends in — 1 a 시·도, 2 a 시·군·구,
 * 3 an 읍·면·동 — and it is NOT how many names there are. 수원시장안구 is one cell of column 2 and
 * two names; 세종's 조치원읍 is column 3 under a 2단계 that repeats the 시·도, and one name fewer.
 * How coarse a place is, to somebody saying its name, is the column.
 */
export type KmaPlace = {
  levels: readonly string[];
  column: 1 | 2 | 3;
  nx: number;
  ny: number;
  /** Where 기상청 puts the row, in decimal degrees. Absent from a table written before 2026-10-06. */
  latitude?: number;
  longitude?: number;
};

export type KmaPlaceAnswer =
  | {
      kind: "found";
      name: string;
      cell: KmaCell;
      /** The row's names, the 시·도 first — what else is filed under them (`kma-mid-regions.ts`). */
      levels: readonly string[];
    }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "unknown" };

export type KmaPlaces = {
  /** How many of 기상청's rows this was built from. Zero is "no table": offer no `place`. */
  size: number;
  find(query: string): KmaPlaceAnswer;
  /** What to call a cell: the districts whose 동 sit in it, or the nearest row and "부근". */
  nameOf(cell: KmaCell): string | null;
  /**
   * What to call a point: the districts of the rows nearest it that have a coordinate of their own
   * — one name inside a district, both sides on a border. Null when the table carries no
   * coordinates, or none is near: the cell's name is the answer then.
   */
  nameAt(point: { latitude: number; longitude: number }): string | null;
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
    const [
      first = "",
      second = "",
      third = "",
      x = "",
      y = "",
      north = "",
      east = "",
    ] = line.split("|");
    const nx = Number(x);
    const ny = Number(y);
    if (!first.trim() || !x.trim() || !isKmaCell(nx, ny)) continue;
    // Both or neither: half a coordinate is not somewhere.
    const latitude = north.trim() ? Number(north) : Number.NaN;
    const longitude = east.trim() ? Number(east) : Number.NaN;
    const isSomewhere = Number.isFinite(latitude) && Number.isFinite(longitude);
    places.push({
      levels: levelsOf(first, second, third),
      column: third.trim() ? 3 : second.trim() ? 2 : 1,
      nx,
      ny,
      ...(isSomewhere ? { latitude, longitude } : {}),
    });
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
 * What a 시·도 is called, beside the name the table gives it.
 *
 * `also` are names for the 시·도 itself. Both names of the ones that were renamed (강원 2023, 전북
 * 2024) are here, since which one the spreadsheet carries depends on its date and a person may say
 * either; 광주광역시 and 전라남도 are kept for an edition from before their merger.
 *
 * `leading` are names that only ever come IN FRONT of something: "광주 북구" is a district of the
 * merged 시·도, so 광주 has to lead to its rows — but 광주 on its own is not the merged 시·도, whose
 * one cell is 무안, a hundred kilometres from anybody who says 광주. That is `CITIES_WITHIN`'s.
 *
 * 광주시 is nobody's alias: it is the exact name of a city in 경기도, and that is what it finds.
 */
const SIDO_NAMES: Readonly<
  Record<string, { also: readonly string[]; leading?: readonly string[] }>
> = Object.freeze({
  서울특별시: { also: ["서울", "서울시"] },
  부산광역시: { also: ["부산", "부산시"] },
  대구광역시: { also: ["대구", "대구시"] },
  인천광역시: { also: ["인천", "인천시"] },
  광주광역시: { also: ["광주"] },
  대전광역시: { also: ["대전", "대전시"] },
  울산광역시: { also: ["울산", "울산시"] },
  세종특별자치시: { also: ["세종", "세종시"] },
  경기도: { also: ["경기"] },
  강원특별자치도: { also: ["강원", "강원도"] },
  강원도: { also: ["강원", "강원특별자치도"] },
  충청북도: { also: ["충북"] },
  충청남도: { also: ["충남"] },
  전북특별자치도: { also: ["전북", "전라북도"] },
  전라북도: { also: ["전북", "전북특별자치도"] },
  전라남도: { also: ["전남"] },
  전남광주통합특별시: {
    // Not "전남광주": with the spaces out, "전남 광주" is that too, and it means the city.
    also: ["전남", "전라남도"],
    leading: ["광주", "광주광역시"],
  },
  경상북도: { also: ["경북"] },
  경상남도: { also: ["경남"] },
  제주특별자치도: { also: ["제주", "제주도"] },
});

/**
 * A city that stopped being a 시·도 and is still what people say.
 *
 * 광주 has no row in the merged 시·도: its five districts stand directly under 전남광주통합특별시
 * beside 순천시 and 무안군. So the city is put together from them — the cell in the middle of their
 * own, which on the 2026-07 rows is 서구's — and it ranks where it used to, as a 시·도: said
 * alone, 광주 is this before it is 경기도 광주시, exactly as it was when the table had 광주광역시.
 * Only when the districts are there and the table has no such row itself.
 */
const CITIES_WITHIN: readonly {
  sido: string;
  name: string;
  also: readonly string[];
  districts: readonly string[];
}[] = [
  {
    sido: "전남광주통합특별시",
    name: "광주",
    also: ["광주광역시"],
    districts: ["동구", "서구", "남구", "북구", "광산구"],
  },
];

/**
 * A 시·도 that is one city, and so one weather. Every other — a 도, and a merged 시·도 whatever its
 * name ends in — is a province: its row is one cell and its name is not an answer on its own.
 */
const CITY_SIDO = /^(?!.*통합).*(특별시|광역시|특별자치시)$/;

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
/**
 * How far a point may be from the nearest row's own coordinate and still be named by it. A 면 in
 * the mountains is wider than a city's 구, and a device's place arrives rounded to a kilometre;
 * past this the point is at sea or abroad, and the cell's name ("… 부근", or none) is the honest one.
 */
const NEAR_KM = 12;
/** One degree of latitude, in kilometres. Near enough for telling one 동 from the next. */
const KM_PER_DEGREE = 111;
/**
 * How far the point a device is kept as may be from where the device is: two decimals of a degree
 * are 1.1 km north to south and 0.9 km east to west here, so up to 0.7 km from corner to centre.
 */
const ROUNDING_KM = 0.75;

type Entry = {
  levels: readonly string[];
  /** What the row itself may be called: every spelling of its last level. */
  own: readonly string[];
  /** What each level may be called when it stands in front of a deeper one, the 시·도 first. */
  leading: readonly (readonly string[])[];
  nx: number;
  ny: number;
  /** A city this file put together from its districts, which 기상청 has no row for. */
  made: boolean;
  /** The row's own coordinate, when the table carries one. A city put together here has none. */
  at?: { latitude: number; longitude: number };
  /**
   * How coarse a place this is to somebody saying its name: 1 a 시·도, 2 a 시·군·구, 3 an 읍·면·동.
   * The sheet's column for a row of 기상청's; 2 for a city put together here; and 1 for a city that
   * used to be a 시·도 and is still said like one.
   */
  rank: number;
};

const display = (levels: readonly string[]) => levels.join(" ");

/** A district of a city: one cell of the sheet's second column that is two names, 수원시 + 장안구. */
const isCityDistrict = (entry: Entry) =>
  entry.rank === 2 && entry.levels.length === 3;

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)] ?? 0;

/** Two names said as one: 서울특별시 종로구·중구, not the part they share written twice. */
function together(first: string, second: string): string {
  const one = first.split(" ");
  const two = second.split(" ");
  let shared = 0;
  while (
    shared < one.length - 1 &&
    shared < two.length - 1 &&
    one[shared] === two[shared]
  ) {
    shared++;
  }
  return shared === 0
    ? `${first}, ${second}`
    : `${first}·${two.slice(shared).join(" ")}`;
}

export function createKmaPlaces(rows: readonly KmaPlace[]): KmaPlaces {
  const ownOf = (name: string, isSido: boolean): readonly string[] =>
    isSido ? [name, ...(SIDO_NAMES[name]?.also ?? [])] : lowerSpellings(name);
  const leadingOf = (name: string, isSido: boolean): readonly string[] =>
    isSido
      ? [...ownOf(name, true), ...(SIDO_NAMES[name]?.leading ?? [])]
      : lowerSpellings(name);
  const leadingFor = (levels: readonly string[]) =>
    levels.map((name, index) => leadingOf(name, index === 0));
  const entryOf = (
    levels: readonly string[],
    cell: KmaCell,
    rank: number,
    extra: {
      made?: boolean;
      own?: readonly string[];
      at?: { latitude: number; longitude: number };
    } = {},
  ): Entry => ({
    levels,
    own:
      extra.own ?? ownOf(levels[levels.length - 1] ?? "", levels.length === 1),
    leading: leadingFor(levels),
    nx: cell.nx,
    ny: cell.ny,
    made: extra.made ?? false,
    ...(extra.at ? { at: extra.at } : {}),
    rank,
  });

  const entries: Entry[] = rows.map((row) =>
    entryOf(
      row.levels,
      row,
      row.column,
      row.latitude !== undefined && row.longitude !== undefined
        ? { at: { latitude: row.latitude, longitude: row.longitude } }
        : {},
    ),
  );
  const paths = new Set(entries.map((entry) => display(entry.levels)));
  const inTheMiddleOf = (districts: readonly Entry[]): KmaCell => ({
    nx: median(districts.map((district) => district.nx)),
    ny: median(districts.map((district) => district.ny)),
  });

  /*
   * A CITY LISTED ONLY BY ITS DISTRICTS IS STILL A CITY. The table has 수원시장안구, 수원시권선구,
   * 수원시팔달구 and 수원시영통구 and no row called 수원시 — thirteen cities are written that way in
   * the 2026-07 edition and none of them has a row of its own — so "수원" would find nothing in a
   * table that holds all of 수원. A city with district rows and no row of its own is put together
   * here: the cell in the middle of its districts' own, under the city's name. Never when 기상청
   * has the row.
   */
  const districtsBy = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (!isCityDistrict(entry)) continue;
    const city = display(entry.levels.slice(0, 2));
    districtsBy.set(city, [...(districtsBy.get(city) ?? []), entry]);
  }
  for (const [city, districts] of districtsBy) {
    const [first] = districts;
    if (!first || paths.has(city)) continue;
    entries.push(
      entryOf(first.levels.slice(0, 2), inTheMiddleOf(districts), 2, {
        made: true,
      }),
    );
  }
  for (const city of CITIES_WITHIN) {
    const districts = entries.filter(
      (entry) =>
        !entry.made &&
        entry.levels.length === 2 &&
        entry.levels[0] === city.sido &&
        city.districts.includes(entry.levels[1] ?? ""),
    );
    if (districts.length === 0 || paths.has(`${city.sido} ${city.name}`)) {
      continue;
    }
    entries.push(
      entryOf([city.sido, city.name], inTheMiddleOf(districts), 1, {
        made: true,
        own: [city.name, ...city.also],
      }),
    );
  }

  /** Every spelling of every row's own name, to the rows that go by it. */
  const byOwn = new Map<string, Entry[]>();
  for (const entry of entries) {
    for (const spelling of entry.own) {
      byOwn.set(spelling, [...(byOwn.get(spelling) ?? []), entry]);
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
      for (const spelling of entry.leading[level] ?? []) {
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
    ...(byOwn.get(tail) ?? []),
    ...([...tail].length >= 3 && tail.endsWith("도")
      ? (byOwn.get(tail.slice(0, -1)) ?? [])
      : []),
  ];
  /*
   * And the last word as the START of a city's district: 일산 is 일산동구 and 일산서구, 마산 is
   * 마산합포구 and 마산회원구 — the towns those districts were made from, which are nowhere in the
   * table as themselves.
   *
   * ONLY A CITY'S DISTRICTS, AND BESIDE THE EXACT SPELLINGS RATHER THAN AFTER THEM. Run on the real
   * rows as a fallback, "일산" never reached this: 울산 and 원주 each have an 일산동, so it came
   * back as a tie between two neighbourhoods that are not the 일산 anybody means. Read together
   * the district outranks the 동. And a prefix of anything else is a guess: 남양 is not 남양주시.
   */
  const districtStarting = (tail: string): readonly Entry[] =>
    [...tail].length < 2
      ? []
      : entries.filter(
          (entry) =>
            isCityDistrict(entry) &&
            entry.levels[entry.levels.length - 1]?.startsWith(tail),
        );
  const called = (tail: string): readonly Entry[] => [
    ...spelled(tail),
    ...districtStarting(tail),
  ];

  /**
   * The district a row is in, which is what a cell is named by: a 동 by its 구, 세종's 동 by 세종
   * (they stand directly under it), a 시·군·구 by itself.
   */
  const districtOf = (entry: Entry) =>
    display(entry.rank === 3 ? entry.levels.slice(0, -1) : entry.levels);

  function nameOf(cell: KmaCell): string | null {
    const here = (byCell.get(cellKey(cell)) ?? []).filter(
      (entry) => entry.levels.length >= 2,
    );
    if (here.length > 0) {
      // The cell is five kilometres and holds a dozen 동; the districts they are in, commonest first.
      const count = new Map<string, number>();
      for (const entry of here) {
        const district = districtOf(entry);
        count.set(district, (count.get(district) ?? 0) + 1);
      }
      const [first = "", second, third] = [...count.entries()]
        .sort(([, a], [, b]) => b - a)
        .map(([name]) => name);
      if (!second) return first;
      return `${together(first, second)}${third ? " 등" : ""}`;
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
      ? `${districtOf(nearest)} 부근`
      : null;
  }

  /*
   * A POINT IS NAMED BY THE NEAREST 동, NOT BY ITS CELL. A forecast cell is five kilometres and
   * holds a dozen 동 of several districts, and `nameOf` can only say which districts are commonest
   * in it. Measured 2026-10-06 on the owner's own device, in 가산동: "서울특별시 구로구, 경기도
   * 광명시 등" — 금천구, where the device was, was the "등". Each row's own coordinate answers the
   * question that was being asked. Only 기상청's rows below a 시·도: a province's row is its office.
   */
  const somewhere = entries.filter(
    (entry): entry is Entry & { at: { latitude: number; longitude: number } } =>
      entry.at !== undefined && !entry.made && entry.levels.length >= 2,
  );
  function nameAt(point: {
    latitude: number;
    longitude: number;
  }): string | null {
    // East–west degrees are shorter than north–south ones by the cosine of where you stand.
    const narrowing = Math.cos((point.latitude * Math.PI) / 180);
    /** Each district's nearest 동, in kilometres. */
    const reach = new Map<string, number>();
    for (const entry of somewhere) {
      const north = entry.at.latitude - point.latitude;
      const east = (entry.at.longitude - point.longitude) * narrowing;
      const km = Math.sqrt(north * north + east * east) * KM_PER_DEGREE;
      if (km > NEAR_KM) continue;
      const district = districtOf(entry);
      if (km < (reach.get(district) ?? Number.POSITIVE_INFINITY)) {
        reach.set(district, km);
      }
    }
    const byReach = [...reach.entries()].sort(([, a], [, b]) => a - b);
    const [nearest] = byReach;
    if (!nearest) return null;
    /*
     * ON A BORDER, BOTH SIDES ARE SAID. A device's place is kept to two decimals, a kilometre, on
     * purpose, so the point that is asked about is not the point the person stands on: the owner's
     * device in 가산동 (금천구) is kept as 37.48, 126.89, which is 300 m from a 동 of 구로구 and 700 m
     * from 가산동's own. Naming the nearest alone would say 구로구 to somebody in 금천구. Every
     * district with a 동 within that rounding of the nearest one is named, nearest first.
     */
    const [first = "", second, third] = byReach
      .filter(([, km]) => km <= nearest[1] + ROUNDING_KM)
      .map(([name]) => name);
    if (!second) return first;
    return `${together(first, second)}${third ? " 등" : ""}`;
  }

  /**
   * What a found row is called in the answer.
   *
   * A province is one cell — where 기상청 put its row, which is its office: 춘천 for 강원, 무안 for
   * the merged 전남광주 — and 강원 is not one weather. So a province is named with the place its
   * cell actually is.
   */
  function nameFor(entry: Entry): string {
    const [sido = ""] = entry.levels;
    if (entry.levels.length > 1 || CITY_SIDO.test(sido)) {
      return display(entry.levels);
    }
    const where = nameOf(entry);
    if (!where) return sido;
    return `${sido}(대표 지점: ${
      where.startsWith(`${sido} `) ? where.slice(sido.length + 1) : where
    })`;
  }

  return {
    size: rows.length,
    nameOf,
    nameAt,
    find(query) {
      const asked = squeeze(query);
      if ([...asked].length < 2) return { kind: "unknown" };
      const hits = matching(asked, called);
      if (hits.length === 0) return { kind: "unknown" };

      const coarsest = Math.min(...hits.map((entry) => entry.rank));
      const candidates = hits.filter((entry) => entry.rank === coarsest);
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
          levels: first.levels,
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

/** The table this deployment ships: 기상청's rows, as `kma-places-table.ts` was generated from them. */
export const KMA_PLACES: KmaPlaces = createKmaPlaces(
  parseKmaPlaces(KMA_PLACES_TABLE),
);
