/**
 * The person's clock and place — kept, changed, cleared, and handed to whatever needs them.
 *
 * WHY THE SERVER KEEPS THEM. The Bot's browser runs on a cloud VM, and a website reads the VM's
 * address, zone and place as its visitor's: asked for today's weather, a Bot reported 네이버's guess
 * of the VM's place (제주시) as "사장님 위치" (2026-09-24). The person's own facts come from where the
 * person is — their device, their answer — and are kept here so that a run with nobody present (a
 * routine at 07:30) still has them.
 *
 * THREE DOORS, ALL THE PERSON'S SESSION:
 *
 *   PUT    /api/me/device   the app, every time it opens: the device's zone and language.
 *   PUT    /api/me/place    내 가게 → 가게 위치, and the Bot's `remember` with a `place` — the place a
 *                           person said in a conversation, saved through their own session. And
 *                           the device's own answer, which is coordinates with no `place` key:
 *                           that one writes the coordinates and never touches the words.
 *   DELETE /api/me/place    내 가게 → 지우기. Place and coordinates both go.
 *
 * NEVER LOGGED. No zone, no place and no coordinate reaches a log line or the audit trail — "the
 * place was set" is the whole of what an operator learns (`place_set`, with whether it came with
 * coordinates). The person's own screen is the one place their place is shown.
 */
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  type Coordinates,
  canonicalLocale,
  coarseCoordinates,
  DEVICE_INVALID,
  isUsableTimeZone,
  NO_WHEREABOUTS,
  PLACE_INVALID,
  parsePlace,
  type Whereabouts,
} from "../../../shared/whereabouts";
import {
  looksLikeAnInstruction,
  looksLikeASecret,
} from "../agents/memory-store";
import { nameNear } from "../agents/person-context";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import { log } from "../log";

export type PlaceAnswer = {
  /**
   * The words. `null` clears them. ABSENT IS "NOTHING SAID ABOUT THE WORDS" and leaves what is kept
   * alone: it is how a device's answer arrives (`app/src/lib/whereabouts/device-place.ts`). A
   * browser asked where it is answers minutes later, from a tab whose copy of the account may be
   * older than a place the person said meanwhile — in a conversation, in another tab — and an
   * answer that carried the tab's `place: null` back would erase it (review of pull request 91).
   * The device knows coordinates; what the person said is not its to send.
   */
  place?: string | null;
  coordinates: Coordinates | null;
};

export type WhereaboutsStore = {
  /** Nothing reported — or nobody by that id — reads as nothing known. Never throws on a miss. */
  read: (userId: string) => Promise<Whereabouts>;
  /** The device's clock. Says whether it differed from what was kept. */
  saveDevice: (
    userId: string,
    device: { timeZone: string; locale: string | null },
  ) => Promise<boolean>;
  /**
   * Replace the place — words and coordinates together, or the coordinates alone where the answer
   * says nothing about the words (`PlaceAnswer`) — and hand back what is kept now.
   */
  savePlace: (userId: string, answer: PlaceAnswer) => Promise<Whereabouts>;
};

export function createWhereaboutsStore(
  database: Database,
  /** Told the person's id whenever what the Bot's browser follows may have moved. */
  changed: (userId: string) => void = () => undefined,
): WhereaboutsStore {
  const read = async (userId: string): Promise<Whereabouts> => {
    const [row] = await database
      .select({
        timeZone: users.timeZone,
        locale: users.locale,
        place: users.place,
        latitude: users.placeLatitude,
        longitude: users.placeLongitude,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return NO_WHEREABOUTS;
    return {
      // Read back through the same checks they were written through: a zone this runtime no longer
      // knows (an older tz database) is not handed to `Intl`, which would throw in the middle of a run.
      timeZone: isUsableTimeZone(row.timeZone) ? row.timeZone : null,
      locale: canonicalLocale(row.locale),
      place: row.place || null,
      coordinates:
        row.latitude === null || row.longitude === null
          ? null
          : coarseCoordinates({
              latitude: row.latitude,
              longitude: row.longitude,
            }),
    };
  };
  return {
    read,
    saveDevice: async (userId, device) => {
      const kept = await read(userId);
      if (kept.timeZone === device.timeZone && kept.locale === device.locale) {
        return false;
      }
      await database
        .update(users)
        .set({ timeZone: device.timeZone, locale: device.locale })
        .where(eq(users.id, userId));
      if (kept.timeZone !== device.timeZone) changed(userId);
      return true;
    },
    savePlace: async (userId, answer) => {
      await database
        .update(users)
        .set({
          // One statement either way: the words are written, or the column is not named at all.
          ...(answer.place === undefined ? {} : { place: answer.place }),
          placeLatitude: answer.coordinates?.latitude ?? null,
          placeLongitude: answer.coordinates?.longitude ?? null,
        })
        .where(eq(users.id, userId));
      changed(userId);
      // Read back rather than echoed: what the person is shown is what every run will be told.
      return read(userId);
    },
  };
}

/**
 * What the person's own screen is told: the kept facts, and what the place the device's
 * coordinates fall in is called.
 *
 * THE SURFACE CANNOT WORK A NAME OUT, AND MUST NOT DRAW THE NUMBERS. 내 정보 drew a latitude and a
 * longitude under a box that still held the place the person had typed before; the owner, whose
 * device had just been allowed, could not tell that it had worked and asked whether the place in
 * the box was the server's location (2026-10-06). So every answer about a person's whereabouts
 * — `/api/me`, and the three doors below — carries the name beside the coordinates.
 *
 * THE SAME NAME THE PROMPT'S PLACE LINE USES, UNDER THE SAME RULE (`nameNear`, `promptPersonOf`):
 * the districts of the forecast cell the coordinates fall in, read from 기상청's table, with "부근"
 * once where the nearest name is a neighbour's. A district, never a street. And only where the
 * device IS the place — coordinates, and no words: what a person said is the place, and is not
 * annotated with where their device happens to be. ABSENT otherwise, and where the table names
 * nothing: no name is made up.
 *
 * NOT KEPT AND NOT TAKEN: it is read from the table on the way out, and `placeAnswerOf` reads no
 * such key on the way in.
 */
export function withName(
  kept: Whereabouts,
  nameOf: (coordinates: Coordinates) => string | null = nameNear,
): Whereabouts {
  const near =
    kept.coordinates && !kept.place ? nameOf(kept.coordinates) : null;
  return near ? { ...kept, near } : kept;
}

/**
 * A place as a request offered it, or the refusal.
 *
 * THE WORDS ARE READ INTO EVERY RUN'S PROMPT, so they pass the memory store's two scans as well as
 * the shape `parsePlace` allows: a place that reads as an order, or as a card number, is not a place.
 * Coordinates are coarsened by `coarseCoordinates` before anything else sees them.
 *
 * NO `place` KEY IS NOT `place: null`. A body that names the key — words, or null — is an answer
 * about the words and replaces them; a body with coordinates and no such key is the device's, and
 * the value it becomes has no `place` either, so the store leaves the words as they are.
 */
export function placeAnswerOf(
  body: unknown,
): { ok: true; value: PlaceAnswer } | { ok: false } {
  if (!body || typeof body !== "object") return { ok: false };
  const offered = body as Record<string, unknown>;
  const saysTheWords = offered.place !== undefined;
  const place = parsePlace(offered.place);
  if (place === "invalid") return { ok: false };
  if (place && (looksLikeAnInstruction(place) || looksLikeASecret(place))) {
    return { ok: false };
  }
  const coordinates =
    offered.coordinates === null || offered.coordinates === undefined
      ? null
      : coarseCoordinates(offered.coordinates);
  if (offered.coordinates && !coordinates) return { ok: false };
  if (!place && !coordinates) return { ok: false };
  return {
    ok: true,
    value: saysTheWords ? { place, coordinates } : { coordinates },
  };
}

/** `PUT /api/me/device`, `PUT /api/me/place`, `DELETE /api/me/place` — mounted under `/api`. */
export function createWhereaboutsRoutes(
  store: WhereaboutsStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /*
   * The device's clock, sent by the app whenever it opens. A zone this runtime does not know is
   * refused rather than kept: it would be handed to `Intl` on every run and to Chromium at launch,
   * and both throw on a name they do not know.
   */
  routes.put("/me/device", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!isUsableTimeZone(body?.timeZone)) {
      return context.json({ error: DEVICE_INVALID, code: DEVICE_INVALID }, 400);
    }
    await store.saveDevice(context.var.actor.id, {
      timeZone: body.timeZone,
      locale: canonicalLocale(body?.locale),
    });
    return context.json({
      whereabouts: withName(await store.read(context.var.actor.id)),
    });
  });

  routes.put("/me/place", requireUser, async (context) => {
    const parsed = placeAnswerOf(await context.req.json().catch(() => null));
    if (!parsed.ok) {
      // The refused words are not echoed: the code is the whole answer, as it is for a memory.
      return context.json({ error: PLACE_INVALID, code: PLACE_INVALID }, 400);
    }
    const whereabouts = await store.savePlace(
      context.var.actor.id,
      parsed.value,
    );
    log.info("place_set", {
      words: typeof parsed.value.place === "string",
      coordinates: parsed.value.coordinates !== null,
    });
    return context.json({ whereabouts: withName(whereabouts) });
  });

  routes.delete("/me/place", requireUser, async (context) => {
    const whereabouts = await store.savePlace(context.var.actor.id, {
      place: null,
      coordinates: null,
    });
    log.info("place_cleared", {});
    return context.json({ whereabouts: withName(whereabouts) });
  });

  return routes;
}

/** What the Bot's browser is told on every call to the computer (`computer/client.ts`). */
export type BrowserWhereabouts = {
  timeZone: string;
  coordinates: Coordinates | null;
};

/**
 * The person's zone and coordinates, looked up by the Bot the computer is being asked about.
 *
 * BY THE BOT'S OWNER, not by "the deployment's person": the computer client is shared and a call
 * names only a Bot, so the owner is read the way the live screen reads it. One account per
 * deployment makes that the same person every time — and a test with two people in one database
 * still gets each one's own.
 *
 * HELD FOR A FEW SECONDS, because the live screen asks the computer every few seconds and this would
 * be two reads a poll. `forget` drops a person's entry the moment they change something, so a place
 * saved on 내 가게 reaches the very next call and not the one after the hold.
 */
export function createBrowserWhereabouts(options: {
  ownerOf: (botId: string) => Promise<string | null>;
  read: (userId: string) => Promise<Whereabouts>;
  /** The deployment's zone (`config.botTimeZone`), for a person whose device never reported one. */
  fallbackZone: string;
  holdMs?: number;
  now?: () => number;
}) {
  const holdMs = options.holdMs ?? 5_000;
  const now = options.now ?? Date.now;
  const held = new Map<
    string,
    { at: number; ownerId: string | null; value: BrowserWhereabouts | null }
  >();
  return {
    async forBot(botId: string): Promise<BrowserWhereabouts | null> {
      const kept = held.get(botId);
      if (kept && now() - kept.at < holdMs) return kept.value;
      const ownerId = await options.ownerOf(botId);
      const whereabouts = ownerId ? await options.read(ownerId) : null;
      const value = whereabouts
        ? {
            timeZone: whereabouts.timeZone ?? options.fallbackZone,
            coordinates: whereabouts.coordinates,
          }
        : null;
      held.set(botId, { at: now(), ownerId, value });
      return value;
    },
    forget(userId: string): void {
      for (const [botId, kept] of held) {
        if (kept.ownerId === userId) held.delete(botId);
      }
    },
  };
}
