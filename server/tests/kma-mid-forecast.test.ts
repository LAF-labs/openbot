import { describe, expect, test } from "bun:test";
import { weatherOf as readForTheCard } from "../../shared/weather";
import { midDaysOf, midIssuanceAt } from "../src/plugins/kma-mid-forecast";
import type { KmaMidRegions } from "../src/plugins/kma-mid-regions";
import {
  AFTERNOON,
  answerOf,
  connection,
  EVENING,
  kst,
  MIDNIGHT,
  type Portal,
  SEOUL,
  type Served,
  weatherOver,
} from "./support/kma-hub";
import {
  MID_KEY_NOT_REGISTERED,
  MID_LAND_0600,
  MID_LAND_1800,
  MID_TEMPERATURE_0600,
  MID_TEMPERATURE_1800,
} from "./support/kma-mid-fixtures";

/**
 * Days five to ten, against what the public data portal actually answers.
 *
 * NO LIVE PORTAL HERE, for the hub tests' reason. What is live is in the fixtures: every body in
 * `support/kma-mid-fixtures.ts` came back from apis.data.go.kr on 2026-10-04. A 중기예보 body does
 * not say which issuance it is — its days are numbers counted from the date it was asked for — so
 * the same real bodies are served here under whichever issuance a test's clock asks for, beside the
 * hub's bodies of 2026-10-01 and 10-02 that the 단기예보 tests use. The dates in an answer are
 * therefore the test's and the values are 기상청's.
 *
 * Where a test needs weather that did not happen that week — rain, snow — the row is written by
 * hand in the service's shape, and the test says so.
 */

/** The hub's key, and a portal key in the encoded spelling the fleet plants: it must go out as written. */
const HUB_KEY = "HubKey0123456789";
const PORTAL_KEY = "Portal%2BKey%2F0123456789%3D%3D";

/** The two regions every place in these tests is in. The table that decides it has its own tests. */
const SEOUL_REGIONS: KmaMidRegions = {
  size: 1,
  of: () => ({ temperature: "11B10101", land: "11B00000", name: "서울" }),
};

/** Both of an issuance's real bodies, under the issuance a test's clock asks for. */
const evening = (tmFc: string): Record<string, string> => ({
  [`temperature ${tmFc}`]: MID_TEMPERATURE_1800,
  [`land ${tmFc}`]: MID_LAND_1800,
});
const morning = (tmFc: string): Record<string, string> => ({
  [`temperature ${tmFc}`]: MID_TEMPERATURE_0600,
  [`land ${tmFc}`]: MID_LAND_0600,
});

/**
 * A transport over the fake hub and the fake portal (`support/kma-hub.ts`), the clock it reads, and
 * what the PORTAL was asked — the hub's side of it has its own file.
 *
 * With no table of names (the forecast should not change when 기상청 re-issues its spreadsheet) and
 * one fixed pair of regions.
 */
function stack(
  hub: Served,
  portal: Portal | null,
  options: {
    at?: Date;
    serviceKey?: string | null;
    regions?: KmaMidRegions;
  } = {},
) {
  const serviceKey =
    options.serviceKey === null
      ? undefined
      : (options.serviceKey ?? PORTAL_KEY);
  const made = weatherOver(
    { hub, portal },
    {
      authKey: HUB_KEY,
      ...(serviceKey ? { serviceKey } : {}),
      midRegions: options.regions ?? SEOUL_REGIONS,
      ...(options.at ? { at: options.at } : {}),
    },
  );
  return {
    transport: made.transport,
    asked: made.askedOfPortal,
    clock: made.clock,
  };
}

type Day = {
  date: string;
  day: string;
  when?: string;
  min: number | null;
  max: number | null;
  am?: string;
  pm?: string;
  allDay?: string;
  precip?: string;
};
type Facts = {
  issued: { days?: string; later?: string };
  days?: Day[];
  unavailable?: string[];
};

/** The answer as this file reads it: the days, and which issuance each came from. */
async function weatherOf(
  made: ReturnType<typeof stack>,
  where: { latitude: number; longitude: number } = SEOUL,
) {
  const { facts, text } = await answerOf<Facts>(made, where);
  return { facts, text };
}

const datesOf = (facts: Facts) => (facts.days ?? []).map((day) => day.date);

describe("the issuance to ask for", () => {
  test("06:00 and 18:00 in Korea, each from ten past", () => {
    expect(midIssuanceAt(kst("2026-10-04T06:09:59")).tmFc).toBe("202610031800");
    expect(midIssuanceAt(kst("2026-10-04T06:10:00")).tmFc).toBe("202610040600");
    expect(midIssuanceAt(kst("2026-10-04T18:09:59")).tmFc).toBe("202610040600");
    expect(midIssuanceAt(kst("2026-10-04T18:10:00")).tmFc).toBe("202610041800");
  });

  test("past midnight it is still last evening's, and its days are counted from last evening's date", () => {
    const issuance = midIssuanceAt(kst("2026-10-05T00:30:00"));
    expect(issuance.tmFc).toBe("202610041800");
    expect(issuance.date).toBe("20261004");
  });

  test("the first minutes of a year ask for the last evening of the one before", () => {
    expect(midIssuanceAt(kst("2027-01-01T00:05:00")).tmFc).toBe("202612311800");
  });

  test("stepping back is one whole issuance, across midnight too", () => {
    expect(midIssuanceAt(kst("2026-10-04T19:00:00"), 1).tmFc).toBe(
      "202610040600",
    );
    expect(midIssuanceAt(kst("2026-10-04T07:00:00"), 1).tmFc).toBe(
      "202610031800",
    );
  });

  test("an instant is read as the Korean wall clock it is, and its issuance is the newest until the next is due", () => {
    const issuance = midIssuanceAt(new Date("2026-10-04T09:30:00Z"));
    expect(issuance.tmFc).toBe("202610041800");
    expect(new Date(issuance.supersededAt).toISOString()).toBe(
      // 06:10 on the 5th in Korea.
      "2026-10-04T21:10:00.000Z",
    );
  });
});

describe("the days two rows hold", () => {
  const rowOf = (body: string) =>
    (
      JSON.parse(body) as {
        response: { body: { items: { item: [Record<string, unknown>] } } };
      }
    ).response.body.items.item[0];
  const issued = (body: string, tmFc: string) => ({
    tmFc,
    date: tmFc.slice(0, 8),
    row: rowOf(body),
  });

  test("the evening issuance begins five days after its date, the morning one four", () => {
    const fromEvening = midDaysOf(
      issued(MID_TEMPERATURE_1800, "202610041800"),
      issued(MID_LAND_1800, "202610041800"),
    );
    expect(fromEvening.map((day) => day.date)).toEqual([
      "20261009",
      "20261010",
      "20261011",
      "20261012",
      "20261013",
      "20261014",
    ]);
    const fromMorning = midDaysOf(
      issued(MID_TEMPERATURE_0600, "202610040600"),
      issued(MID_LAND_0600, "202610040600"),
    );
    expect(fromMorning[0]).toEqual({
      date: "20261008",
      min: 10,
      max: 25,
      am: "맑음 10%",
      pm: "맑음 10%",
    });
    expect(fromMorning).toHaveLength(7);
  });

  test("to the seventh day a morning and an afternoon; from the eighth one sky for the day", () => {
    const days = midDaysOf(
      issued(MID_TEMPERATURE_1800, "202610041800"),
      issued(MID_LAND_1800, "202610041800"),
    );
    expect(days[0]).toEqual({
      date: "20261009",
      min: 11,
      max: 25,
      am: "맑음 10%",
      pm: "맑음 10%",
    });
    expect(days[3]).toEqual({
      date: "20261012",
      min: 14,
      max: 25,
      allDay: "구름많음 20%",
    });
    // The uncertainty bands (`taMin5Low`, `taMax5High`) are not days and are not read.
    expect(JSON.stringify(days)).not.toContain("Low");
  });

  test("rain and snow, in the service's own wording: the sky in the card's words, what falls beside it", () => {
    // Hand-written in the service's shape: the week measured was dry.
    const days = midDaysOf(null, {
      tmFc: "202610041800",
      date: "20261004",
      row: {
        wf5Am: "흐리고 비",
        wf5Pm: "구름많음",
        rnSt5Am: 70,
        rnSt5Pm: 30,
        wf6Am: "구름많고 비/눈",
        wf6Pm: "흐리고 눈",
        rnSt6Am: 60,
        rnSt6Pm: 80,
        wf8: "흐리고 소나기",
        rnSt8: 60,
      },
    });
    expect(days).toEqual([
      {
        date: "20261009",
        min: null,
        max: null,
        am: "흐림 70%",
        pm: "구름많음 30%",
        precip: "비(오전)",
      },
      {
        date: "20261010",
        min: null,
        max: null,
        am: "구름많음 60%",
        pm: "흐림 80%",
        precip: "비/눈·눈(오전·오후)",
      },
      {
        date: "20261012",
        min: null,
        max: null,
        allDay: "흐림 60%",
        precip: "소나기",
      },
    ]);
  });

  test("the two rows are joined by the day they are about, when they are of different issuances", () => {
    // The temperatures of the morning (from four days on), the land forecast of the evening (five).
    const days = midDaysOf(
      issued(MID_TEMPERATURE_0600, "202610040600"),
      issued(MID_LAND_1800, "202610041800"),
    );
    expect(days[0]).toEqual({ date: "20261008", min: 10, max: 25 });
    expect(days[1]).toEqual({
      date: "20261009",
      min: 11,
      max: 25,
      am: "맑음 10%",
      pm: "맑음 10%",
    });
  });

  test("neither row is no days", () => {
    expect(midDaysOf(null, null)).toEqual([]);
  });
});

describe("what a Bot is handed, on a deployment with the portal's key", () => {
  test("서울 at a quarter to one: four days of 단기예보 and the six after them, with no day twice", async () => {
    const made = stack(MIDNIGHT, evening("202610011800"));
    const { facts, text } = await weatherOf(made);

    expect(datesOf(facts)).toEqual([
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
    // The fifth day on is its weekday and its date: 그글피 is as far as the words go.
    expect(facts.days?.[4]).toEqual({
      date: "2026-10-06",
      day: "화",
      when: "그글피",
      min: 11,
      max: 25,
      am: "맑음 10%",
      pm: "맑음 10%",
    });
    expect(facts.days?.[5]).toEqual({
      date: "2026-10-07",
      day: "수",
      min: 13,
      max: 25,
      am: "맑음 10%",
      pm: "맑음 10%",
    });
    expect(facts.days?.[7]).toEqual({
      date: "2026-10-09",
      day: "금",
      min: 14,
      max: 25,
      allDay: "구름많음 20%",
    });
    expect(facts.issued).toMatchObject({
      days: "10-01 23:00",
      later: "10-01 18:00",
    });
    expect(facts.unavailable).toBeUndefined();
    // Ten days and the six hours: still a small answer.
    expect(text.length).toBeLessThan(1_800);
  });

  test("the portal is asked twice — the 시·군's temperatures and the broad region's sky — with the key as written", async () => {
    const made = stack(MIDNIGHT, evening("202610011800"));
    await weatherOf(made);

    expect(
      made.asked.map(({ operation, regId, tmFc }) => ({
        operation,
        regId,
        tmFc,
      })),
    ).toEqual([
      { operation: "temperature", regId: "11B10101", tmFc: "202610011800" },
      { operation: "land", regId: "11B00000", tmFc: "202610011800" },
    ]);
    for (const { url, init } of made.asked) {
      // Encoded again, %2B is %252B: a key nobody registered.
      expect(url).toContain(`?serviceKey=${PORTAL_KEY}&`);
      expect(url).toContain("dataType=JSON");
      // The key rides on the query string, so a redirect is never followed.
      expect(init?.redirect).toBe("manual");
      expect(init?.method).toBe("GET");
    }
  });

  test("the card reads all of them: a whole-day sky is the day's sky", async () => {
    const { text } = await weatherOf(stack(MIDNIGHT, evening("202610011800")));
    const card = readForTheCard(text);
    expect(card?.days).toHaveLength(10);
    expect(card?.days[5]).toEqual({
      date: "2026-10-07",
      min: 13,
      max: 25,
      sky: "clear",
      chance: 10,
      falls: null,
    });
    expect(card?.days[7]).toEqual({
      date: "2026-10-09",
      min: 14,
      max: 25,
      sky: "cloudy",
      chance: 20,
      falls: null,
    });
  });

  test("a wet day past the fourth is drawn wet", async () => {
    // Hand-written land row, in the service's shape.
    const wet = JSON.stringify({
      response: {
        header: { resultCode: "00", resultMsg: "NORMAL_SERVICE" },
        body: {
          items: {
            item: [
              {
                regId: "11B00000",
                wf5Am: "구름많음",
                wf5Pm: "흐리고 비",
                rnSt5Am: 30,
                rnSt5Pm: 70,
                wf8: "흐리고 눈",
                rnSt8: 60,
              },
            ],
          },
        },
      },
    });
    const { facts, text } = await weatherOf(
      stack(MIDNIGHT, {
        "temperature 202610011800": MID_TEMPERATURE_1800,
        "land 202610011800": wet,
      }),
    );
    expect(facts.days?.[4]).toMatchObject({
      am: "구름많음 30%",
      pm: "흐림 70%",
      precip: "비(오후)",
    });
    const card = readForTheCard(text);
    expect(card?.days[4]).toMatchObject({
      sky: "overcast",
      chance: 70,
      falls: "rain",
    });
    expect(card?.days[7]).toMatchObject({ sky: "overcast", falls: "snow" });
  });

  test("the morning issuance starts a day sooner, and joins where that afternoon's 단기예보 ends", async () => {
    const made = stack(AFTERNOON, morning("202610010600"), {
      at: kst("2026-10-01T14:50:00"),
    });
    const { facts } = await weatherOf(made);
    // 단기예보 of 14:00 reaches the 4th; 중기예보 of 06:00 begins at the 5th.
    expect(datesOf(facts)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
    expect(facts.days?.[4]).toMatchObject({ when: "그글피", min: 10, max: 25 });
    expect(facts.issued.later).toBe("10-01 06:00");
  });

  test("where both forecasts have a day, 단기예보's is the one said", async () => {
    // Half past five: the 17:00 단기예보 reaches the 5th, and so does that morning's 중기예보.
    const made = stack(EVENING, morning("202610010600"), {
      at: kst("2026-10-01T17:30:00"),
    });
    const { facts } = await weatherOf(made);
    const dates = datesOf(facts);
    expect(new Set(dates).size).toBe(dates.length);
    const fifth = facts.days?.find((day) => day.date === "2026-10-05");
    // The row 단기예보 writes always says whether anything falls; 중기예보's only when something does.
    expect(fifth?.precip).toBeDefined();
    expect(fifth?.min).not.toBe(10);
    expect(dates.at(-1)).toBe("2026-10-11");
  });

  test("an issuance already kept is not asked for again", async () => {
    const made = stack(MIDNIGHT, evening("202610011800"));
    await weatherOf(made);
    await weatherOf(made);
    expect(made.asked).toHaveLength(2);
  });
});

describe("an issuance the portal has not published", () => {
  test("is stepped back from, once, to the one before", async () => {
    const made = stack(MIDNIGHT, morning("202610010600"));
    const { facts } = await weatherOf(made);

    expect(
      made.asked.map(({ operation, tmFc }) => `${operation} ${tmFc}`).sort(),
    ).toEqual([
      "land 202610010600",
      "land 202610011800",
      "temperature 202610010600",
      "temperature 202610011800",
    ]);
    // The morning's fourth day is one 단기예보 already has; the rest are the same six days.
    expect(datesOf(facts).slice(4)).toEqual([
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
    expect(facts.issued.later).toBe("10-01 06:00");
  });

  test("neither one out: the four days are answered and the rest are named as not had", async () => {
    const made = stack(MIDNIGHT, {});
    const { facts } = await weatherOf(made);
    expect(datesOf(facts)).toHaveLength(4);
    expect(facts.unavailable).toEqual(["5~10일 뒤 예보"]);
    expect(facts.issued.later).toBeUndefined();
  });
});

describe("a portal that does not answer", () => {
  test("a key the service does not know: the four days, the rest named, and no word of the key", async () => {
    const made = stack(
      MIDNIGHT,
      () => new Response(MID_KEY_NOT_REGISTERED, { status: 403 }),
    );
    const { facts, text } = await weatherOf(made);

    expect(datesOf(facts)).toEqual([
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
    ]);
    expect(facts.unavailable).toEqual(["5~10일 뒤 예보"]);
    expect(text).not.toContain(PORTAL_KEY);
    expect(text).not.toContain(decodeURIComponent(PORTAL_KEY));
    expect(text).not.toContain("SERVICE_KEY");
    // The card is still drawn: the answer is a forecast.
    expect(readForTheCard(text)?.days).toHaveLength(4);
  });

  test("it is not asked again for ten minutes, and then it is", async () => {
    const made = stack(
      MIDNIGHT,
      () => new Response(MID_KEY_NOT_REGISTERED, { status: 403 }),
    );
    await weatherOf(made);
    expect(made.asked).toHaveLength(2);

    made.clock.at = kst("2026-10-02T00:54:00");
    const { facts } = await weatherOf(made);
    expect(made.asked).toHaveLength(2);
    expect(facts.unavailable).toEqual(["5~10일 뒤 예보"]);

    made.clock.at = kst("2026-10-02T00:56:00");
    await weatherOf(made);
    expect(made.asked).toHaveLength(4);
  });

  test("the gateway's refusal in XML is the same refusal", async () => {
    const made = stack(
      MIDNIGHT,
      () =>
        new Response(
          "<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>",
          { status: 200 },
        ),
    );
    const first = await weatherOf(made);
    expect(first.facts.unavailable).toEqual(["5~10일 뒤 예보"]);
    await weatherOf(made);
    expect(made.asked).toHaveLength(2);
  });

  test("unreachable: the four days are answered, and it is tried again two minutes on — not on every call", async () => {
    const made = stack(MIDNIGHT, () => {
      throw new Error(`failed to fetch ?serviceKey=${PORTAL_KEY}`);
    });
    const { facts, text } = await weatherOf(made);
    expect(datesOf(facts)).toHaveLength(4);
    expect(facts.unavailable).toEqual(["5~10일 뒤 예보"]);
    expect(text).not.toContain(PORTAL_KEY);
    expect(made.asked).toHaveLength(2);

    // A portal that hangs would otherwise cost every answer its whole bound.
    made.clock.at = kst("2026-10-02T00:46:30");
    const resting = await weatherOf(made);
    expect(made.asked).toHaveLength(2);
    expect(resting.facts.unavailable).toEqual(["5~10일 뒤 예보"]);

    made.clock.at = kst("2026-10-02T00:47:30");
    await weatherOf(made);
    expect(made.asked).toHaveLength(4);
  });

  test("the service's own refusal of the key rests the portal as the gateway's does", async () => {
    // The gateway's envelope is the one that was measured; this is the service's documented one.
    const made = stack(
      MIDNIGHT,
      () =>
        new Response(
          JSON.stringify({
            response: {
              header: {
                resultCode: "30",
                resultMsg: "SERVICE KEY IS NOT REGISTERED ERROR.",
              },
            },
          }),
          { status: 200 },
        ),
    );
    await weatherOf(made);
    await weatherOf(made);
    expect(made.asked).toHaveLength(2);
  });

  test("a place already read keeps its week while the portal rests over another place", async () => {
    let refusing = false;
    const made = stack(
      MIDNIGHT,
      (asked) =>
        refusing
          ? new Response(MID_KEY_NOT_REGISTERED, { status: 403 })
          : new Response(
              asked.operation === "temperature"
                ? MID_TEMPERATURE_1800
                : MID_LAND_1800,
              { status: 200 },
            ),
      {
        // Two places in two regions: the cell says which.
        regions: {
          size: 2,
          of: (cell) =>
            cell.ny > 100
              ? { temperature: "11B10101", land: "11B00000", name: "서울" }
              : { temperature: "11H20201", land: "11H20000", name: "부산" },
        },
      },
    );
    expect(datesOf((await weatherOf(made)).facts)).toHaveLength(10);

    refusing = true;
    const busan = await weatherOf(made, {
      latitude: 35.1796,
      longitude: 129.0756,
    });
    expect(busan.facts.unavailable).toEqual(["5~10일 뒤 예보"]);
    expect(made.asked).toHaveLength(4);

    // 서울's two rows are kept until the next issuance: the rest is on asking, not on answering.
    const seoul = await weatherOf(made);
    expect(datesOf(seoul.facts)).toHaveLength(10);
    expect(seoul.facts.unavailable).toBeUndefined();
    expect(made.asked).toHaveLength(4);
  });

  test("a page that is not the service's, a result code that is not good, an answer far too large: all the same", async () => {
    for (const reply of [
      () => new Response("<html>점검 중입니다</html>", { status: 200 }),
      () =>
        new Response(
          JSON.stringify({
            response: {
              header: {
                resultCode: "99",
                resultMsg: "최대 조회 기간은 오늘 기준으로 1일 전까지입니다.",
              },
            },
          }),
          { status: 200 },
        ),
      () => new Response("x".repeat(100_001), { status: 200 }),
      () =>
        new Response("", {
          status: 302,
          headers: { location: "https://elsewhere.example/" },
        }),
    ]) {
      const { facts } = await weatherOf(stack(MIDNIGHT, reply));
      expect(datesOf(facts)).toHaveLength(4);
      expect(facts.unavailable).toEqual(["5~10일 뒤 예보"]);
    }
  });

  test("a day neither forecast has is named, not left out between two rows", async () => {
    // Hand-written: temperatures that begin six days after the issuance, as no real body does —
    // the gap a late 단기예보 leaves beside an evening 중기예보, a day wide.
    const late = JSON.stringify({
      response: {
        header: { resultCode: "00", resultMsg: "NORMAL_SERVICE" },
        body: {
          items: { item: [{ regId: "11B10101", taMin6: 13, taMax6: 25 }] },
        },
      },
    });
    const { facts } = await weatherOf(
      stack(MIDNIGHT, { "temperature 202610011800": late }),
    );
    expect(datesOf(facts)).toEqual([
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-07",
    ]);
    expect(facts.unavailable).toEqual(["10월 6일 예보"]);
  });

  test("only the land forecast missing: the days are their temperatures", async () => {
    const { facts, text } = await weatherOf(
      stack(MIDNIGHT, { "temperature 202610011800": MID_TEMPERATURE_1800 }),
    );
    expect(facts.days?.[5]).toEqual({
      date: "2026-10-07",
      day: "수",
      min: 13,
      max: 25,
    });
    expect(facts.unavailable).toBeUndefined();
    expect(readForTheCard(text)?.days[5]).toMatchObject({
      sky: null,
      chance: null,
    });
  });
});

describe("where there is nothing to ask", () => {
  test("a deployment without the portal's key asks it nothing, and its tool says three or four days", async () => {
    const made = stack(MIDNIGHT, null, { serviceKey: null });
    const { facts } = await weatherOf(made);
    expect(made.asked).toEqual([]);
    expect(datesOf(facts)).toHaveLength(4);
    // Not a part that failed: there is nothing here to have.
    expect(facts.unavailable).toBeUndefined();

    const [tool] = await made.transport.listTools(connection);
    expect(tool?.description).toContain("오늘부터 3~4일 뒤까지 날짜별 예보");
    expect(tool?.description).not.toContain("열흘");
  });

  test("with the key, the tool says how far it reaches", async () => {
    const [tool] = await stack(MIDNIGHT, {}).transport.listTools(connection);
    expect(tool?.description).toContain(
      "오늘부터 최대 열흘 뒤까지 날짜별 예보",
    );
  });

  test("a place in no region — out at sea — is asked nothing, and the days after are named", async () => {
    const made = stack(MIDNIGHT, null, {
      regions: { size: 0, of: () => null },
    });
    const { facts } = await weatherOf(made);
    expect(made.asked).toEqual([]);
    expect(facts.unavailable).toEqual(["5~10일 뒤 예보"]);
  });
});
