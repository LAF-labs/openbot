import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { createProfiles } from "../src/profiles";
import { samePlace, whereaboutsOf } from "../src/whereabouts";

/**
 * The Bot's browser follows the person, not the VM it runs on.
 *
 * Asked for today's weather, a Bot read 네이버's guess of its cloud VM's place (제주시) and told its
 * owner that was theirs (2026-09-24). The server now names the owner's zone and coarse coordinates on
 * every call; these tests drive a real Chromium and ask the PAGE what it sees — `Intl`'s zone and
 * `navigator.geolocation` — because a launch option that was passed and a page that shows it are
 * two different facts.
 *
 * Skipped where Playwright has no browser downloaded; a skip says so out loud.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe("where one call says the person is", () => {
  const said = (headers: Record<string, string>) =>
    whereaboutsOf(new Headers(headers));

  test("the zone and the coordinates, coarse", () => {
    expect(
      said({
        "x-openbot-time-zone": "Asia/Dubai",
        "x-openbot-geolocation": "25.2048,55.2708",
      }),
    ).toEqual({
      timeZone: "Asia/Dubai",
      geolocation: { latitude: 25.2, longitude: 55.27 },
    });
  });

  test("`none` is no place — a place the person cleared stops being shown", () => {
    expect(said({ "x-openbot-geolocation": "none" })).toEqual({
      geolocation: null,
    });
  });

  test("silence, and anything unusable, keeps what the browser had", () => {
    expect(said({})).toEqual({});
    // Chromium refuses an unknown zone at launch, which would take every Bot's browser down.
    expect(said({ "x-openbot-time-zone": "Mars/Olympus" })).toEqual({});
    expect(said({ "x-openbot-geolocation": "somewhere" })).toEqual({});
    expect(said({ "x-openbot-geolocation": "91,10" })).toEqual({});
    expect(said({ "x-openbot-geolocation": "1,2,3" })).toEqual({});
  });

  test("two places are the same only when both are, and nowhere is nowhere", () => {
    expect(samePlace(null, null)).toBe(true);
    expect(samePlace(null, { latitude: 1, longitude: 2 })).toBe(false);
    expect(
      samePlace({ latitude: 1, longitude: 2 }, { latitude: 1, longitude: 2 }),
    ).toBe(true);
  });
});

describe.skipIf(!HAS_BROWSER)("the browser, followed", () => {
  let site: ReturnType<typeof Bun.serve> | null = null;
  let root = "";

  beforeAll(async () => {
    // Geolocation is a secure-context API; 127.0.0.1 is one, a `data:` page is not.
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("<!doctype html><title>날씨</title><h1>오늘 날씨</h1>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });
    root = await mkdtemp(join(tmpdir(), "laf-where-"));
  });

  afterAll(async () => {
    await site?.stop(true);
    await rm(root, { recursive: true, force: true });
  });

  /** What the page itself sees: its zone, and where the browser says it is — or the refusal. */
  async function seenBy(page: Page) {
    await page.goto(`http://127.0.0.1:${site?.port}/`);
    return page.evaluate(
      () =>
        new Promise<{ zone: string; place: string }>((resolve) => {
          const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
          navigator.geolocation.getCurrentPosition(
            (position) =>
              resolve({
                zone,
                place: `${position.coords.latitude},${position.coords.longitude}`,
              }),
            (failure) => resolve({ zone, place: `refused:${failure.code}` }),
            { timeout: 3_000 },
          );
        }),
    );
  }

  test("starts on the person's zone and in their place, then moves with them", async () => {
    const profiles = createProfiles(join(root, "moves"), { idleCloseMs: 0 });
    try {
      await profiles.follow({
        timeZone: "Asia/Dubai",
        geolocation: { latitude: 37.5, longitude: 127.03 },
      });
      const page = await profiles.page("where-bot");
      expect(await seenBy(page)).toEqual({
        zone: "Asia/Dubai",
        place: "37.5,127.03",
      });

      // The place moves on the running browser, at once.
      await profiles.follow({
        geolocation: { latitude: 35.16, longitude: 129.16 },
      });
      expect((await seenBy(page)).place).toBe("35.16,129.16");

      // Cleared: a site asking is refused (PERMISSION_DENIED), never shown the VM's place.
      await profiles.follow({ geolocation: null });
      expect((await seenBy(page)).place).toBe("refused:1");
    } finally {
      await profiles.closeAll();
    }
  });

  test("a new zone waits for the next browser, never closing one a Bot is working in", async () => {
    const profiles = createProfiles(join(root, "zone"), { idleCloseMs: 0 });
    try {
      await profiles.follow({ timeZone: "Asia/Seoul", geolocation: null });
      const page = await profiles.page("zone-bot");
      expect((await seenBy(page)).zone).toBe("Asia/Seoul");

      await profiles.follow({ timeZone: "Asia/Dubai" });
      // The tab the Bot is in is still there, on the clock it started on.
      expect(page.isClosed()).toBe(false);
      expect((await seenBy(page)).zone).toBe("Asia/Seoul");

      // Its tabs close, the browser with them, and the next one starts where the person is.
      await profiles.stop("zone-bot");
      const next = await profiles.page("zone-bot");
      expect((await seenBy(next)).zone).toBe("Asia/Dubai");
    } finally {
      await profiles.closeAll();
    }
  });

  test("a browser nobody has a tab in is restarted on the new zone by the call that brought it", async () => {
    const profiles = createProfiles(join(root, "idle"), { idleCloseMs: 0 });
    try {
      await profiles.follow({ timeZone: "Asia/Seoul" });
      const page = await profiles.page("idle-bot");
      const first = page.context().browser();
      // Its one tab closed by a site, not by a stop: the browser is still up, with nobody in it.
      await page.close();
      await Bun.sleep(50);

      await profiles.follow({ timeZone: "Asia/Tokyo" });
      expect(first?.isConnected()).toBe(false);
      expect((await seenBy(await profiles.page("idle-bot"))).zone).toBe(
        "Asia/Tokyo",
      );
    } finally {
      await profiles.closeAll();
    }
  });
});
