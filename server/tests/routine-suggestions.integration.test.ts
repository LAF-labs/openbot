import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { BUSINESS_SITES } from "../../shared/sites/catalogue";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agents,
  lafRoutineSuggestionDismissals,
  lafRoutines,
  users,
} from "../src/db/schema";
import { CATALOGUE } from "../src/plugins/catalogue";
import { createRoutineService, nextRunAt } from "../src/routines/service";
import { ROUTINE_SUGGESTIONS } from "../src/routines/suggestion-catalog";
import {
  createRoutineSuggestionService,
  createSuggestionDismissalStore,
  MAX_PENDING_SUGGESTIONS,
  type SuggestionConnections,
} from "../src/routines/suggestions";
import { createRoutineSuggestionRoutes } from "../src/routines/suggestions-routes";
import { TEST_POOL } from "./support/database";

/**
 * The routine suggestions: what is offered, to whom, and what a press does.
 *
 * Every rule here is one Hermes Agent's routine suggestions make and this deployment keeps for the
 * catalogue's reasons: a card needs a connection that is actually connected, a card made or
 * declined does not come back, at most five are ever on the screen, and 만들기 makes a real routine
 * through the real create path — a row in `laf_routines` with a clock and a trigger token, on the
 * Bot the card named. The service is tested against Postgres because the latch and the dedup are
 * both questions about rows.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const prefix = `routine-suggestions-${randomUUID()}`;
const OWNER = { id: `${prefix}-owner`, role: "user" as const };
const BOT_A = { id: `${prefix}-bot-a`, name: "가게 봇" };
const BOT_B = { id: `${prefix}-bot-b`, name: "리뷰 봇" };

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: OWNER.id, email: `${OWNER.id}@laf.test`, name: OWNER.id });
  await database.insert(agents).values(
    [BOT_A, BOT_B].map((bot) => ({
      id: bot.id,
      name: bot.name,
      type: "remote_ag_ui" as const,
      configuration: {},
    })),
  );
});

afterEach(async () => {
  // Runs cascade with the routine; the latch is scoped to this file's one person.
  await database
    .delete(lafRoutines)
    .where(eq(lafRoutines.createdById, OWNER.id));
  await database
    .delete(lafRoutineSuggestionDismissals)
    .where(eq(lafRoutineSuggestionDismissals.userId, OWNER.id));
});

afterAll(async () => {
  await database.delete(agents).where(inArray(agents.id, [BOT_A.id, BOT_B.id]));
  await database.delete(users).where(eq(users.id, OWNER.id));
  await database.$client.close();
});

const routines = createRoutineService({
  database,
  resolveAgents: async () => ({}),
});

const NOTHING: SuggestionConnections = { accounts: [], sites: [] };

const sites = (...ids: string[]): SuggestionConnections => ({
  accounts: [],
  sites: ids.map((id) => ({ id, status: "connected" })),
});

/** Every site and every account connected: the person for whom every card is eligible. */
const EVERYTHING: SuggestionConnections = {
  accounts: CATALOGUE.map((entry) => ({
    id: entry.key,
    status: "connected",
    title: entry.title,
  })),
  sites: BUSINESS_SITES.map((site) => ({ id: site.id, status: "connected" })),
};

function serviceWith(
  overrides: {
    connections?: SuggestionConnections;
    bots?: { id: string; name: string }[];
  } = {},
) {
  return createRoutineSuggestionService({
    routines,
    dismissals: createSuggestionDismissalStore(database),
    connections: async () => overrides.connections ?? NOTHING,
    bots: async () => overrides.bots ?? [BOT_A],
  });
}

const keysOf = (cards: { key: string }[]) => cards.map((card) => card.key);

describe("the catalogue", () => {
  test("has one entry per key, each with a routine's worth of words", () => {
    const keys = ROUTINE_SUGGESTIONS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of ROUTINE_SUGGESTIONS) {
      expect(entry.name.trim().length).toBeGreaterThan(0);
      expect(entry.instruction.trim().length).toBeGreaterThan(20);
    }
  });

  test("every schedule is one the routine service can arm", () => {
    const from = new Date("2026-09-06T00:00:00Z");
    for (const entry of ROUTINE_SUGGESTIONS) {
      // Throws on a malformed time or an unknown zone; a suggestion that cannot be armed is a
      // 만들기 that fails, which is the one thing a card must never be.
      expect(nextRunAt(entry.schedule, from).getTime()).toBeGreaterThan(
        from.getTime(),
      );
    }
  });

  test("every requirement names a site or an account this product connects", () => {
    const siteIds = new Set(BUSINESS_SITES.map((site) => site.id));
    const accountIds = new Set(CATALOGUE.map((entry) => entry.key));
    const unknown: string[] = [];
    for (const entry of ROUTINE_SUGGESTIONS) {
      for (const requirement of entry.needsAnyOf) {
        const known =
          requirement.kind === "site"
            ? siteIds.has(requirement.id)
            : accountIds.has(requirement.id);
        if (!known) unknown.push(`${entry.key}: ${requirement.id}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  test("speaks the owner's Korean, not the operator's", () => {
    /*
     * The same words `app/tests/owner-vocabulary.test.ts` forbids on an owner's screen. The name
     * and the instruction are stored as the routine and read back on that screen, so they are
     * owner-facing prose that no app-side walk can see.
     */
    const forbidden = [
      "에이전트",
      "코워커",
      "어시스턴트",
      "스레드",
      "플러그인",
      "토큰",
      "컴포넌트",
      "MCP",
    ];
    const offences: string[] = [];
    for (const entry of ROUTINE_SUGGESTIONS) {
      for (const word of forbidden) {
        if (entry.name.includes(word) || entry.instruction.includes(word)) {
          offences.push(`${entry.key}: ${word}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});

describe("what is offered", () => {
  test("nothing, to somebody with no Bot to run it", async () => {
    const service = serviceWith({ connections: EVERYTHING, bots: [] });
    expect(await service.list(OWNER)).toEqual([]);
  });

  test("a card needs one of its connections connected, not merely known", async () => {
    // Nothing connected: only the card that needs nothing.
    expect(keysOf(await serviceWith().list(OWNER))).toEqual(["tax-calendar"]);

    // A site that needs a login again is a connection the person HAD, and no card is offered on it.
    const expired = serviceWith({
      connections: {
        accounts: [],
        sites: [{ id: "baemin-ceo", status: "needs_login" }],
      },
    });
    expect(keysOf(await expired.list(OWNER))).toEqual(["tax-calendar"]);

    // 배민 connected: the cards that can run on it, and not the one that needs a shop.
    const offered = keysOf(
      await serviceWith({ connections: sites("baemin-ceo") }).list(OWNER),
    );
    expect(offered).toEqual([
      "morning-brief",
      "review-watch",
      "weekly-settlement",
      "store-open-check",
      "tax-calendar",
    ]);
    expect(offered).not.toContain("stock-check");
  });

  test("names what the person has, in the words the 연결 screen uses", async () => {
    const [brief] = await serviceWith({
      connections: sites("baemin-ceo"),
    }).list(OWNER);
    expect(brief?.via).toEqual([
      { kind: "site", id: "baemin-ceo", title: "Baemin for Owners" },
    ]);
    // Everything it could have run on stays listed, so a card can say what else would do — and
    // an account this deployment cannot connect is still named, from the catalogue, not by its key.
    expect(brief?.needs.length).toBeGreaterThan(1);
    expect(brief?.needs).toContainEqual({
      kind: "account",
      id: "cafe24",
      title: "Cafe24",
    });

    const enquiries = (
      await serviceWith({
        connections: {
          accounts: [{ id: "gmail", status: "connected", title: "Gmail" }],
          sites: [],
        },
      }).list(OWNER)
    ).find((card) => card.key === "unanswered-enquiries");
    expect(enquiries?.via).toEqual([
      { kind: "account", id: "gmail", title: "Gmail" },
    ]);
  });

  test("at most five, in catalogue order, however many are eligible", async () => {
    const cards = await serviceWith({ connections: EVERYTHING }).list(OWNER);
    expect(cards).toHaveLength(MAX_PENDING_SUGGESTIONS);
    expect(keysOf(cards)).toEqual(
      ROUTINE_SUGGESTIONS.slice(0, MAX_PENDING_SUGGESTIONS).map(
        (entry) => entry.key,
      ),
    );
    // The cap is doing work: the catalogue has more eligible cards than the screen shows.
    expect(ROUTINE_SUGGESTIONS.length).toBeGreaterThan(MAX_PENDING_SUGGESTIONS);
  });
});

describe("만들기", () => {
  test("makes a real routine on the Bot, carrying the key, and the card is gone", async () => {
    const service = serviceWith({ connections: sites("baemin-ceo") });
    const made = await service.accept(OWNER, "morning-brief", BOT_A.id);

    const [row] = await database
      .select()
      .from(lafRoutines)
      .where(eq(lafRoutines.id, made.id));
    const entry = ROUTINE_SUGGESTIONS[0];
    expect(row).toMatchObject({
      agentId: BOT_A.id,
      name: entry?.name,
      instruction: entry?.instruction,
      scheduleKind: "daily",
      dailyLocal: "07:30",
      dailyTimeZone: "Asia/Seoul",
      enabled: true,
      createdById: OWNER.id,
      suggestionKey: "morning-brief",
    });
    // The same create path: the webhook token is minted and shown once, like any routine's.
    expect(made.triggerToken).toBeTruthy();

    expect(keysOf(await service.list(OWNER))).not.toContain("morning-brief");

    // Deleting the routine puts the card back: the key lives on the routine, not in a ledger.
    await routines.remove(OWNER, made.id);
    expect(keysOf(await service.list(OWNER))).toContain("morning-brief");
  });

  test("a routine with the card's name counts as already made, however it was made", async () => {
    await routines.create(OWNER, {
      agentId: BOT_A.id,
      name: "리뷰 감시",
      instruction: "요기요 리뷰를 읽어 주세요.",
      schedule: { kind: "interval", minutes: 60 },
    });
    const cards = await serviceWith({
      connections: sites("yogiyo-ceo"),
    }).list(OWNER);
    expect(keysOf(cards)).not.toContain("review-watch");
  });

  test("goes on the only Bot when none is named, and asks when there are two", async () => {
    const one = serviceWith({ connections: sites("baemin-ceo") });
    const made = await one.accept(OWNER, "morning-brief");
    expect(made.agentId).toBe(BOT_A.id);
    await routines.remove(OWNER, made.id);

    const two = serviceWith({
      connections: sites("baemin-ceo"),
      bots: [BOT_A, BOT_B],
    });
    await expect(two.accept(OWNER, "morning-brief")).rejects.toMatchObject({
      status: 400,
      code: "laf:routine_incomplete",
    });
    const onB = await two.accept(OWNER, "morning-brief", BOT_B.id);
    expect(onB.agentId).toBe(BOT_B.id);
  });

  test("refuses a Bot the person cannot see, and a card that is not on offer", async () => {
    const service = serviceWith({ connections: sites("baemin-ceo") });
    await expect(
      service.accept(OWNER, "morning-brief", BOT_B.id),
    ).rejects.toMatchObject({ status: 400, code: "laf:routine_incomplete" });
    // Eligible for a shop, not for a delivery app: not on this person's screen, so not acceptable.
    await expect(
      service.accept(OWNER, "stock-check", BOT_A.id),
    ).rejects.toMatchObject({
      status: 404,
      code: "laf:routine_suggestion_not_offered",
    });
    await expect(
      service.accept(OWNER, "no-such-card", BOT_A.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await database
        .select({ id: lafRoutines.id })
        .from(lafRoutines)
        .where(eq(lafRoutines.createdById, OWNER.id)),
    ).toEqual([]);
  });
});

describe("다음에", () => {
  test("latches: the card does not come back, whatever gets connected later", async () => {
    const service = serviceWith();
    await service.dismiss(OWNER, "tax-calendar");
    expect(await service.list(OWNER)).toEqual([]);

    // Declined while it was not even eligible, then the site arrives: still declined.
    await service.dismiss(OWNER, "morning-brief");
    const later = serviceWith({ connections: EVERYTHING });
    const offered = keysOf(await later.list(OWNER));
    expect(offered).not.toContain("tax-calendar");
    expect(offered).not.toContain("morning-brief");
    expect(offered).toHaveLength(MAX_PENDING_SUGGESTIONS);

    // Twice is one decision, not a conflict.
    await service.dismiss(OWNER, "tax-calendar");
    const rows = await database
      .select()
      .from(lafRoutineSuggestionDismissals)
      .where(eq(lafRoutineSuggestionDismissals.userId, OWNER.id));
    expect(rows.map((row) => row.suggestionKey).sort()).toEqual([
      "morning-brief",
      "tax-calendar",
    ]);
  });

  test("a key the catalogue does not know is not a card", async () => {
    await expect(
      serviceWith().dismiss(OWNER, "no-such-card"),
    ).rejects.toMatchObject({
      status: 404,
      code: "laf:routine_suggestion_not_offered",
    });
  });
});

describe("the routes", () => {
  const actingAs = (
    actor: typeof OWNER,
  ): MiddlewareHandler<{ Variables: AppVariables }> => {
    return async (context, next) => {
      context.set("actor", {
        id: actor.id,
        email: `${actor.id}@laf.test`,
        role: actor.role,
      });
      await next();
    };
  };

  const appWith = (service: ReturnType<typeof serviceWith>) =>
    new Hono<{ Variables: AppVariables }>().route(
      "/api/routines/suggestions",
      createRoutineSuggestionRoutes(service, actingAs(OWNER)),
    );

  test("read, accept, dismiss — and a card that is not there is a 404 with its code", async () => {
    const app = appWith(serviceWith({ connections: sites("baemin-ceo") }));

    const listed = await app.request("/api/routines/suggestions");
    expect(listed.status).toBe(200);
    const { suggestions } = (await listed.json()) as {
      suggestions: { key: string }[];
    };
    expect(suggestions.length).toBeLessThanOrEqual(MAX_PENDING_SUGGESTIONS);
    expect(keysOf(suggestions)).toContain("morning-brief");

    const accepted = await app.request(
      "/api/routines/suggestions/morning-brief/accept",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: BOT_A.id }),
      },
    );
    expect(accepted.status).toBe(201);
    const { routine } = (await accepted.json()) as {
      routine: { id: string; suggestionKey: string };
    };
    expect(routine.suggestionKey).toBe("morning-brief");

    const dismissed = await app.request(
      "/api/routines/suggestions/review-watch/dismiss",
      { method: "POST" },
    );
    expect(await dismissed.json()).toEqual({ dismissed: true });

    const gone = await app.request(
      "/api/routines/suggestions/review-watch/accept",
      { method: "POST" },
    );
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({
      code: "laf:routine_suggestion_not_offered",
    });
  });
});
