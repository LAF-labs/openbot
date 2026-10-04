/**
 * 기상청's 중기예보 regions: which temperature region and which land region a forecast cell is in.
 *
 * The 중기예보 (days four to ten) is not issued by grid cell as the 단기예보 is. It is issued by
 * region, in two tables: 중기기온예보 by 시·군 — a code such as `11B20601` for 수원 — and 중기육상예보
 * (sky and chance of rain) by one of ten broad regions — `11B00000` for 서울·인천·경기. So a cell has
 * to be turned into those two codes, and this file does that from the one table the repository
 * already ships: every 읍·면·동 row of `kma-places-table.ts` names its 시·군·구, and every 시·군 of
 * the country has a temperature region of its own name. A cell is answered with the region of the
 * rows that sit in it, or of the nearest row when no row does.
 *
 * WHERE THE CODES COME FROM. The code list is the appendix of 기상청's own 활용가이드 for the service
 * (data.go.kr 15059468), which is a document to download and not a page to read. The list below was
 * put together from two public copies of that appendix made independently of each other — one of
 * 174 codes, one of 173, the same code for the same place on every row they share — and then held
 * to the service itself: every code was asked for on 2026-10-04 with the fleet's key, and 173
 * answered a row. The one that did not, `11H10603 군위`, was a county until it became a district of
 * 대구 in 2023 and the service no longer issues it; it is not in this table, and 군위군 is answered
 * with 대구's region like the rest of the city.
 *
 * NOT EVERY REGION IS A 시·군. Seven are a 군 or an 읍·면 that 기상청 forecasts under a name of its
 * own, because its weather is not its 시·군's — four islands and three places high up or far out:
 * 울릉도, 백령도 (with 대청면, which has no region of its own), 흑산도, 추자도, 대관령, 추풍령 and
 * 성산. Their rows are answered as themselves (`OWN_REGIONS`). 순천 has two regions — `순천시`, filed
 * with the coast (여수, 광양), and an older `순천`, filed inland with 구례 and 곡성; both answer, and
 * the city's rows take the one that carries the city's name. That older one, 성판악 (a pass on
 * 한라산), 고산 (a 리), 이어도 (a research station) and 독도 have no 읍·면 of the table to belong
 * to, and are never answered.
 *
 * THE LAND REGION FOLLOWS FROM THE TEMPERATURE CODE. The first four characters say which of the ten
 * broad regions a 시·군 is in (`11D1` 강원영서, `11D2` 강원영동), with three exceptions the service
 * itself makes: `21F…` codes are 전북 and 전남 towns filed under a second prefix, 백령도 (`11A`) is
 * forecast with 서울·인천·경기, and 울릉도·독도 (`11E`) with 대구·경북. `11A00000`, `11E00000`,
 * `21F10000` and `21F20000` were asked for and answer NO_DATA: they are not land regions.
 */
import type { KmaCell } from "./kma-grid";
import { type KmaPlace, parseKmaPlaces } from "./kma-places";
import { KMA_PLACES_TABLE } from "./kma-places-table";

/** The two codes a cell is asked about, and the name of the temperature region for the trail. */
export type KmaMidRegion = {
  /** 중기기온예보 구역, `regId` of `getMidTa`. */
  temperature: string;
  /** 중기육상예보 구역, `regId` of `getMidLandFcst`. */
  land: string;
  /** The temperature region's name, as 기상청 lists it: 수원, 서울, 백령도. */
  name: string;
};

export type KmaMidRegions = {
  /** How many 시·군·구 rows were given a region. Zero is "no table". */
  size: number;
  /**
   * The region of a place: by its names when the place was found by them (`KmaPlaceAnswer.levels`),
   * else by its cell — the region most of the cell's rows are in, or the nearest row's.
   *
   * THE NAMES COME FIRST because a 시·군's own row sits where its 시청 is, and six of those sit in a
   * neighbour's cell with more of the neighbour's 동 in it: 광명시 and 구리시 in 서울's, 양주시 in
   * 의정부's, 경산시 in 대구's, 완주군 in 전주's, 신안군 in 목포's. Somebody who said 광명 is told
   * 광명's forecast; a device's coordinates in that cell, which name no 시·군, get the cell's.
   */
  of(cell: KmaCell, levels?: readonly string[]): KmaMidRegion | null;
};

/**
 * 중기기온예보 구역코드, one a line: the code and the name 기상청 gives it. The provenance is in the
 * file comment above.
 */
export const KMA_MID_TEMPERATURE_REGIONS = `
11A00101 백령도
11B10101 서울
11B10102 과천
11B10103 광명
11B20101 강화
11B20102 김포
11B20201 인천
11B20202 시흥
11B20203 안산
11B20204 부천
11B20301 의정부
11B20302 고양
11B20304 양주
11B20305 파주
11B20401 동두천
11B20402 연천
11B20403 포천
11B20404 가평
11B20501 구리
11B20502 남양주
11B20503 양평
11B20504 하남
11B20601 수원
11B20602 안양
11B20603 오산
11B20604 화성
11B20605 성남
11B20606 평택
11B20609 의왕
11B20610 군포
11B20611 안성
11B20612 용인
11B20701 이천
11B20702 광주
11B20703 여주
11C10101 충주
11C10102 진천
11C10103 음성
11C10201 제천
11C10202 단양
11C10301 청주
11C10302 보은
11C10303 괴산
11C10304 증평
11C10401 추풍령
11C10402 영동
11C10403 옥천
11C20101 서산
11C20102 태안
11C20103 당진
11C20104 홍성
11C20201 보령
11C20202 서천
11C20301 천안
11C20302 아산
11C20303 예산
11C20401 대전
11C20402 공주
11C20403 계룡
11C20404 세종
11C20501 부여
11C20502 청양
11C20601 금산
11C20602 논산
11D10101 철원
11D10102 화천
11D10201 인제
11D10202 양구
11D10301 춘천
11D10302 홍천
11D10401 원주
11D10402 횡성
11D10501 영월
11D10502 정선
11D10503 평창
11D20201 대관령
11D20301 태백
11D20401 속초
11D20402 고성
11D20403 양양
11D20501 강릉
11D20601 동해
11D20602 삼척
11E00101 울릉도
11E00102 독도
11F10201 전주
11F10202 익산
11F10203 정읍
11F10204 완주
11F10301 장수
11F10302 무주
11F10303 진안
11F10401 남원
11F10402 임실
11F10403 순창
11F20301 완도
11F20302 해남
11F20303 강진
11F20304 장흥
11F20401 여수
11F20402 광양
11F20403 고흥
11F20404 보성
11F20405 순천시
11F20501 광주
11F20502 장성
11F20503 나주
11F20504 담양
11F20505 화순
11F20601 구례
11F20602 곡성
11F20603 순천
11F20701 흑산도
11G00101 성산
11G00201 제주
11G00302 성판악
11G00401 서귀포
11G00501 고산
11G00601 이어도
11G00800 추자도
11H10101 울진
11H10102 영덕
11H10201 포항
11H10202 경주
11H10301 문경
11H10302 상주
11H10303 예천
11H10401 영주
11H10402 봉화
11H10403 영양
11H10501 안동
11H10502 의성
11H10503 청송
11H10601 김천
11H10602 구미
11H10604 고령
11H10605 성주
11H10701 대구
11H10702 영천
11H10703 경산
11H10704 청도
11H10705 칠곡
11H20101 울산
11H20102 양산
11H20201 부산
11H20301 창원
11H20304 김해
11H20401 통영
11H20402 사천
11H20403 거제
11H20404 고성
11H20405 남해
11H20501 함양
11H20502 거창
11H20503 합천
11H20601 밀양
11H20602 의령
11H20603 함안
11H20604 창녕
11H20701 진주
11H20703 산청
11H20704 하동
21F10501 군산
21F10502 김제
21F10601 고창
21F10602 부안
21F20101 함평
21F20102 영광
21F20201 진도
21F20801 목포
21F20802 영암
21F20803 신안
21F20804 무안
`;

/**
 * The 시·도 each temperature-code prefix covers — so that 고성 is 강원's under `11D2` and 경남's
 * under `11H2`, and 광주 is the city under `11F2` and 경기's 광주시 under `11B`. A 시·도 is listed
 * under every name an edition of the table has called it.
 */
const SIDO_OF_PREFIX: readonly { prefix: string; sido: readonly string[] }[] = [
  { prefix: "11A", sido: ["인천광역시"] },
  { prefix: "11B", sido: ["서울특별시", "인천광역시", "경기도"] },
  { prefix: "11C1", sido: ["충청북도"] },
  { prefix: "11C2", sido: ["대전광역시", "세종특별자치시", "충청남도"] },
  { prefix: "11D", sido: ["강원특별자치도", "강원도"] },
  { prefix: "11E", sido: ["경상북도"] },
  { prefix: "11F1", sido: ["전북특별자치도", "전라북도"] },
  { prefix: "21F1", sido: ["전북특별자치도", "전라북도"] },
  {
    prefix: "11F2",
    sido: ["전남광주통합특별시", "전라남도", "광주광역시"],
  },
  { prefix: "21F2", sido: ["전남광주통합특별시", "전라남도"] },
  { prefix: "11G", sido: ["제주특별자치도"] },
  { prefix: "11H1", sido: ["대구광역시", "경상북도"] },
  { prefix: "11H2", sido: ["부산광역시", "울산광역시", "경상남도"] },
];

/** The land region of a temperature code: its prefix, with the service's three exceptions. */
export function landRegionOf(temperature: string): string {
  const head = temperature.slice(0, 4);
  if (temperature.startsWith("11A") || temperature.startsWith("11B")) {
    return "11B00000";
  }
  if (temperature.startsWith("11E")) return "11H10000";
  if (temperature.startsWith("11G")) return "11G00000";
  if (head.startsWith("21F")) return `11F${head[3]}0000`;
  return `${head}0000`;
}

/**
 * A 시·도 that is one city, whose districts all take the city's own region: 서울's 25 구 are 서울.
 * 광주 is the merged 시·도's five districts, which `CITY_DISTRICTS` names, and the old 시·도's.
 */
const CITY_SIDO: Readonly<Record<string, string>> = {
  서울특별시: "서울",
  인천광역시: "인천",
  대전광역시: "대전",
  대구광역시: "대구",
  부산광역시: "부산",
  울산광역시: "울산",
  세종특별자치시: "세종",
  광주광역시: "광주",
};

/** The districts of a city that is no longer a 시·도 and still one region (`kma-places.ts`, CITIES_WITHIN). */
const CITY_DISTRICTS: readonly {
  sido: string;
  name: string;
  districts: readonly string[];
}[] = [
  {
    sido: "전남광주통합특별시",
    name: "광주",
    districts: ["동구", "서구", "남구", "북구", "광산구"],
  },
];

/** A 군 or an 읍·면 that 기상청 forecasts under a name of its own rather than its 시·군's. */
const OWN_REGIONS: readonly {
  sigungu: string;
  /** The 읍·면 that are the region; absent when the whole 시·군 is. */
  within?: readonly string[];
  name: string;
}[] = [
  { sigungu: "울릉군", name: "울릉도" },
  { sigungu: "옹진군", within: ["백령면", "대청면"], name: "백령도" },
  { sigungu: "신안군", within: ["흑산면"], name: "흑산도" },
  { sigungu: "제주시", within: ["추자면"], name: "추자도" },
  { sigungu: "평창군", within: ["대관령면"], name: "대관령" },
  { sigungu: "영동군", within: ["추풍령면"], name: "추풍령" },
  { sigungu: "서귀포시", within: ["성산읍"], name: "성산" },
];

/** 수원시 → 수원, 고성군 → 고성, 광산구 → 광산. */
const stem = (name: string) => name.replace(/(시|군|구)$/, "");

/** Rows further than this from the nearest row are nowhere: the same thirty kilometres as `nameOf`. */
const NEAR_CELLS = 6;

export function createKmaMidRegions(rows: readonly KmaPlace[]): KmaMidRegions {
  const regions = new Map<string, KmaMidRegion>();
  /** Temperature regions by name, each under the 시·도 its prefix covers. */
  const byName = new Map<string, KmaMidRegion>();
  for (const line of KMA_MID_TEMPERATURE_REGIONS.split("\n")) {
    const [code = "", name = ""] = line.trim().split(/\s+/);
    if (!code || !name) continue;
    const region = { temperature: code, land: landRegionOf(code), name };
    regions.set(code, region);
    const group = SIDO_OF_PREFIX.filter(({ prefix }) =>
      code.startsWith(prefix),
    );
    for (const { sido } of group) {
      for (const one of sido) byName.set(`${one}|${name}`, region);
    }
  }
  const named = (sido: string, name: string) => byName.get(`${sido}|${name}`);

  /** The region of one row, by its names: its own, its 시·군's, its city's — or none. */
  function regionOf(levels: readonly string[]): KmaMidRegion | undefined {
    const [sido = "", sigungu = "", below = ""] = levels;
    if (!sigungu) return undefined;
    const own = OWN_REGIONS.find(
      (one) =>
        one.sigungu === sigungu && (!one.within || one.within.includes(below)),
    );
    const there = own ? named(sido, own.name) : undefined;
    if (there) return there;
    const city = CITY_DISTRICTS.find(
      (one) => one.sido === sido && one.districts.includes(sigungu),
    );
    if (city) return named(sido, city.name);
    // The name as written before the name without its 시·군·구: 순천시 is a region and so is 순천.
    return (
      named(sido, sigungu) ??
      named(sido, stem(sigungu)) ??
      (CITY_SIDO[sido] ? named(sido, CITY_SIDO[sido]) : undefined)
    );
  }

  type Anchor = { nx: number; ny: number; region: KmaMidRegion };
  const anchors: Anchor[] = [];
  const byCell = new Map<string, Anchor[]>();
  const cellKey = (cell: KmaCell) => `${cell.nx},${cell.ny}`;
  for (const row of rows) {
    const region = regionOf(row.levels);
    if (!region) continue;
    const anchor = { nx: row.nx, ny: row.ny, region };
    anchors.push(anchor);
    const key = cellKey(row);
    byCell.set(key, [...(byCell.get(key) ?? []), anchor]);
  }

  return {
    size: anchors.length,
    of(cell, levels) {
      const byNames = levels ? regionOf(levels) : undefined;
      if (byNames) return byNames;
      const here = byCell.get(cellKey(cell)) ?? [];
      if (here.length > 0) {
        // A cell on a boundary holds rows of two 시·군; the one with more of them is the cell's.
        const count = new Map<string, number>();
        for (const { region } of here) {
          count.set(
            region.temperature,
            (count.get(region.temperature) ?? 0) + 1,
          );
        }
        const [code = ""] =
          [...count.entries()].sort(([, a], [, b]) => b - a)[0] ?? [];
        return regions.get(code) ?? null;
      }
      let nearest: Anchor | null = null;
      let distance = Number.POSITIVE_INFINITY;
      for (const anchor of anchors) {
        const apart = (anchor.nx - cell.nx) ** 2 + (anchor.ny - cell.ny) ** 2;
        if (apart < distance) {
          nearest = anchor;
          distance = apart;
        }
      }
      return nearest && distance <= NEAR_CELLS ** 2 ? nearest.region : null;
    },
  };
}

/** The regions this deployment answers with: 기상청's rows, through the table above. */
export const KMA_MID_REGIONS: KmaMidRegions = createKmaMidRegions(
  parseKmaPlaces(KMA_PLACES_TABLE),
);
