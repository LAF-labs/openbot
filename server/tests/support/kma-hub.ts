import { expect } from "bun:test";
import {
  KMA_MID_OPERATIONS,
  type KmaMidOperation,
} from "../../src/plugins/kma-mid-forecast";
import { createKmaPlaces } from "../../src/plugins/kma-places";
import {
  createKmaWeatherTransport,
  KMA_HOST,
  KMA_OPERATIONS,
  type KmaOperation,
} from "../../src/plugins/kma-weather-rest";
import type { VendorTransport } from "../../src/plugins/transport";
import { stubFetch } from "./fetch";
import {
  NO_DATA_BODY,
  SEOUL_AFTERNOON,
  SEOUL_EVENING,
  SEOUL_MIDNIGHT,
} from "./kma-fixtures";
import { MID_NO_DATA } from "./kma-mid-fixtures";

/**
 * 기상청, faked once: the API hub the weather tool reads, and the public data portal behind the
 * days past the 단기예보.
 *
 * THREE FILES EACH HAD THEIR OWN — `hub` in `kma-weather-rest.test.ts`, `fakeHub` in
 * `kma-weather-entry.test.ts`, `stack` in `kma-mid-forecast.test.ts` — and they were the same fake
 * written three times: an address read back into the operation it is, a body served for the
 * issuance it is, and the vendor's own NO_DATA for anything else. The clock helper and the three
 * tables of real bodies were copied beside them. What stays in each file is what is that file's:
 * its keys, the shape of the facts it reads, and which door's questions it looks at.
 *
 * THE FAKE ANSWERS A BODY ONLY FOR THE ISSUANCE THAT BODY IS, and NO_DATA for any other, which is
 * what the real one does. So a test that passes has asked for the right base time.
 */

/** A KST wall-clock time as the instant it is. */
export const kst = (text: string) => new Date(`${text}+09:00`);

export const SEOUL = { latitude: 37.5665, longitude: 126.978 };

/** Bodies by the issuance each one is: `"now 20261002/0000"`. Anything else is not issued yet. */
export type Served = Record<string, string>;

/** The hub's real bodies (`kma-fixtures.ts`), under the issuances they were served as. */
export const MIDNIGHT: Served = {
  "now 20261002/0000": SEOUL_MIDNIGHT.now,
  "hours 20261002/0030": SEOUL_MIDNIGHT.hours,
  "days 20261001/2300": SEOUL_MIDNIGHT.days,
};
export const AFTERNOON: Served = {
  "now 20261001/1400": SEOUL_AFTERNOON.now,
  "hours 20261001/1430": SEOUL_AFTERNOON.hours,
  "days 20261001/1400": SEOUL_AFTERNOON.days,
  "days 20261001/0200": SEOUL_AFTERNOON.morning,
};
export const EVENING: Served = {
  "now 20261001/1700": SEOUL_EVENING.now,
  "hours 20261001/1730": SEOUL_EVENING.hours,
  "days 20261001/1700": SEOUL_EVENING.days,
  "days 20261001/0200": SEOUL_AFTERNOON.morning,
};

/** Who every call in these files is for. It does not say where the answer goes: drawn nowhere. */
export const unsaid = { url: KMA_HOST, actorId: "person-1", botId: "bot-1" };
/** A call made in a conversation: its row is drawn there, and the forecast as a card on it. */
export const connection = { ...unsaid, drawnOn: "conversation" as const };

/** One request to the hub, as the tests read it back. */
export type Asked = {
  operation: KmaOperation;
  issuance: string;
  rows: number;
  cell: string;
  url: string;
  init: RequestInit | undefined;
};

type AskedOfPortal = {
  operation: KmaMidOperation;
  regId: string | null;
  tmFc: string | null;
  url: string;
  init: RequestInit | undefined;
};

/** What the hub serves: bodies by issuance, or whatever a function answers. */
type Hub = Served | ((asked: Asked) => Response | Promise<Response>);

/** What the portal serves: a body by `"temperature 202610011800"`, or whatever a function answers. */
export type Portal =
  | Record<string, string>
  | ((asked: AskedOfPortal) => Response | Promise<Response>);

export const noData = () => new Response(NO_DATA_BODY, { status: 200 });

/** Which of a service's operations an address is, or undefined when it is none of them. */
function operationAt<Operation extends string>(
  addresses: Readonly<Record<Operation, string>>,
  href: string,
): Operation | undefined {
  for (const [operation, address] of Object.entries<string>(addresses)) {
    if (href.startsWith(`${address}?`)) return operation as Operation;
  }
  return undefined;
}

/**
 * The two doors as one `fetch`, and what each was asked.
 *
 * `portal` is null (or left out) for a test in which the portal must not be asked at all: asking
 * it then is a thrown error, which the weather takes as the portal not answering. An address that
 * is neither door's is thrown the same way — nothing here answers for a host nobody named.
 *
 * `cells` is the hub's requests again, as the grid cell of each: what a test about WHERE reads.
 */
export function fakeKma(hub: Hub, portal?: Portal | null) {
  const asked: Asked[] = [];
  const askedOfPortal: AskedOfPortal[] = [];
  const cells: string[] = [];
  const fetchImpl = stubFetch(async (address, init) => {
    const href = String(address);
    const url = new URL(href);

    const ofPortal = operationAt(KMA_MID_OPERATIONS, href);
    if (ofPortal) {
      const record: AskedOfPortal = {
        operation: ofPortal,
        regId: url.searchParams.get("regId"),
        tmFc: url.searchParams.get("tmFc"),
        // As it was written, not as `URL` would spell it: the portal's key must go out untouched.
        url: href,
        init,
      };
      askedOfPortal.push(record);
      if (!portal) throw new Error("the portal was asked");
      if (typeof portal === "function") return await portal(record);
      const body = portal[`${record.operation} ${record.tmFc}`];
      return new Response(body ?? MID_NO_DATA, { status: 200 });
    }

    const ofHub = operationAt(KMA_OPERATIONS, url.href);
    if (!ofHub) {
      throw new Error(`neither the hub nor the portal: ${href.split("?")[0]}`);
    }
    const record: Asked = {
      operation: ofHub,
      issuance: `${url.searchParams.get("base_date")}/${url.searchParams.get("base_time")}`,
      rows: Number(url.searchParams.get("numOfRows")),
      cell: `${url.searchParams.get("nx")},${url.searchParams.get("ny")}`,
      url: url.href,
      init,
    };
    asked.push(record);
    cells.push(record.cell);
    if (typeof hub === "function") return await hub(record);
    const body = hub[`${record.operation} ${record.issuance}`];
    return body === undefined ? noData() : new Response(body, { status: 200 });
  });
  return { fetchImpl, asked, askedOfPortal, cells };
}

/** No rows: what a transport has before the table is generated, and what most tests want. */
const NO_PLACES = createKmaPlaces([]);

type TransportInput = Parameters<typeof createKmaWeatherTransport>[0];

/**
 * A weather transport over the fake, the clock it reads, and what each door was asked.
 *
 * WITH NO TABLE OF NAMES unless a test hands one in. The table this repository ships has four
 * thousand rows and names every cell it is asked about, and a test about the forecast should not
 * change when 기상청 re-issues its spreadsheet. The tests about names say which table they mean.
 *
 * The clock starts at 00:45 KST on 2 October 2026, the minute the midnight bodies were the newest
 * issuances, and a test moves it by writing `clock.at`.
 */
export function weatherOver(
  served: { hub: Hub; portal?: Portal | null },
  options: Omit<TransportInput, "fetchImpl" | "now"> & { at?: Date },
) {
  const fake = fakeKma(served.hub, served.portal);
  const { at, ...rest } = options;
  const clock = { at: at ?? kst("2026-10-02T00:45:00") };
  const transport = createKmaWeatherTransport({
    places: NO_PLACES,
    ...rest,
    now: () => clock.at,
    fetchImpl: fake.fetchImpl,
  });
  return { transport, clock, ...fake };
}

/**
 * The weather, asked the way a conversation asks it, and the answer read back as its facts. A
 * refusal is thrown and an error is not an answer, so `isError` is held false here; whether the
 * answer came whole is handed back for the file that holds it to that.
 *
 * `Facts` is the caller's: each file names the fields it reads, and no more.
 */
export async function answerOf<Facts>(
  made: { transport: VendorTransport },
  args: Record<string, unknown> = SEOUL,
): Promise<{ facts: Facts; text: string; truncated: boolean }> {
  const result = await made.transport.callTool(connection, "get_weather", args);
  expect(result.isError).toBe(false);
  return {
    facts: JSON.parse(result.text) as Facts,
    text: result.text,
    truncated: result.truncated,
  };
}
