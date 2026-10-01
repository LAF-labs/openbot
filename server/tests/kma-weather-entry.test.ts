import { describe, expect, test } from "bun:test";
import {
  CORE_TOOL_NAMES,
  deferredToolsText,
  exposureOf,
  FAMILY_LABELS_KO,
  WEATHER_TOOL_NAME,
} from "../../shared/tools/bridge";
import { catalogueEntry } from "../src/plugins/catalogue";
import { createDeploymentKeyRuntime } from "../src/plugins/deployment-key-runtime";
import { DEPLOYMENT_KEY_SERVICES } from "../src/plugins/deployment-key-services";
import {
  KMA_HOST,
  KMA_OPERATIONS,
  KMA_WEATHER_KEY,
  KMA_WEATHER_TOOLS,
} from "../src/plugins/kma-weather-rest";
import {
  DEPLOYMENT_KEY_ENV,
  deploymentKeysFrom,
  entryIsOffered,
  keyLookupOver,
  NO_DEPLOYMENT_KEYS,
} from "../src/plugins/shared-clients";
import {
  type GrantedPlugins,
  PluginRefusedError,
  type ServerRecord,
  toolNameFor,
} from "../src/plugins/store";
import { stubFetch } from "./support/fetch";
import { NO_DATA_BODY, SEOUL_MIDNIGHT } from "./support/kma-fixtures";

/**
 * The weather as an entry the fleet's key opens: what stands between the transport
 * (`kma-weather-rest.test.ts`, which is handed its readers directly) and a Bot that says "오늘
 * 날씨" — the key family, the catalogue entry, and the one reader the runtime threads through.
 *
 * THE READER IS THE PART WORTH A FILE. The tool's own description says "인자 없이 부르면 이 사람의
 * 저장된 위치 기준", and the transport does that for whoever hands it `coordinatesOf` and
 * `placeOf`. Nothing here did until the runtime was given a reader to hand on: assembled without
 * one, every call that named no place would have been refused `laf:weather_place_unknown`, and a
 * Bot told that asks the person where they are — on every weather question, for a person whose
 * place is on file.
 */

const KEY = "kma-test-key-0123456789";
const REF = `${KMA_WEATHER_KEY}/get_weather`;
const connection = { url: KMA_HOST, actorId: "person-1", botId: "bot-1" };

/** 00:45 KST on 2 October: the minute the three midnight bodies were the newest issuances. */
const AT = new Date("2026-10-02T00:45:00+09:00");
const SERVED: Record<string, string> = {
  [`${KMA_OPERATIONS.now} 20261002/0000`]: SEOUL_MIDNIGHT.now,
  [`${KMA_OPERATIONS.hours} 20261002/0030`]: SEOUL_MIDNIGHT.hours,
  [`${KMA_OPERATIONS.days} 20261001/2300`]: SEOUL_MIDNIGHT.days,
};

/** A hub that answers the midnight bodies for their own issuances, whatever cell is asked. */
function fakeHub() {
  const cells: string[] = [];
  const fetchImpl = stubFetch(async (address) => {
    const url = new URL(String(address));
    cells.push(`${url.searchParams.get("nx")},${url.searchParams.get("ny")}`);
    const body =
      SERVED[
        `${url.origin}${url.pathname} ${url.searchParams.get("base_date")}/${url.searchParams.get("base_time")}`
      ];
    return new Response(body ?? NO_DATA_BODY, { status: 200 });
  });
  return { cells, fetchImpl };
}

function runtimeWith(whereabouts?: {
  place: string | null;
  coordinates: { latitude: number; longitude: number } | null;
}) {
  const hub = fakeHub();
  const asked: string[] = [];
  const runtime = createDeploymentKeyRuntime({
    keys: { "kma-apihub": KEY },
    services: DEPLOYMENT_KEY_SERVICES,
    listBots: async () => ["bot-a"],
    fetchImpl: hub.fetchImpl,
    now: () => AT,
    ...(whereabouts
      ? {
          whereaboutsOf: async (userId: string) => {
            asked.push(userId);
            return whereabouts;
          },
        }
      : {}),
  });
  const transport = runtime.transports["kma-apihub"];
  if (!transport) throw new Error("no transport for the hub's key");
  return { runtime, transport, cells: hub.cells, asked };
}

describe("the weather, as an entry the fleet's key opens", () => {
  test("is hidden without the key, and the key is read from its own environment name", () => {
    const entry = catalogueEntry(KMA_WEATHER_KEY);
    if (!entry) throw new Error("no entry");
    expect(entryIsOffered(entry, NO_DEPLOYMENT_KEYS)).toBe(false);
    expect(DEPLOYMENT_KEY_ENV["kma-apihub"]).toBe("KMA_APIHUB_AUTH_KEY");
    const keys = deploymentKeysFrom({ KMA_APIHUB_AUTH_KEY: ` ${KEY}\n` });
    expect(keys).toEqual({ "kma-apihub": KEY });
    expect(entryIsOffered(entry, keyLookupOver(keys))).toBe(true);
  });

  test("a key with a space inside it is refused at boot; the portal's spelling rule is not this key's", () => {
    expect(() =>
      deploymentKeysFrom({ KMA_APIHUB_AUTH_KEY: "abc def" }),
    ).toThrow(/KMA_APIHUB_AUTH_KEY has whitespace/);
    // The hub's key goes through `URLSearchParams`, which encodes it: `+`, `/` and `=` are its own business.
    expect(
      deploymentKeysFrom({ KMA_APIHUB_AUTH_KEY: "a+b/c==" })["kma-apihub"],
    ).toBe("a+b/c==");
  });

  test("the entry pins the host and the path every operation is under", () => {
    const entry = catalogueEntry(KMA_WEATHER_KEY);
    if (!entry) throw new Error("no entry");
    expect(entry.host).toBe(KMA_HOST);
    expect(entry.auth).toEqual({ kind: "deployment-key", key: "kma-apihub" });
    expect(entry.writeTools).toEqual([]);
    for (const address of Object.values(KMA_OPERATIONS)) {
      expect(address.startsWith(`${entry.host}${entry.path}/`)).toBe(true);
    }
  });

  test("the name a Bot calls it by is one string on both sides, and its family has a Korean name", () => {
    expect(KMA_WEATHER_TOOLS.map((tool) => tool.name)).toEqual(["get_weather"]);
    expect(WEATHER_TOOL_NAME).toBe(toolNameFor(REF));
    expect(FAMILY_LABELS_KO[KMA_WEATHER_KEY]).toBe("날씨");
  });

  test("is in the schema, not behind the bridge", () => {
    /*
     * Measured 2026-10-02 (`shared/tools/bridge.ts`, `WEATHER_TOOL_NAME`): behind the bridge a
     * weather question was 16.6 s and 19.7K tokens with a `tool_search` round first; in the schema,
     * 12.5 s and 13.6K. The name this side mints and the name on the core list must be one string.
     */
    expect(CORE_TOOL_NAMES.has(WEATHER_TOOL_NAME)).toBe(true);
    expect(exposureOf(WEATHER_TOOL_NAME)).toBe("core");
    expect(
      deferredToolsText([WEATHER_TOOL_NAME, "mcp__public-data__search_bids"]),
    ).not.toContain("kma-weather");
    // Only that one name: anything else under the entry would stay behind the bridge.
    expect(exposureOf("mcp__kma-weather__anything_else")).toBe("deferred");
  });

  test("with the key, the tool is assembled and every Bot is granted it", async () => {
    const { runtime } = runtimeWith();
    expect(runtime.has(KMA_WEATHER_KEY)).toBe(true);
    expect(runtime.toolNames).toEqual(["get_weather"]);
    expect(Object.keys(runtime.transports)).toEqual(["kma-apihub"]);

    const granted: { ref: string; botId: string }[] = [];
    const ensured: string[] = [];
    const store = {
      ensureCatalogueServer: async ({ key }: { key: string }) => {
        ensured.push(key);
        return { url: KMA_HOST, added: true };
      },
      refreshTools: async () => ({ tools: 1 }),
      approveToolDefinition: async () => true,
      grant: async (_kind: string, ref: string, botId: string) => {
        granted.push({ ref, botId });
      },
      revoke: async () => undefined,
      removeServer: async () => undefined,
      listServers: async () => [] as ServerRecord[],
      listForAgent: async (): Promise<GrantedPlugins> => ({
        tools: [],
        skills: [],
      }),
    } as unknown as Parameters<typeof runtime.reconcile>[0];
    await runtime.reconcile(store, "deployment");
    expect(ensured).toEqual([KMA_WEATHER_KEY]);
    expect(granted).toEqual([{ ref: REF, botId: "bot-a" }]);
  });

  test("a call naming no place is answered for the place the person saved, read through the runtime's reader", async () => {
    const { transport, cells, asked } = runtimeWith({
      place: "서울 강남구",
      coordinates: null,
    });
    const result = await transport.callTool(connection, "get_weather", {});
    const facts = JSON.parse(result.text) as { place: string; basis?: string };
    // The person the call is for, and nobody else: the reader is asked by the call's own actor.
    expect(new Set(asked)).toEqual(new Set(["person-1"]));
    expect(facts.place).toBe("서울특별시 강남구");
    expect(facts.basis).toBe("저장된 위치");
    // 기상청's cell for 강남구, on every request the answer was made from.
    expect(new Set(cells)).toEqual(new Set(["61,126"]));
  });

  test("the device's coordinates come before the saved words", async () => {
    const { transport, cells } = runtimeWith({
      place: "부산 해운대구",
      coordinates: { latitude: 37.57, longitude: 126.98 },
    });
    const result = await transport.callTool(connection, "get_weather", {});
    const facts = JSON.parse(result.text) as { place: string; basis?: string };
    expect(new Set(cells)).toEqual(new Set(["60,127"]));
    expect(facts.place).toContain("위도 37.57, 경도 126.98");
    expect(facts.basis).toBe("저장된 위치");
  });

  test("a place named in the call is that place, and nobody's whereabouts are read", async () => {
    const { transport, cells, asked } = runtimeWith({
      place: "서울 강남구",
      coordinates: null,
    });
    const result = await transport.callTool(connection, "get_weather", {
      place: "부산 해운대구",
    });
    const facts = JSON.parse(result.text) as { place: string; basis?: string };
    expect(asked).toEqual([]);
    expect(facts.place).toBe("부산광역시 해운대구");
    expect(facts.basis).toBeUndefined();
    expect(new Set(cells)).toEqual(new Set(["99,75"]));
  });

  test("a person with nothing saved is told so, and the hub is not asked", async () => {
    const { transport, cells } = runtimeWith({
      place: null,
      coordinates: null,
    });
    const refused = await transport
      .callTool(connection, "get_weather", {})
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PluginRefusedError);
    expect((refused as PluginRefusedError).code).toBe(
      "laf:weather_place_unknown",
    );
    expect(cells).toEqual([]);
  });

  test("a runtime handed no reader refuses the same way rather than guessing a place", async () => {
    const { transport, cells } = runtimeWith();
    const refused = await transport
      .callTool(connection, "get_weather", {})
      .catch((error: unknown) => error);
    expect((refused as PluginRefusedError).code).toBe(
      "laf:weather_place_unknown",
    );
    expect(cells).toEqual([]);
  });
});
