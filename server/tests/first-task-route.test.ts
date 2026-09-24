import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { BUSINESS_SITES } from "../../shared/sites/catalogue";
import {
  createFirstTaskRoutes,
  FIRST_TASK_INVALID,
  parseFirstTaskPress,
  WORK_PATTERN_IDS,
} from "../src/agents/first-task";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AgentProfile } from "../src/agents/profile-types";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";

/**
 * `POST /api/me/first-task`: a first-task chip was pressed, and the one row it leaves.
 *
 * What only the route can get wrong is what it KEEPS. The chip's sentence is an English key today;
 * the body the app sends never carries it (`app/src/lib/agents/first-tasks.ts`), and a client that
 * did must find it nowhere — so every test that writes a row serialises the row and looks for the
 * words. The rest is that every field is a key from the catalogue it names, and that nobody can
 * put a row in the trail about a Bot they cannot see.
 */

const PERSON = {
  id: "owner-user",
  email: "owner@laf.test",
  role: "user",
} as const;
const BOT = "agent_1f2e3d4c-aaaa-4bbb-8ccc-123456789abc";

const visibleProfile = (id: string): AgentProfile => ({
  id,
  name: "초롱",
  roleDescription: "",
  avatarSeed: "s:pebble.blue",
  effort: "balanced",
  autoReview: "",
  ownerUserId: PERSON.id,
  systemOwned: false,
  hidden: false,
  notify: true,
  deletedAt: null,
  endpoint: null,
  hasAuth: false,
});

function surface(options: { visible?: boolean } = {}) {
  const rows: AuditEventInput[] = [];
  const asked: Array<[string, string]> = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const store: Pick<AgentProfileStore, "get"> = {
    get: async (actor, id) => {
      asked.push([actor.id, id]);
      return options.visible === false ? null : visibleProfile(id);
    },
  };
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", PERSON);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>().route(
    "/api",
    createFirstTaskRoutes(store, auditStore, requireUser),
  );
  return { app, rows, asked };
}

const press = (app: Hono<{ Variables: AppVariables }>, body: unknown) =>
  app.request("/api/me/first-task", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const SENTENCE = "Tell me what is on the calendar tomorrow.";

describe("what a press leaves", () => {
  test("one row: the keys of the chip, filed against the Bot, under the person", async () => {
    const { app, rows, asked } = surface();
    const response = await press(app, {
      agentId: BOT,
      kind: "ask",
      pattern: "schedule",
      via: { kind: "account", id: "google-calendar" },
      hint: "reputation",
    });

    expect(response.status).toBe(204);
    expect(asked).toEqual([[PERSON.id, BOT]]);
    expect(rows).toEqual([
      {
        eventType: "onboarding.first_task_pressed",
        targetType: "agent",
        targetId: BOT,
        actorUserId: PERSON.id,
        payload: {
          agentId: BOT,
          kind: "ask",
          pattern: "schedule",
          via: { kind: "account", id: "google-calendar" },
          hint: "reputation",
        },
      },
    ]);
  });

  test("a sentence sent beside the keys goes nowhere, and neither does anything else", async () => {
    const { app, rows } = surface();
    const typed = "사장님 개인 메모: 010-1234-5678";
    await press(app, {
      agentId: BOT,
      kind: "ask",
      pattern: "schedule",
      via: null,
      hint: null,
      sentence: SENTENCE,
      text: typed,
      note: { typed },
    });

    expect(rows).toHaveLength(1);
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain(SENTENCE);
    expect(everything).not.toContain(typed);
    expect(Object.keys(rows[0]?.payload ?? {}).sort()).toEqual([
      "agentId",
      "hint",
      "kind",
      "pattern",
      "via",
    ]);
  });

  test("the connect chip and the routine chip are presses too, with what they carry", async () => {
    const { app, rows } = surface();
    expect(
      (
        await press(app, {
          agentId: BOT,
          kind: "connect",
          pattern: null,
          via: null,
          hint: null,
        })
      ).status,
    ).toBe(204);
    const site = BUSINESS_SITES[0]?.id as string;
    expect(
      (
        await press(app, {
          agentId: BOT,
          kind: "routine",
          pattern: "enquiries",
          via: { kind: "site", id: site },
          hint: "enquiries",
        })
      ).status,
    ).toBe(204);

    expect(rows.map((row) => row.payload)).toEqual([
      { agentId: BOT, kind: "connect", pattern: null, via: null, hint: null },
      {
        agentId: BOT,
        kind: "routine",
        pattern: "enquiries",
        via: { kind: "site", id: site },
        hint: "enquiries",
      },
    ]);
  });

  test("a Bot this person cannot see is not there, and no row names it", async () => {
    const { app, rows } = surface({ visible: false });
    const response = await press(app, {
      agentId: BOT,
      kind: "connect",
      pattern: null,
      via: null,
      hint: null,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "laf:agent_not_found",
      code: "laf:agent_not_found",
    });
    expect(rows).toEqual([]);
  });
});

describe("what a press is refused for", () => {
  const ask = {
    agentId: BOT,
    kind: "ask",
    pattern: "stock",
    via: null,
    hint: null,
  };

  test.each([
    ["a body that is not an object", "ask"],
    ["no Bot", { ...ask, agentId: undefined }],
    ["a Bot id shaped like a path", { ...ask, agentId: "../../etc" }],
    ["a kind of chip there is not", { ...ask, kind: "type" }],
    ["an ask with no pattern", { ...ask, pattern: null }],
    [
      "a pattern that is not one of the eight",
      { ...ask, pattern: "marketing" },
    ],
    ["a pattern written as words", { ...ask, pattern: "재고·발주" }],
    ["a hint that is not one of the eight", { ...ask, hint: "sales" }],
    [
      "a site the catalogue does not have",
      {
        ...ask,
        via: { kind: "site", id: "myshop.co.kr" },
      },
    ],
    [
      "an account nobody ships",
      { ...ask, via: { kind: "account", id: "secret-crm" } },
    ],
    [
      "a via of a kind there is not",
      { ...ask, via: { kind: "email", id: "gmail" } },
    ],
    ["a via that is a string", { ...ask, via: "gmail" }],
    [
      "a connect chip that claims a pattern",
      {
        agentId: BOT,
        kind: "connect",
        pattern: "stock",
        via: null,
        hint: null,
      },
    ],
  ])("%s", async (_label, body) => {
    const { app, rows, asked } = surface();
    const response = await press(app, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: FIRST_TASK_INVALID,
      code: FIRST_TASK_INVALID,
    });
    // Refused on shape, before the roster is even asked.
    expect(asked).toEqual([]);
    expect(rows).toEqual([]);
  });

  test("a body that is not JSON, the same way", async () => {
    const { app, rows } = surface();
    const response = await app.request("/api/me/first-task", {
      method: "POST",
      body: "kind=ask",
    });
    expect(response.status).toBe(400);
    expect(rows).toEqual([]);
  });
});

describe("the catalogues the press is checked against", () => {
  test("the eight patterns, and every site and first-party account", () => {
    expect([...WORK_PATTERN_IDS].sort()).toEqual([
      "approval",
      "enquiries",
      "night-watch",
      "paperwork",
      "reputation",
      "schedule",
      "settlement",
      "stock",
    ]);
    for (const site of BUSINESS_SITES) {
      expect(
        parseFirstTaskPress({
          agentId: BOT,
          kind: "ask",
          pattern: site.category,
          via: { kind: "site", id: site.id },
          hint: null,
        }).ok,
      ).toBe(true);
    }
  });
});
