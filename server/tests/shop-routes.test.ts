import { describe, expect, test } from "bun:test";
import type { ShopProfile } from "../../shared/shop/catalogue";
import type { ShopStore } from "../src/account/shop";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * The shop answers at the door: `/api/me` carries them beside who is asking, and `PUT /api/me/shop`
 * is the one way they change.
 *
 * On `/api/me` because every screen that uses them — the intro card's chips, the first things to
 * ask, Settings — is drawn after that call has already answered, so the order is right on the first
 * frame rather than reshuffled when a second request lands. Facts only: two catalogue keys and a
 * list of them. The surface owns every word.
 */

const config = loadConfig(testEnvironment());

const signedIn = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: "owner", email: "owner@laf.test", name: "사장님" },
    }),
  },
};
const roles = { rolesForUser: async () => ["user" as const] };

function shopStore(initial: ShopProfile = { kind: null, places: [] }) {
  let held: ShopProfile = initial;
  const saved: Array<{ userId: string; shop: ShopProfile }> = [];
  const store: ShopStore = {
    read: async () => held,
    save: async (userId, shop) => {
      saved.push({ userId, shop });
      held = shop;
      return held;
    },
  };
  return { store, saved };
}

/**
 * `createApp` takes its collaborators by position, and the shop store is the last of them. A tuple
 * typed from the function keeps the compiler on the shape; a wrong index shows up here as a 404
 * where the route should be, which every test below would read.
 */
function surface(
  store?: ShopStore,
  session: Parameters<typeof createApp>[1] = signedIn,
) {
  const args: Parameters<typeof createApp> = [config, session, roles];
  args[47] = store;
  return createApp(...args);
}

const put = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("http://laf.local/api/me/shop", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("what /api/me says about the shop", () => {
  test("the kind and the places, as the person answered them", async () => {
    const { store } = shopStore({
      kind: "food",
      places: ["baemin-ceo", "naver-smartplace"],
    });
    const body = await (
      await surface(store).request("http://laf.local/api/me")
    ).json();

    expect(body.user.shop).toEqual({
      kind: "food",
      places: ["baemin-ceo", "naver-smartplace"],
    });
  });

  test("nothing, on a deployment that keeps no answers", async () => {
    const body = await (
      await surface().request("http://laf.local/api/me")
    ).json();
    expect(body.user).not.toHaveProperty("shop");
  });

  test("still answers when the answers cannot be read", async () => {
    // The door every screen waits on must not fall over because one optional fact did.
    const broken: ShopStore = {
      read: async () => {
        throw new Error("the database went away");
      },
      save: async (_userId, shop) => shop,
    };
    const response = await surface(broken).request("http://laf.local/api/me");
    expect(response.status).toBe(200);
    expect((await response.json()).user).not.toHaveProperty("shop");
  });
});

describe("PUT /api/me/shop", () => {
  test("replaces the answer for the person asking, and says what is held now", async () => {
    const { store, saved } = shopStore({ kind: "online", places: ["gmail"] });
    const response = await put(surface(store), {
      kind: "beauty",
      places: ["naver-booking-talk", "instagram"],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      shop: { kind: "beauty", places: ["naver-booking-talk", "instagram"] },
    });
    expect(saved).toEqual([
      {
        userId: "owner",
        shop: { kind: "beauty", places: ["naver-booking-talk", "instagram"] },
      },
    ]);
  });

  test("takes an empty answer, which is how a person clears one", async () => {
    const { store, saved } = shopStore({ kind: "food", places: ["hometax"] });
    const response = await put(surface(store), { kind: null, places: [] });
    expect(response.status).toBe(200);
    expect(saved.at(-1)?.shop).toEqual({ kind: null, places: [] });
  });

  test("refuses anything not in the catalogue, with a code and without saving", async () => {
    const { store, saved } = shopStore();
    const response = await put(surface(store), {
      kind: "food",
      places: ["myspace"],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "laf:shop_invalid",
      code: "laf:shop_invalid",
    });
    expect(saved).toEqual([]);
  });

  test("refuses a body that is not JSON", async () => {
    const { store, saved } = shopStore();
    const response = await surface(store).request(
      "http://laf.local/api/me/shop",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{kind: food",
      },
    );
    expect(response.status).toBe(400);
    expect(saved).toEqual([]);
  });

  test("needs a session", async () => {
    const { store, saved } = shopStore();
    const noSession = {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => null },
    };
    const response = await put(surface(store, noSession), {
      kind: "food",
      places: [],
    });
    expect(response.status).toBe(401);
    expect(saved).toEqual([]);
  });

  test("is not there at all on a deployment that keeps no answers", async () => {
    // A 404, not a success that kept nothing: a control that saves and does nothing is worse
    // than no control.
    const response = await put(surface(), { kind: "food", places: [] });
    expect(response.status).toBe(404);
  });
});
