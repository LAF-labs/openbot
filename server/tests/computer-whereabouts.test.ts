import { describe, expect, test } from "bun:test";
import type { BrowserWhereabouts } from "../src/account/whereabouts";
import { createComputerClient } from "../src/computer/client";

/**
 * Every call that names a Bot tells its browser where that Bot's person is.
 *
 * The browser runs on a cloud VM, and a site reads the VM's zone and address as its visitor's — a Bot
 * reported 네이버's guess of the VM's place (제주시) as its owner's. So the owner's zone and coarse
 * coordinates ride beside `x-openbot-bot-id` on every call, and a computer that restarted is told
 * again by the very next click rather than by a push somebody has to remember.
 */

function clientTelling(
  whereabouts: BrowserWhereabouts | null | "throws",
  seen: Headers[],
) {
  return createComputerClient({
    baseUrl: "http://agent-computer:4100",
    fetchImpl: ((_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(
        new Response(JSON.stringify({ snapshotId: 1, elements: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch,
    whereaboutsFor: async () => {
      if (whereabouts === "throws") throw new Error("database gone");
      return whereabouts;
    },
  });
}

describe("where the Bot's browser is told the person is", () => {
  test("the zone and the coordinates, beside the Bot", async () => {
    const seen: Headers[] = [];
    await clientTelling(
      {
        timeZone: "Asia/Dubai",
        coordinates: { latitude: 37.5, longitude: 127.03 },
      },
      seen,
    )
      .forBot("bot_miso")
      .snapshot();
    expect(seen[0]?.get("x-openbot-bot-id")).toBe("bot_miso");
    expect(seen[0]?.get("x-openbot-time-zone")).toBe("Asia/Dubai");
    expect(seen[0]?.get("x-openbot-geolocation")).toBe("37.5,127.03");
  });

  test("a person with no place is said to have none, so a cleared place stops being shown", async () => {
    const seen: Headers[] = [];
    await clientTelling({ timeZone: "Asia/Seoul", coordinates: null }, seen)
      .forBot("bot_miso")
      .snapshot();
    expect(seen[0]?.get("x-openbot-geolocation")).toBe("none");
  });

  test("a lookup that fails sends nothing, and the click still goes", async () => {
    const seen: Headers[] = [];
    await clientTelling("throws", seen).forBot("bot_miso").snapshot();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.get("x-openbot-time-zone")).toBeNull();
    expect(seen[0]?.get("x-openbot-geolocation")).toBeNull();
  });

  test("a call that names no Bot names nobody's place", async () => {
    const seen: Headers[] = [];
    await clientTelling(
      { timeZone: "Asia/Dubai", coordinates: null },
      seen,
    ).status("bot_miso");
    expect(seen[0]?.get("x-openbot-time-zone")).toBeNull();
  });
});
