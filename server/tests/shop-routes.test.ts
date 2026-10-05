import { describe, expect, test } from "bun:test";
import type { Persona } from "../../shared/persona";
import type { ShopProfile } from "../../shared/shop/catalogue";
import type { ShopStore } from "../src/account/shop";
import { type CreateAppOptions, createApp } from "../src/app";
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

function shopStore(
  initial: ShopProfile = { kind: null, places: [] },
  initialPersona: Persona | null = null,
) {
  let held: ShopProfile = initial;
  let persona: Persona | null = initialPersona;
  let followedUp: Persona | null = null;
  const followUps: Array<{ userId: string; persona: Persona }> = [];
  const saved: Array<{ userId: string; shop: ShopProfile }> = [];
  const personas: Array<{ userId: string; persona: Persona | null }> = [];
  const store: ShopStore = {
    read: async () => held,
    save: async (userId, shop) => {
      saved.push({ userId, shop });
      held = shop;
      return held;
    },
    readPerson: async () => ({ persona, name: "민수", followedUp }),
    savePersona: async (userId, next) => {
      personas.push({ userId, persona: next });
      persona = next;
      return persona;
    },
    savePersonaFollowUp: async (userId, next) => {
      followUps.push({ userId, persona: next });
      followedUp = next;
      return followedUp;
    },
  };
  return { store, saved, personas, followUps };
}

function surface(
  store?: ShopStore,
  session: CreateAppOptions["auth"] = signedIn,
) {
  return createApp({
    config,
    auth: session,
    roleRepository: roles,
    shop: store,
  });
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
      readPerson: async () => {
        throw new Error("the database went away");
      },
      savePersona: async (_userId, persona) => persona,
      savePersonaFollowUp: async (_userId, persona) => persona,
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

/*
 * WHO THE PERSON IS, through the same door and the same session (`shared/persona.ts`). Pressed in
 * the Bot's greeting or in Settings; nothing else writes it.
 */
describe("PUT /api/me/persona", () => {
  const putPersona = (app: ReturnType<typeof createApp>, body: unknown) =>
    app.request("http://laf.local/api/me/persona", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("keeps one of the four for the person asking, and /api/me says it back", async () => {
    const { store, personas } = shopStore();
    const app = surface(store);
    const response = await putPersona(app, { persona: "student" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ persona: "student" });
    expect(personas).toEqual([{ userId: "owner", persona: "student" }]);
    const me = await (await app.request("http://laf.local/api/me")).json();
    expect(me.user.persona).toBe("student");
  });

  test("/api/me says null for somebody who has not answered — never a guess", async () => {
    // Even with a shop answered: the effective persona is the reader's, computed, never stored.
    const { store } = shopStore({ kind: "food", places: [] });
    const me = await (
      await surface(store).request("http://laf.local/api/me")
    ).json();
    expect(me.user.persona).toBeNull();
  });

  test("takes null, which is how a person clears it", async () => {
    const { store, personas } = shopStore(undefined, "worker");
    const response = await putPersona(surface(store), { persona: null });
    expect(response.status).toBe(200);
    expect(personas.at(-1)?.persona).toBeNull();
  });

  test("refuses anything but the four, with a code and without saving", async () => {
    const { store, personas } = shopStore();
    for (const body of [{ persona: "teacher" }, {}, { persona: 1 }, []]) {
      const response = await putPersona(surface(store), body);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("laf:persona_invalid");
    }
    expect(personas).toEqual([]);
  });

  test("needs a session", async () => {
    const { store, personas } = shopStore();
    const noSession = {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => null },
    };
    const response = await putPersona(surface(store, noSession), {
      persona: "owner",
    });
    expect(response.status).toBe(401);
    expect(personas).toEqual([]);
  });

  test("/api/me still answers when it cannot be read, and leaves it out", async () => {
    const { store } = shopStore();
    const broken: ShopStore = {
      ...store,
      readPerson: async () => {
        throw new Error("the database went away");
      },
    };
    const response = await surface(broken).request("http://laf.local/api/me");
    expect(response.status).toBe(200);
    expect((await response.json()).user).not.toHaveProperty("persona");
  });
});

describe("PUT /api/me/persona/follow-up", () => {
  const putFollowUp = (app: ReturnType<typeof createApp>, body: unknown) =>
    app.request("http://laf.local/api/me/persona/follow-up", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("settles the follow-up for one persona, and /api/me says which", async () => {
    const { store, followUps } = shopStore(undefined, "student");
    const app = surface(store);
    const response = await putFollowUp(app, { persona: "student" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ followedUp: "student" });
    expect(followUps).toEqual([{ userId: "owner", persona: "student" }]);
    const me = await (await app.request("http://laf.local/api/me")).json();
    expect(me.user.personaFollowUp).toBe("student");
  });

  test("refuses null and anything but the four, without saving", async () => {
    const { store, followUps } = shopStore();
    for (const body of [{ persona: null }, { persona: "teacher" }, {}]) {
      const response = await putFollowUp(surface(store), body);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("laf:persona_invalid");
    }
    expect(followUps).toEqual([]);
  });

  test("needs a session", async () => {
    const { store, followUps } = shopStore();
    const noSession = {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => null },
    };
    const response = await putFollowUp(surface(store, noSession), {
      persona: "worker",
    });
    expect(response.status).toBe(401);
    expect(followUps).toEqual([]);
  });
});
