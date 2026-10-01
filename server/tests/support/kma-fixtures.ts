/**
 * What 기상청's API hub answered on 2026-10-01 and 2026-10-02, for the weather tool's tests.
 *
 * REAL VALUES, RE-LAID AND CUT. Every number and word below came back from apihub.kma.go.kr on the
 * fleet's key (which is in no body: it rides on the request, and a body that mentioned one would
 * not have been written here). A 단기예보 answer is about a thousand JSON rows and 130 KB, so a
 * forecast is kept one forecast time per line, and `shortForecast` / `veryShortForecast` put the
 * lines back into the vendor's rows and envelope, field order and row order included.
 *
 * `SEOUL_MIDNIGHT.days` is a whole body: all fourteen categories of every forecast time, the six
 * this repository never reads among them (wind, waves, humidity), because one fixture should show
 * that they are passed over. The other 단기예보 bodies are cut to the eight categories that are read;
 * their `numOfRows` and `totalCount` are still what the hub said. The small bodies — an
 * observation, each way the hub says no — are byte for byte what arrived.
 *
 * What is NOT here is weather that did not happen those two days: the whole country was dry until
 * the 5th, so no body carries snow, a shower or the "30.0~50.0mm" wording. Those are exercised in
 * the test file with rows written by hand and said to be.
 */

type Stamp = { baseDate: string; baseTime: string; nx: number; ny: number };
type Page = { numOfRows: number; totalCount: number };

/** The envelope both forecast operations answer in, as measured. */
function envelope(rows: unknown[], page: Page): string {
  return JSON.stringify({
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL_SERVICE" },
      body: {
        dataType: "JSON",
        items: { item: rows },
        pageNo: 1,
        numOfRows: page.numOfRows,
        totalCount: page.totalCount,
      },
    },
  });
}

/** `20261002 0100 | TMP=14; SKY=1` → the forecast time and its values, in the order written. */
function slotsOf(
  lines: string,
): { date: string; time: string; values: [string, string][] }[] {
  return lines
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [slot = "", rest = ""] = line.split(" | ");
      const [date = "", time = ""] = slot.split(" ");
      return {
        date,
        time,
        values: rest.split("; ").map((pair) => {
          const at = pair.indexOf("=");
          return [pair.slice(0, at), pair.slice(at + 1)] as [string, string];
        }),
      };
    });
}

const row = (
  stamp: Stamp,
  category: string,
  date: string,
  time: string,
  value: string,
) => ({
  baseDate: stamp.baseDate,
  baseTime: stamp.baseTime,
  category,
  fcstDate: date,
  fcstTime: time,
  fcstValue: value,
  nx: stamp.nx,
  ny: stamp.ny,
});

/** 단기예보 orders its rows by forecast time, then by category. */
export function shortForecast(stamp: Stamp, page: Page, lines: string): string {
  return envelope(
    slotsOf(lines).flatMap((slot) =>
      slot.values.map(([category, value]) =>
        row(stamp, category, slot.date, slot.time, value),
      ),
    ),
    page,
  );
}

/** 초단기예보 orders them the other way: every time of one category, then the next category. */
export function veryShortForecast(
  stamp: Stamp,
  page: Page,
  lines: string,
): string {
  const slots = slotsOf(lines);
  const categories = (slots[0]?.values ?? []).map(([category]) => category);
  return envelope(
    categories.flatMap((category) =>
      slots.flatMap((slot) =>
        slot.values
          .filter(([name]) => name === category)
          .map(([, value]) =>
            row(stamp, category, slot.date, slot.time, value),
          ),
      ),
    ),
    page,
  );
}

/* ── the ways the hub says no, byte for byte ─────────────────────────────────────────────────── */

/** HTTP 200. An issuance that is not published yet — and a request with a parameter missing. */
export const NO_DATA_BODY =
  '{"response":{"header":{"resultCode":"03","resultMsg":"NO_DATA"}}}';
/** HTTP 200, to an observation older than a day and to a date it cannot read. */
export const TOO_OLD_BODY =
  '{"response":{"header":{"resultCode":"10","resultMsg":"최근 1일 간의 자료만 제공합니다."}}}';
/** HTTP 403: an operation the key was never applied for. */
export const NOT_APPLIED_BODY =
  '{\n  "result" : {\n    "status" : 403,\n    "message" : "활용신청이 필요한 API 입니다. 활용신청 후 다시 시도해 주십시오."\n  }\n}';
/** HTTP 403: a path the hub does not serve at all. */
export const NOT_ALLOWED_BODY =
  '{\n  "result" : {\n    "status" : 403,\n    "message" : "허용되지 않은 API 입니다."\n  }\n}';
/** HTTP 401: a key the hub does not know, or none. */
export const BAD_KEY_BODY =
  '{\n  "result" : {\n    "status" : 401,\n    "message" : "유효한 인증키가 아닙니다."\n  }\n}';

/* ── 서울 (60, 127), 2026-10-02 00:45 KST ───────────────────────────────────────────────────── */

export const SEOUL_MIDNIGHT = {
  /** 초단기실황, base 20261002/0000. */
  now: '{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL_SERVICE"},"body":{"dataType":"JSON","items":{"item":[{"baseDate":"20261002","baseTime":"0000","category":"PTY","nx":60,"ny":127,"obsrValue":"0"},{"baseDate":"20261002","baseTime":"0000","category":"REH","nx":60,"ny":127,"obsrValue":"37"},{"baseDate":"20261002","baseTime":"0000","category":"RN1","nx":60,"ny":127,"obsrValue":"0"},{"baseDate":"20261002","baseTime":"0000","category":"T1H","nx":60,"ny":127,"obsrValue":"15.2"},{"baseDate":"20261002","baseTime":"0000","category":"UUU","nx":60,"ny":127,"obsrValue":"2.2"},{"baseDate":"20261002","baseTime":"0000","category":"VEC","nx":60,"ny":127,"obsrValue":"324"},{"baseDate":"20261002","baseTime":"0000","category":"VVV","nx":60,"ny":127,"obsrValue":"-2.9"},{"baseDate":"20261002","baseTime":"0000","category":"WSD","nx":60,"ny":127,"obsrValue":"3.7"}]},"pageNo":1,"numOfRows":1000,"totalCount":8}}}',
  /** 초단기예보, asked as 0030 and answered under baseTime 0000. */
  hours: veryShortForecast(
    { baseDate: "20261002", baseTime: "0000", nx: 60, ny: 127 },
    { numOfRows: 100, totalCount: 66 },
    `
20261002 0100 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=15; REH=35; UUU=0.4; VVV=-2.6; VEC=352; WSD=3; POP=0
20261002 0200 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=14; REH=40; UUU=0.6; VVV=-2.4; VEC=347; WSD=3; POP=0
20261002 0300 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=13; REH=50; UUU=0.5; VVV=-1.8; VEC=345; WSD=2; POP=0
20261002 0400 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=12; REH=55; UUU=0.6; VVV=-1; VEC=331; WSD=1; POP=0
20261002 0500 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=12; REH=55; UUU=0.7; VVV=-0.9; VEC=325; WSD=1; POP=0
20261002 0600 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=12; REH=60; UUU=0.6; VVV=-0.7; VEC=323; WSD=1; POP=0
`,
  ),
  /** 단기예보, base 20261001/2300, whole: dry until a little rain in the small hours of the 5th. */
  days: shortForecast(
    { baseDate: "20261001", baseTime: "2300", nx: 60, ny: 127 },
    { numOfRows: 1100, totalCount: 980 },
    `
20261002 0000 | TMP=14; UUU=0.8; VVV=-0.8; VEC=318; WSD=1.2; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=55; SNO=적설없음
20261002 0100 | TMP=14; UUU=0.7; VVV=-0.7; VEC=315; WSD=1.1; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=55; SNO=적설없음
20261002 0200 | TMP=13; UUU=0.8; VVV=-0.8; VEC=318; WSD=1.2; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=55; SNO=적설없음
20261002 0300 | TMP=13; UUU=0.6; VVV=-0.8; VEC=322; WSD=1.1; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=60; SNO=적설없음
20261002 0400 | TMP=12; UUU=0.7; VVV=-0.7; VEC=315; WSD=1.1; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=60; SNO=적설없음
20261002 0500 | TMP=12; UUU=0.7; VVV=-0.9; VEC=321; WSD=1.2; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=60; SNO=적설없음
20261002 0600 | TMP=12; UUU=0.6; VVV=-0.8; VEC=322; WSD=1.1; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=60; SNO=적설없음; TMN=12.0
20261002 0700 | TMP=12; UUU=0.8; VVV=-1; VEC=321; WSD=1.4; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=60; SNO=적설없음
20261002 0800 | TMP=13; UUU=0.9; VVV=-1.5; VEC=328; WSD=1.8; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=50; SNO=적설없음
20261002 0900 | TMP=16; UUU=1.5; VVV=-2.5; VEC=330; WSD=3; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=45; SNO=적설없음
20261002 1000 | TMP=17; UUU=1.5; VVV=-3.3; VEC=335; WSD=3.7; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=35; SNO=적설없음
20261002 1100 | TMP=19; UUU=1.9; VVV=-3.3; VEC=330; WSD=3.9; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=35; SNO=적설없음
20261002 1200 | TMP=20; UUU=1.9; VVV=-3.2; VEC=329; WSD=3.8; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=30; SNO=적설없음
20261002 1300 | TMP=21; UUU=1.9; VVV=-3.1; VEC=329; WSD=3.7; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=30; SNO=적설없음
20261002 1400 | TMP=21; UUU=1.9; VVV=-2.7; VEC=324; WSD=3.4; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=30; SNO=적설없음
20261002 1500 | TMP=21; UUU=1.7; VVV=-2.4; VEC=324; WSD=3; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=30; SNO=적설없음; TMX=21.0
20261002 1600 | TMP=21; UUU=1.6; VVV=-2.1; VEC=322; WSD=2.7; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=30; SNO=적설없음
20261002 1700 | TMP=21; UUU=1.4; VVV=-1.7; VEC=320; WSD=2.3; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=35; SNO=적설없음
20261002 1800 | TMP=19; UUU=1.2; VVV=-1.1; VEC=313; WSD=1.7; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=40; SNO=적설없음
20261002 1900 | TMP=18; UUU=1.1; VVV=-0.6; VEC=300; WSD=1.3; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=45; SNO=적설없음
20261002 2000 | TMP=17; UUU=0.6; VVV=-0.6; VEC=315; WSD=0.9; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=50; SNO=적설없음
20261002 2100 | TMP=16; UUU=0.4; VVV=-0.2; VEC=301; WSD=0.5; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=55; SNO=적설없음
20261002 2200 | TMP=15; UUU=0.3; VVV=-0.3; VEC=323; WSD=0.5; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=60; SNO=적설없음
20261002 2300 | TMP=15; UUU=0.3; VVV=-0.3; VEC=323; WSD=0.5; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=60; SNO=적설없음
20261003 0000 | TMP=14; UUU=0; VVV=-0.4; VEC=349; WSD=0.5; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=65; SNO=적설없음
20261003 0100 | TMP=13; UUU=0; VVV=-0.6; VEC=0; WSD=0.6; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=65; SNO=적설없음
20261003 0200 | TMP=13; UUU=0; VVV=-0.4; VEC=0; WSD=0.4; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=65; SNO=적설없음
20261003 0300 | TMP=12; UUU=0; VVV=-0.3; VEC=27; WSD=0.4; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=70; SNO=적설없음
20261003 0400 | TMP=12; UUU=-0.2; VVV=-0.1; VEC=63; WSD=0.4; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=70; SNO=적설없음
20261003 0500 | TMP=11; UUU=-0.3; VVV=-0.2; VEC=59; WSD=0.5; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=70; SNO=적설없음
20261003 0600 | TMP=11; UUU=-0.5; VVV=-0.1; VEC=74; WSD=0.7; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=75; SNO=적설없음; TMN=11.0
20261003 0700 | TMP=11; UUU=-0.7; VVV=0; VEC=84; WSD=0.9; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=75; SNO=적설없음
20261003 0800 | TMP=13; UUU=-0.9; VVV=0; VEC=90; WSD=1; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=65; SNO=적설없음
20261003 0900 | TMP=15; UUU=-0.7; VVV=0; VEC=84; WSD=0.9; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=55; SNO=적설없음
20261003 1000 | TMP=17; UUU=-1.1; VVV=0; VEC=90; WSD=1.2; SKY=3; PTY=0; POP=20; WAV=0; PCP=강수없음; REH=45; SNO=적설없음
20261003 1100 | TMP=19; UUU=-0.8; VVV=0.3; VEC=112; WSD=1; SKY=4; PTY=0; POP=30; WAV=0; PCP=강수없음; REH=40; SNO=적설없음
20261003 1200 | TMP=20; UUU=-0.8; VVV=0.7; VEC=129; WSD=1.2; SKY=4; PTY=0; POP=30; WAV=0; PCP=강수없음; REH=40; SNO=적설없음
20261003 1300 | TMP=22; UUU=-0.8; VVV=1; VEC=138; WSD=1.4; SKY=4; PTY=0; POP=30; WAV=0; PCP=강수없음; REH=35; SNO=적설없음
20261003 1400 | TMP=22; UUU=-0.5; VVV=1.1; VEC=150; WSD=1.3; SKY=4; PTY=0; POP=30; WAV=0; PCP=강수없음; REH=30; SNO=적설없음
20261003 1500 | TMP=22; UUU=-0.4; VVV=1.3; VEC=157; WSD=1.5; SKY=4; PTY=0; POP=30; WAV=0; PCP=강수없음; REH=35; SNO=적설없음; TMX=22.0
20261003 1600 | TMP=22; UUU=-0.5; VVV=1.1; VEC=150; WSD=1.3; SKY=4; PTY=0; POP=30; WAV=0; PCP=강수없음; REH=35; SNO=적설없음
20261003 1700 | TMP=22; UUU=-0.5; VVV=1.1; VEC=150; WSD=1.3; SKY=4; PTY=0; POP=30; WAV=0; PCP=강수없음; REH=40; SNO=적설없음
20261003 1800 | TMP=20; UUU=-0.6; VVV=0.7; VEC=135; WSD=1.1; SKY=4; PTY=0; POP=30; WAV=0; PCP=강수없음; REH=50; SNO=적설없음
20261003 1900 | TMP=19; UUU=-0.4; VVV=0.4; VEC=130; WSD=0.7; SKY=4; PTY=0; POP=30; WAV=0; PCP=강수없음; REH=55; SNO=적설없음
20261003 2000 | TMP=18; UUU=-0.2; VVV=0.3; VEC=135; WSD=0.5; SKY=4; PTY=0; POP=30; WAV=0; PCP=강수없음; REH=60; SNO=적설없음
20261003 2100 | TMP=17; UUU=-0.3; VVV=0; VEC=101; WSD=0.5; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=65; SNO=적설없음
20261003 2200 | TMP=17; UUU=-0.6; VVV=0.1; VEC=104; WSD=0.8; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=65; SNO=적설없음
20261003 2300 | TMP=16; UUU=-1; VVV=0.3; VEC=108; WSD=1.2; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=65; SNO=적설없음
20261004 0000 | TMP=16; UUU=-1.3; VVV=0.2; VEC=101; WSD=1.5; SKY=1; PTY=0; POP=0; WAV=0; PCP=강수없음; REH=70; SNO=적설없음
20261004 0100 | TMP=15; UUU=-1.3; VVV=0.2; VEC=101; WSD=1.5; SKY=1; PTY=0; POP=0; WAV=0; PCP=0; REH=70; SNO=0
20261004 0200 | TMP=15; UUU=-1.4; VVV=0.3; VEC=101; WSD=1.6; SKY=1; PTY=0; POP=0; WAV=0; PCP=0; REH=70; SNO=0
20261004 0300 | TMP=15; UUU=-1.5; VVV=0; VEC=93; WSD=1.7; SKY=1; PTY=0; POP=0; WAV=0; PCP=0; REH=70; SNO=0
20261004 0400 | TMP=15; UUU=-1.6; VVV=0.1; VEC=96; WSD=1.8; SKY=1; PTY=0; POP=0; WAV=0; PCP=0; REH=75; SNO=0
20261004 0500 | TMP=15; UUU=-1.6; VVV=0; VEC=93; WSD=1.8; SKY=3; PTY=0; POP=20; WAV=0; PCP=0; REH=75; SNO=0
20261004 0600 | TMP=14; UUU=-1.7; VVV=0; VEC=93; WSD=1.9; SKY=4; PTY=0; POP=30; WAV=0; PCP=0; REH=75; SNO=0; TMN=14.0
20261004 0700 | TMP=14; UUU=-1.7; VVV=0; VEC=93; WSD=1.9; SKY=4; PTY=0; POP=30; WAV=0; PCP=0; REH=75; SNO=0
20261004 0800 | TMP=15; UUU=-1.6; VVV=0.1; VEC=96; WSD=1.8; SKY=3; PTY=0; POP=20; WAV=0; PCP=0; REH=75; SNO=0
20261004 0900 | TMP=17; UUU=-1.5; VVV=0.3; VEC=103; WSD=1.7; SKY=3; PTY=0; POP=20; WAV=0; PCP=0; REH=65; SNO=0
20261004 1000 | TMP=19; UUU=-1.4; VVV=1.2; VEC=127; WSD=2; SKY=3; PTY=0; POP=20; WAV=0; PCP=0; REH=55; SNO=0
20261004 1100 | TMP=20; UUU=-1.1; VVV=2; VEC=150; WSD=2.4; SKY=1; PTY=0; POP=0; WAV=0; PCP=0; REH=50; SNO=0
20261004 1200 | TMP=22; UUU=-0.7; VVV=2.3; VEC=159; WSD=2.5; SKY=1; PTY=0; POP=0; WAV=0; PCP=0; REH=45; SNO=0
20261004 1300 | TMP=23; UUU=-0.7; VVV=2.6; VEC=163; WSD=2.8; SKY=3; PTY=0; POP=20; WAV=0; PCP=0; REH=40; SNO=0
20261004 1400 | TMP=23; UUU=-0.1; VVV=2.6; VEC=174; WSD=2.7; SKY=3; PTY=0; POP=20; WAV=0; PCP=0; REH=40; SNO=0
20261004 1500 | TMP=23; UUU=0; VVV=2.7; VEC=182; WSD=2.8; SKY=1; PTY=0; POP=0; WAV=0; PCP=0; REH=40; SNO=0; TMX=23.0
20261004 1600 | TMP=23; UUU=0.3; VVV=2.3; VEC=189; WSD=2.4; SKY=3; PTY=0; POP=20; WAV=0; PCP=0; REH=40; SNO=0
20261004 1700 | TMP=23; UUU=0.9; VVV=2; VEC=205; WSD=2.3; SKY=1; PTY=0; POP=0; WAV=0; PCP=0; REH=45; SNO=0
20261004 1800 | TMP=21; UUU=0.9; VVV=1.7; VEC=209; WSD=2; SKY=3; PTY=0; POP=20; WAV=0; PCP=0; REH=50; SNO=0
20261004 1900 | TMP=20; UUU=1.1; VVV=1.4; VEC=219; WSD=1.9; SKY=4; PTY=0; POP=30; WAV=0; PCP=0; REH=55; SNO=0
20261004 2000 | TMP=19; UUU=0.5; VVV=1.3; VEC=203; WSD=1.5; SKY=4; PTY=0; POP=30; WAV=0; PCP=0; REH=60; SNO=0
20261004 2100 | TMP=19; UUU=0.6; VVV=1.4; VEC=205; WSD=1.6; SKY=4; PTY=0; POP=30; WAV=0; PCP=0; REH=60; SNO=0
20261004 2200 | TMP=18; UUU=0.8; VVV=1.2; VEC=215; WSD=1.5; SKY=4; PTY=0; POP=30; WAV=0; PCP=0; REH=70; SNO=0
20261004 2300 | TMP=18; UUU=0.2; VVV=1.4; VEC=191; WSD=1.5; SKY=4; PTY=0; POP=30; WAV=0; PCP=0; REH=75; SNO=0
20261005 0000 | TMP=17; UUU=0.3; VVV=1.6; VEC=193; WSD=1.7; SKY=4; PTY=1; POP=60; WAV=0; PCP=0.4; REH=85; SNO=0
20261005 0300 | TMP=16; UUU=1.2; VVV=0.8; VEC=235; WSD=1; SKY=4; PTY=1; POP=70; WAV=0; PCP=2; REH=90; SNO=0
20261005 0600 | TMP=15; UUU=0.6; VVV=0; VEC=262; WSD=1; SKY=3; PTY=0; POP=20; WAV=0; PCP=0; REH=90; SNO=0; TMN=15.0
20261005 0900 | TMP=16; UUU=1.3; VVV=-0.1; VEC=278; WSD=1; SKY=4; PTY=0; POP=30; WAV=0; PCP=0; REH=80; SNO=0
20261005 1200 | TMP=19; UUU=3.2; VVV=-0.5; VEC=279; WSD=1; SKY=4; PTY=0; POP=30; WAV=0; PCP=0; REH=60; SNO=0
20261005 1500 | TMP=21; UUU=3.8; VVV=-0.4; VEC=276; WSD=1; SKY=3; PTY=0; POP=20; WAV=0; PCP=0; REH=55; SNO=0; TMX=21.0
20261005 1800 | TMP=18; UUU=3.4; VVV=-0.4; VEC=278; WSD=1; SKY=1; PTY=0; POP=10; WAV=0; PCP=0; REH=65; SNO=0
20261005 2100 | TMP=15; UUU=2.5; VVV=-0.7; VEC=287; WSD=1; SKY=1; PTY=0; POP=10; WAV=0; PCP=0; REH=70; SNO=0
20261006 0000 | TMP=13; UUU=1.9; VVV=-0.5; VEC=287; WSD=1; SKY=1; PTY=0; POP=0; WAV=0; PCP=0; REH=75; SNO=0
`,
  ),
};

/* ── 서울, 2026-10-02 02:50 KST ────────────────────────────────────────────────────────────── */

export const SEOUL_SMALL_HOURS = {
  now: '{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL_SERVICE"},"body":{"dataType":"JSON","items":{"item":[{"baseDate":"20261002","baseTime":"0200","category":"PTY","nx":60,"ny":127,"obsrValue":"0"},{"baseDate":"20261002","baseTime":"0200","category":"REH","nx":60,"ny":127,"obsrValue":"43"},{"baseDate":"20261002","baseTime":"0200","category":"RN1","nx":60,"ny":127,"obsrValue":"0"},{"baseDate":"20261002","baseTime":"0200","category":"T1H","nx":60,"ny":127,"obsrValue":"14"},{"baseDate":"20261002","baseTime":"0200","category":"UUU","nx":60,"ny":127,"obsrValue":"1.6"},{"baseDate":"20261002","baseTime":"0200","category":"VEC","nx":60,"ny":127,"obsrValue":"326"},{"baseDate":"20261002","baseTime":"0200","category":"VVV","nx":60,"ny":127,"obsrValue":"-2.3"},{"baseDate":"20261002","baseTime":"0200","category":"WSD","nx":60,"ny":127,"obsrValue":"2.8"}]},"pageNo":1,"numOfRows":1000,"totalCount":8}}}',
  hours: veryShortForecast(
    { baseDate: "20261002", baseTime: "0200", nx: 60, ny: 127 },
    { numOfRows: 100, totalCount: 66 },
    `
20261002 0300 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=14; REH=45; UUU=-0.3; VVV=-2; VEC=11; WSD=2; POP=0
20261002 0400 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=12; REH=45; UUU=-0.1; VVV=-1.6; VEC=7; WSD=2; POP=0
20261002 0500 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=12; REH=50; UUU=0.1; VVV=-1.4; VEC=356; WSD=2; POP=0
20261002 0600 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=12; REH=55; UUU=0.4; VVV=-0.9; VEC=338; WSD=1; POP=0
20261002 0700 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=12; REH=55; UUU=0.6; VVV=-0.9; VEC=329; WSD=1; POP=0
20261002 0800 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=13; REH=50; UUU=0.8; VVV=-1.3; VEC=330; WSD=2; POP=0
`,
  ),
  /** 단기예보, base 20261002/0200 — the body where 기상청 writes "1mm 미만". */
  days: shortForecast(
    { baseDate: "20261002", baseTime: "0200", nx: 60, ny: 127 },
    { numOfRows: 1100, totalCount: 944 },
    `
20261002 0300 | TMP=13; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0400 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0500 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0600 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMN=12.0
20261002 0700 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0800 | TMP=13; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0900 | TMP=16; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1000 | TMP=17; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1100 | TMP=19; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1200 | TMP=20; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1300 | TMP=21; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1400 | TMP=21; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1500 | TMP=21; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMX=21.0
20261002 1600 | TMP=21; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1700 | TMP=21; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1800 | TMP=19; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1900 | TMP=18; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 2000 | TMP=17; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 2100 | TMP=16; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 2200 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 2300 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0000 | TMP=14; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0100 | TMP=13; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0200 | TMP=13; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0300 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0400 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0500 | TMP=11; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0600 | TMP=11; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMN=11.0
20261003 0700 | TMP=11; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0800 | TMP=13; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0900 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 1000 | TMP=17; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261003 1100 | TMP=19; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1200 | TMP=20; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1300 | TMP=22; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1400 | TMP=22; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1500 | TMP=22; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음; TMX=22.0
20261003 1600 | TMP=22; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1700 | TMP=22; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1800 | TMP=20; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1900 | TMP=19; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 2000 | TMP=18; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 2100 | TMP=17; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 2200 | TMP=17; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 2300 | TMP=16; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261004 0000 | TMP=16; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261004 0100 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261004 0200 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261004 0300 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261004 0400 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261004 0500 | TMP=15; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261004 0600 | TMP=14; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음; TMN=14.0
20261004 0700 | TMP=14; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261004 0800 | TMP=15; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261004 0900 | TMP=17; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261004 1000 | TMP=19; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261004 1100 | TMP=20; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261004 1200 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261004 1300 | TMP=23; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261004 1400 | TMP=23; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261004 1500 | TMP=23; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMX=23.0
20261004 1600 | TMP=23; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261004 1700 | TMP=23; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261004 1800 | TMP=21; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261004 1900 | TMP=20; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261004 2000 | TMP=19; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261004 2100 | TMP=19; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261004 2200 | TMP=18; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261004 2300 | TMP=18; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261005 0000 | TMP=17; SKY=4; PTY=1; POP=60; PCP=1mm 미만; SNO=적설없음
20261005 0300 | TMP=16; SKY=4; PTY=1; POP=70; PCP=2; SNO=0
20261005 0600 | TMP=15; SKY=3; PTY=0; POP=20; PCP=0; SNO=0; TMN=15.0
20261005 0900 | TMP=16; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261005 1200 | TMP=19; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261005 1500 | TMP=21; SKY=3; PTY=0; POP=20; PCP=0; SNO=0; TMX=21.0
20261005 1800 | TMP=18; SKY=1; PTY=0; POP=10; PCP=0; SNO=0
20261005 2100 | TMP=15; SKY=1; PTY=0; POP=10; PCP=0; SNO=0
20261006 0000 | TMP=13; SKY=1; PTY=0; POP=0; PCP=0; SNO=0
`,
  ),
};

/* ── 서울, 2026-10-01 05:30 KST: the 05:00 issuance, which starts at 06:00 with no TMN there ────── */

export const SEOUL_DAWN = {
  now: '{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL_SERVICE"},"body":{"dataType":"JSON","items":{"item":[{"baseDate":"20261001","baseTime":"0500","category":"PTY","nx":60,"ny":127,"obsrValue":"0"},{"baseDate":"20261001","baseTime":"0500","category":"REH","nx":60,"ny":127,"obsrValue":"42"},{"baseDate":"20261001","baseTime":"0500","category":"RN1","nx":60,"ny":127,"obsrValue":"0"},{"baseDate":"20261001","baseTime":"0500","category":"T1H","nx":60,"ny":127,"obsrValue":"15.5"},{"baseDate":"20261001","baseTime":"0500","category":"UUU","nx":60,"ny":127,"obsrValue":"1"},{"baseDate":"20261001","baseTime":"0500","category":"VEC","nx":60,"ny":127,"obsrValue":"324"},{"baseDate":"20261001","baseTime":"0500","category":"VVV","nx":60,"ny":127,"obsrValue":"-1.3"},{"baseDate":"20261001","baseTime":"0500","category":"WSD","nx":60,"ny":127,"obsrValue":"1.7"}]},"pageNo":1,"numOfRows":1000,"totalCount":8}}}',
  hours: veryShortForecast(
    { baseDate: "20261001", baseTime: "0500", nx: 60, ny: 127 },
    { numOfRows: 100, totalCount: 66 },
    `
20261001 0600 | LGT=0; PTY=0; RN1=강수없음; SKY=3; T1H=14; REH=40; UUU=2.1; VVV=-1.9; VEC=314; WSD=3; POP=20
20261001 0700 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=14; REH=35; UUU=1.9; VVV=-1.8; VEC=315; WSD=3; POP=0
20261001 0800 | LGT=0; PTY=0; RN1=강수없음; SKY=3; T1H=14; REH=35; UUU=1.3; VVV=-2.2; VEC=331; WSD=3; POP=20
20261001 0900 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=17; REH=25; UUU=1.3; VVV=-2.5; VEC=333; WSD=3; POP=0
20261001 1000 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=19; REH=20; UUU=1.5; VVV=-3; VEC=334; WSD=3; POP=0
20261001 1100 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=20; REH=25; UUU=2.3; VVV=-3.1; VEC=324; WSD=4; POP=0
`,
  ),
  /** 단기예보, base 20261001/0500 — only its first 150 rows of 907: 06:00 to 18:00 of the 1st. */
  days: shortForecast(
    { baseDate: "20261001", baseTime: "0500", nx: 60, ny: 127 },
    { numOfRows: 150, totalCount: 907 },
    `
20261001 0600 | TMP=13; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261001 0700 | TMP=13; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261001 0800 | TMP=14; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261001 0900 | TMP=17; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261001 1000 | TMP=19; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1100 | TMP=20; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1200 | TMP=20; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1300 | TMP=20; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1400 | TMP=20; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1500 | TMP=20; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMX=20.0
20261001 1600 | TMP=20; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1700 | TMP=20; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1800 | TMP=19
`,
  ),
  /** The 02:00 issuance of the same day is `SEOUL_AFTERNOON.morning`. */
};

/* ── 서울, 2026-10-01 14:50 KST: an issuance that no longer carries the day's 최저 or 최고 ─────── */

export const SEOUL_AFTERNOON = {
  now: '{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL_SERVICE"},"body":{"dataType":"JSON","items":{"item":[{"baseDate":"20261001","baseTime":"1400","category":"PTY","nx":60,"ny":127,"obsrValue":"0"},{"baseDate":"20261001","baseTime":"1400","category":"REH","nx":60,"ny":127,"obsrValue":"24"},{"baseDate":"20261001","baseTime":"1400","category":"RN1","nx":60,"ny":127,"obsrValue":"0"},{"baseDate":"20261001","baseTime":"1400","category":"T1H","nx":60,"ny":127,"obsrValue":"21.4"},{"baseDate":"20261001","baseTime":"1400","category":"UUU","nx":60,"ny":127,"obsrValue":"3.2"},{"baseDate":"20261001","baseTime":"1400","category":"VEC","nx":60,"ny":127,"obsrValue":"299"},{"baseDate":"20261001","baseTime":"1400","category":"VVV","nx":60,"ny":127,"obsrValue":"-1.7"},{"baseDate":"20261001","baseTime":"1400","category":"WSD","nx":60,"ny":127,"obsrValue":"3.6"}]},"pageNo":1,"numOfRows":1000,"totalCount":8}}}',
  hours: veryShortForecast(
    { baseDate: "20261001", baseTime: "1400", nx: 60, ny: 127 },
    { numOfRows: 100, totalCount: 66 },
    `
20261001 1500 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=20; REH=20; UUU=2.2; VVV=0.7; VEC=252; WSD=2; POP=0
20261001 1600 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=20; REH=30; UUU=1.9; VVV=0.8; VEC=247; WSD=2; POP=0
20261001 1700 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=20; REH=35; UUU=1.5; VVV=0.8; VEC=242; WSD=2; POP=0
20261001 1800 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=19; REH=40; UUU=1.2; VVV=0.3; VEC=256; WSD=1; POP=0
20261001 1900 | LGT=0; PTY=0; RN1=강수없음; SKY=3; T1H=18; REH=50; UUU=1.4; VVV=-0.9; VEC=306; WSD=2; POP=20
20261001 2000 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=17; REH=45; UUU=1.5; VVV=-1.5; VEC=317; WSD=2; POP=0
`,
  ),
  /** 단기예보, base 20261001/1400. Its first forecast time is 15:00; its TMN and TMX begin on the 2nd. */
  days: shortForecast(
    { baseDate: "20261001", baseTime: "1400", nx: 60, ny: 127 },
    { numOfRows: 1100, totalCount: 798 },
    `
20261001 1500 | TMP=20; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1600 | TMP=20; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1700 | TMP=20; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1800 | TMP=19; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1900 | TMP=18; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 2000 | TMP=17; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 2100 | TMP=16; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 2200 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 2300 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0000 | TMP=14; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0100 | TMP=14; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0200 | TMP=13; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0300 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0400 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0500 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0600 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMN=11.0
20261002 0700 | TMP=11; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0800 | TMP=13; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0900 | TMP=16; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1000 | TMP=18; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1100 | TMP=19; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1200 | TMP=20; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1300 | TMP=21; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1400 | TMP=21; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1500 | TMP=21; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMX=21.0
20261002 1600 | TMP=21; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1700 | TMP=20; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1800 | TMP=19; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1900 | TMP=17; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 2000 | TMP=16; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 2100 | TMP=16; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 2200 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 2300 | TMP=14; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0000 | TMP=14; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0100 | TMP=13; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0200 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0300 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0400 | TMP=11; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0500 | TMP=11; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0600 | TMP=11; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMN=10.0
20261003 0700 | TMP=11; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0800 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0900 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 1000 | TMP=17; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261003 1100 | TMP=19; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1200 | TMP=20; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1300 | TMP=21; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1400 | TMP=22; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1500 | TMP=22; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음; TMX=22.0
20261003 1600 | TMP=22; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1700 | TMP=22; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1800 | TMP=20; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1900 | TMP=19; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 2000 | TMP=18; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 2100 | TMP=17; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 2200 | TMP=16; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 2300 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261004 0000 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261004 0300 | TMP=15; SKY=1; PTY=0; POP=0; PCP=0; SNO=0
20261004 0600 | TMP=15; SKY=3; PTY=0; POP=20; PCP=0; SNO=0; TMN=14.0
20261004 0900 | TMP=17; SKY=3; PTY=0; POP=20; PCP=0; SNO=0
20261004 1200 | TMP=21; SKY=1; PTY=0; POP=10; PCP=0; SNO=0
20261004 1500 | TMP=23; SKY=3; PTY=0; POP=10; PCP=0; SNO=0; TMX=23.0
20261004 1800 | TMP=20; SKY=3; PTY=0; POP=10; PCP=0; SNO=0
20261004 2100 | TMP=18; SKY=3; PTY=0; POP=20; PCP=0; SNO=0
20261005 0000 | TMP=17; SKY=3; PTY=0; POP=20; PCP=0; SNO=0
`,
  ),
  /** The same day's 02:00 issuance, the first 170 rows: 03:00 to 16:00, with TMN at 06 and TMX at 15. */
  morning: shortForecast(
    { baseDate: "20261001", baseTime: "0200", nx: 60, ny: 127 },
    { numOfRows: 170, totalCount: 944 },
    `
20261001 0300 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 0400 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 0500 | TMP=14; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 0600 | TMP=13; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMN=13.0
20261001 0700 | TMP=13; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 0800 | TMP=14; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 0900 | TMP=16; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1000 | TMP=18; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1100 | TMP=19; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1200 | TMP=20; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1300 | TMP=21; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1400 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1500 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMX=22.0
20261001 1600 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
`,
  ),
};

/* ── 서울, 2026-10-01 17:30 KST: the issuance that reaches a fifth day ───────────────────────── */

export const SEOUL_EVENING = {
  now: '{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL_SERVICE"},"body":{"dataType":"JSON","items":{"item":[{"baseDate":"20261001","baseTime":"1700","category":"PTY","nx":60,"ny":127,"obsrValue":"0"},{"baseDate":"20261001","baseTime":"1700","category":"REH","nx":60,"ny":127,"obsrValue":"35"},{"baseDate":"20261001","baseTime":"1700","category":"RN1","nx":60,"ny":127,"obsrValue":"0"},{"baseDate":"20261001","baseTime":"1700","category":"T1H","nx":60,"ny":127,"obsrValue":"21.1"},{"baseDate":"20261001","baseTime":"1700","category":"UUU","nx":60,"ny":127,"obsrValue":"3.3"},{"baseDate":"20261001","baseTime":"1700","category":"VEC","nx":60,"ny":127,"obsrValue":"256"},{"baseDate":"20261001","baseTime":"1700","category":"VVV","nx":60,"ny":127,"obsrValue":"0.8"},{"baseDate":"20261001","baseTime":"1700","category":"WSD","nx":60,"ny":127,"obsrValue":"3.3"}]},"pageNo":1,"numOfRows":1000,"totalCount":8}}}',
  hours: veryShortForecast(
    { baseDate: "20261001", baseTime: "1700", nx: 60, ny: 127 },
    { numOfRows: 100, totalCount: 66 },
    `
20261001 1800 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=19; REH=40; UUU=2.5; VVV=1.4; VEC=241; WSD=3; POP=0
20261001 1900 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=18; REH=45; UUU=1.9; VVV=0.6; VEC=252; WSD=2; POP=0
20261001 2000 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=17; REH=45; UUU=1.8; VVV=-0.5; VEC=288; WSD=2; POP=0
20261001 2100 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=17; REH=40; UUU=1.6; VVV=-1.1; VEC=307; WSD=2; POP=0
20261001 2200 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=16; REH=50; UUU=1.2; VVV=-1; VEC=313; WSD=2; POP=0
20261001 2300 | LGT=0; PTY=0; RN1=강수없음; SKY=1; T1H=15; REH=55; UUU=1.1; VVV=-0.6; VEC=302; WSD=1; POP=0
`,
  ),
  /**
   * 단기예보, base 20261001/1700: 1,052 rows, to midnight after the 5th. Asked for with numOfRows
   * 1000 it came back 1,000 rows long and stopped at noon of the 5th.
   */
  days: shortForecast(
    { baseDate: "20261001", baseTime: "1700", nx: 60, ny: 127 },
    { numOfRows: 1100, totalCount: 1052 },
    `
20261001 1800 | TMP=19; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 1900 | TMP=18; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 2000 | TMP=17; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 2100 | TMP=17; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 2200 | TMP=16; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261001 2300 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0000 | TMP=14; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0100 | TMP=14; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0200 | TMP=13; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0300 | TMP=13; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0400 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0500 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0600 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMN=12.0
20261002 0700 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0800 | TMP=13; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 0900 | TMP=16; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1000 | TMP=17; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1100 | TMP=19; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1200 | TMP=20; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1300 | TMP=21; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1400 | TMP=21; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1500 | TMP=21; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMX=21.0
20261002 1600 | TMP=21; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1700 | TMP=21; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1800 | TMP=19; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1900 | TMP=18; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 2000 | TMP=17; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 2100 | TMP=16; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 2200 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 2300 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0000 | TMP=14; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0100 | TMP=13; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0200 | TMP=13; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0300 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0400 | TMP=12; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0500 | TMP=11; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0600 | TMP=11; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMN=11.0
20261003 0700 | TMP=11; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0800 | TMP=13; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0900 | TMP=15; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 1000 | TMP=17; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261003 1100 | TMP=19; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1200 | TMP=20; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1300 | TMP=22; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1400 | TMP=22; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1500 | TMP=22; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음; TMX=22.0
20261003 1600 | TMP=22; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1700 | TMP=22; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1800 | TMP=20; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1900 | TMP=19; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 2000 | TMP=18; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 2100 | TMP=17; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 2200 | TMP=17; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 2300 | TMP=16; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261004 0000 | TMP=16; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261004 0100 | TMP=15; SKY=1; PTY=0; POP=0; PCP=0; SNO=0
20261004 0200 | TMP=15; SKY=1; PTY=0; POP=0; PCP=0; SNO=0
20261004 0300 | TMP=15; SKY=1; PTY=0; POP=0; PCP=0; SNO=0
20261004 0400 | TMP=15; SKY=1; PTY=0; POP=0; PCP=0; SNO=0
20261004 0500 | TMP=15; SKY=3; PTY=0; POP=20; PCP=0; SNO=0
20261004 0600 | TMP=14; SKY=4; PTY=0; POP=30; PCP=0; SNO=0; TMN=14.0
20261004 0700 | TMP=14; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 0800 | TMP=15; SKY=3; PTY=0; POP=20; PCP=0; SNO=0
20261004 0900 | TMP=17; SKY=3; PTY=0; POP=20; PCP=0; SNO=0
20261004 1000 | TMP=19; SKY=3; PTY=0; POP=20; PCP=0; SNO=0
20261004 1100 | TMP=20; SKY=1; PTY=0; POP=0; PCP=0; SNO=0
20261004 1200 | TMP=22; SKY=1; PTY=0; POP=0; PCP=0; SNO=0
20261004 1300 | TMP=23; SKY=3; PTY=0; POP=20; PCP=0; SNO=0
20261004 1400 | TMP=23; SKY=3; PTY=0; POP=20; PCP=0; SNO=0
20261004 1500 | TMP=23; SKY=1; PTY=0; POP=0; PCP=0; SNO=0; TMX=23.0
20261004 1600 | TMP=23; SKY=3; PTY=0; POP=20; PCP=0; SNO=0
20261004 1700 | TMP=23; SKY=1; PTY=0; POP=0; PCP=0; SNO=0
20261004 1800 | TMP=21; SKY=3; PTY=0; POP=20; PCP=0; SNO=0
20261004 1900 | TMP=20; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 2000 | TMP=19; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 2100 | TMP=19; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 2200 | TMP=18; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 2300 | TMP=18; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261005 0000 | TMP=17; SKY=4; PTY=1; POP=60; PCP=0.4; SNO=0
20261005 0300 | TMP=16; SKY=4; PTY=1; POP=70; PCP=2; SNO=0
20261005 0600 | TMP=15; SKY=3; PTY=0; POP=20; PCP=0; SNO=0; TMN=15.0
20261005 0900 | TMP=16; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261005 1200 | TMP=19; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261005 1500 | TMP=21; SKY=3; PTY=0; POP=20; PCP=0; SNO=0; TMX=21.0
20261005 1800 | TMP=18; SKY=1; PTY=0; POP=10; PCP=0; SNO=0
20261005 2100 | TMP=15; SKY=1; PTY=0; POP=10; PCP=0; SNO=0
20261006 0000 | TMP=13; SKY=1; PTY=0; POP=0; PCP=0; SNO=0
`,
  ),
  /** The 02:00 issuance of the same day is `SEOUL_AFTERNOON.morning`. */
};

/* ── cell (1, 1): open sea, 2026-10-02 01:10 KST ───────────────────────────────────────────── */

export const OPEN_SEA = {
  /** Nothing is observed there, and the hub says so with -999, -998 and -998.9. */
  now: '{"response":{"header":{"resultCode":"00","resultMsg":"NORMAL_SERVICE"},"body":{"dataType":"JSON","items":{"item":[{"baseDate":"20261002","baseTime":"0100","category":"PTY","nx":1,"ny":1,"obsrValue":"0"},{"baseDate":"20261002","baseTime":"0100","category":"REH","nx":1,"ny":1,"obsrValue":"-998"},{"baseDate":"20261002","baseTime":"0100","category":"RN1","nx":1,"ny":1,"obsrValue":"-998.9"},{"baseDate":"20261002","baseTime":"0100","category":"T1H","nx":1,"ny":1,"obsrValue":"-999"},{"baseDate":"20261002","baseTime":"0100","category":"UUU","nx":1,"ny":1,"obsrValue":"-998.9"},{"baseDate":"20261002","baseTime":"0100","category":"VEC","nx":1,"ny":1,"obsrValue":"-998"},{"baseDate":"20261002","baseTime":"0100","category":"VVV","nx":1,"ny":1,"obsrValue":"-998.9"},{"baseDate":"20261002","baseTime":"0100","category":"WSD","nx":1,"ny":1,"obsrValue":"-998.9"}]},"pageNo":1,"numOfRows":1000,"totalCount":8}}}',
  hours: veryShortForecast(
    { baseDate: "20261002", baseTime: "0000", nx: 1, ny: 1 },
    { numOfRows: 100, totalCount: 66 },
    `
20261002 0100 | LGT=0; PTY=0; RN1=강수없음; SKY=3; T1H=23; REH=65; UUU=-4; VVV=-7.6; VEC=28; WSD=9; POP=20
20261002 0200 | LGT=0; PTY=0; RN1=강수없음; SKY=4; T1H=23; REH=70; UUU=-3.9; VVV=-7.5; VEC=28; WSD=9; POP=30
20261002 0300 | LGT=0; PTY=0; RN1=강수없음; SKY=3; T1H=23; REH=70; UUU=-3.8; VVV=-7.6; VEC=27; WSD=9; POP=20
20261002 0400 | LGT=0; PTY=0; RN1=강수없음; SKY=4; T1H=23; REH=70; UUU=-3.9; VVV=-7.8; VEC=27; WSD=9; POP=30
20261002 0500 | LGT=0; PTY=0; RN1=강수없음; SKY=4; T1H=23; REH=70; UUU=-4; VVV=-7.6; VEC=28; WSD=9; POP=30
20261002 0600 | LGT=0; PTY=0; RN1=강수없음; SKY=4; T1H=23; REH=65; UUU=-4; VVV=-7.6; VEC=28; WSD=9; POP=30
`,
  ),
  days: shortForecast(
    { baseDate: "20261001", baseTime: "2300", nx: 1, ny: 1 },
    { numOfRows: 1100, totalCount: 980 },
    `
20261002 0000 | TMP=23; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261002 0100 | TMP=23; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261002 0200 | TMP=23; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261002 0300 | TMP=23; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261002 0400 | TMP=23; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261002 0500 | TMP=23; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261002 0600 | TMP=23; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음; TMN=23.0
20261002 0700 | TMP=23; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261002 0800 | TMP=23; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261002 0900 | TMP=23; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261002 1000 | TMP=23; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261002 1100 | TMP=23; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1200 | TMP=23; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261002 1300 | TMP=23; SKY=3; PTY=0; POP=20; PCP=강수없음; SNO=적설없음
20261002 1400 | TMP=23; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261002 1500 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMX=23.0
20261002 1600 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1700 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1800 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 1900 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 2000 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 2100 | TMP=23; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 2200 | TMP=23; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261002 2300 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0000 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0100 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0200 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0300 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0400 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0500 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0600 | TMP=22; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음; TMN=22.0
20261003 0700 | TMP=23; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0800 | TMP=23; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 0900 | TMP=23; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 1000 | TMP=23; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 1100 | TMP=23; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 1200 | TMP=23; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 1300 | TMP=23; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 1400 | TMP=24; SKY=1; PTY=0; POP=0; PCP=강수없음; SNO=적설없음
20261003 1500 | TMP=24; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음; TMX=24.0
20261003 1600 | TMP=24; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1700 | TMP=24; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1800 | TMP=24; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 1900 | TMP=24; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 2000 | TMP=25; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 2100 | TMP=25; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 2200 | TMP=25; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261003 2300 | TMP=25; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261004 0000 | TMP=25; SKY=4; PTY=0; POP=30; PCP=강수없음; SNO=적설없음
20261004 0100 | TMP=25; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 0200 | TMP=25; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 0300 | TMP=25; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 0400 | TMP=24; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 0500 | TMP=24; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 0600 | TMP=24; SKY=4; PTY=0; POP=30; PCP=0; SNO=0; TMN=23.0
20261004 0700 | TMP=23; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 0800 | TMP=23; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 0900 | TMP=23; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 1000 | TMP=23; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 1100 | TMP=23; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 1200 | TMP=23; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 1300 | TMP=23; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 1400 | TMP=23; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 1500 | TMP=24; SKY=4; PTY=0; POP=30; PCP=0; SNO=0; TMX=24.0
20261004 1600 | TMP=24; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 1700 | TMP=24; SKY=3; PTY=0; POP=20; PCP=0; SNO=0
20261004 1800 | TMP=24; SKY=3; PTY=0; POP=20; PCP=0; SNO=0
20261004 1900 | TMP=24; SKY=1; PTY=0; POP=0; PCP=0; SNO=0
20261004 2000 | TMP=24; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 2100 | TMP=24; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 2200 | TMP=24; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261004 2300 | TMP=24; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261005 0000 | TMP=24; SKY=4; PTY=0; POP=30; PCP=0; SNO=0
20261005 0300 | TMP=23; SKY=4; PTY=1; POP=60; PCP=1; SNO=0
20261005 0600 | TMP=24; SKY=4; PTY=1; POP=60; PCP=1; SNO=0; TMN=23.0
20261005 0900 | TMP=23; SKY=3; PTY=0; POP=10; PCP=0; SNO=0
20261005 1200 | TMP=22; SKY=1; PTY=0; POP=0; PCP=0; SNO=0
20261005 1500 | TMP=22; SKY=1; PTY=0; POP=10; PCP=0; SNO=0; TMX=22.0
20261005 1800 | TMP=22; SKY=1; PTY=0; POP=10; PCP=0; SNO=0
20261005 2100 | TMP=22; SKY=3; PTY=0; POP=20; PCP=0; SNO=0
20261006 0000 | TMP=21; SKY=3; PTY=0; POP=10; PCP=0; SNO=0
`,
  ),
};
