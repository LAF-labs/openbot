import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  IDEA_DISMISSAL_PREFIX,
  IDEAS,
  SUPPORT_PROGRAMS_TOOL_REF,
} from "../../shared/ideas/catalogue";
import type { Persona } from "../../shared/persona";
import type { AppVariables } from "../src/auth/guards";
import { createIdeaRoutes } from "../src/ideas/routes";
import { createIdeaService } from "../src/ideas/service";
import {
  createRoutineSuggestionService,
  type SuggestionConnections,
  type SuggestionDismissalStore,
} from "../src/routines/suggestions";

/**
 * 아이디어's route: which cards, in what state, in what order, and 다음에 (muse-shape plan §3.3).
 *
 * The facts come from fakes here because each is a question about composition — the latch is the
 * routine suggestions' own table, tested against Postgres in `routine-suggestions.integration`.
 */

const OWNER = { id: "ideas-owner", role: "user" as const };

function latch(): SuggestionDismissalStore & { rows: string[] } {
  const rows: string[] = [];
  return {
    rows,
    dismissedKeys: async () => [...rows],
    dismiss: async (_userId, key) => {
      if (!rows.includes(key)) rows.push(key);
    },
  };
}

/** Every site the catalogue names, not connected; Gmail offered and connected; no Google Calendar. */
const CONNECTIONS: SuggestionConnections = {
  sites: [
    "baemin-ceo",
    "coupangeats-store",
    "yogiyo-ceo",
    "naver-smartplace",
    "tosspayments",
    "naver-smartstore",
    "coupang-wing",
    "cafe24-admin",
  ].map((id) => ({ id, status: "not_connected" })),
  accounts: [{ id: "gmail", status: "connected", title: "Gmail" }],
};

function service(
  options: {
    persona?: Persona | null;
    shop?: { kind: string | null; places: string[] };
    connections?: SuggestionConnections;
    tools?: string[];
    dismissals?: SuggestionDismissalStore;
  } = {},
) {
  return createIdeaService({
    person: async () => ({
      persona: options.persona ?? null,
      shop: (options.shop ?? { kind: null, places: [] }) as never,
    }),
    connections: async () => options.connections ?? CONNECTIONS,
    tools: async () => new Set(options.tools ?? []),
    dismissals: options.dismissals ?? latch(),
  });
}

describe("the cards on offer", () => {
  test("every persona gets the same keys, in its own order", async () => {
    const lists = await Promise.all(
      (["owner", "student", "worker", "other", null] as const).map(
        async (persona) =>
          (await service({ persona }).list(OWNER)).ideas.map(
            (idea) => idea.key,
          ),
      ),
    );
    const sets = lists.map((keys) => [...keys].sort().join(","));
    expect(new Set(sets).size).toBe(1);
    // And the order differs: the first card is the persona's own.
    const [owner, student, worker] = lists;
    expect(owner?.[0]).not.toBe(student?.[0]);
    expect(student?.[0]).not.toBe(worker?.[0]);
    expect(IDEAS.find((idea) => idea.key === student?.[0])?.lead).toContain(
      "student",
    );
  });

  test("somebody who answered only the shop questions is ordered as 사장님", async () => {
    const answer = await service({
      shop: { kind: "food", places: [] },
    }).list(OWNER);
    expect(answer.persona).toBe("owner");
    expect(
      IDEAS.find((idea) => idea.key === answer.ideas[0]?.key)?.lead,
    ).toContain("owner");
  });

  test("a card waiting on a connection says so, and one with it connected is ready through it", async () => {
    const { ideas } = await service().list(OWNER);
    const reviews = ideas.find((idea) => idea.key === "review-replies");
    expect(reviews?.state).toBe("connect");
    expect(reviews?.via).toEqual([]);
    // Only the doors this deployment offers: no Google profile in the overview, so none named.
    expect(reviews?.needs.map((need) => need.id)).not.toContain(
      "google-business-profile",
    );
    const mail = ideas.find((idea) => idea.key === "unanswered-mail");
    expect(mail?.state).toBe("ready");
    expect(mail?.via).toEqual([
      { kind: "account", id: "gmail", title: "Gmail" },
    ]);
  });

  test("needs_login is not connected", async () => {
    const { ideas } = await service({
      connections: {
        ...CONNECTIONS,
        sites: [{ id: "naver-smartstore", status: "needs_login" }],
      },
    }).list(OWNER);
    expect(ideas.find((idea) => idea.key === "orders-today")?.state).toBe(
      "connect",
    );
  });

  test("what this deployment offers no door to, and a tool the Bot does not hold, are not drawn", async () => {
    const { ideas } = await service().list(OWNER);
    const keys = ideas.map((idea) => idea.key);
    // Google Calendar is not in this deployment's overview at all.
    expect(keys).not.toContain("tomorrow-calendar");
    // No 기업마당 grant: 지원사업 would be a card nothing could answer.
    expect(keys).not.toContain("support-programs");
    const granted = await service({ tools: [SUPPORT_PROGRAMS_TOOL_REF] }).list(
      OWNER,
    );
    expect(granted.ideas.map((idea) => idea.key)).toContain("support-programs");
  });

  test("a card that needs nothing is ready on a deployment with no connections at all", async () => {
    const { ideas } = await service({
      connections: { sites: [], accounts: [] },
    }).list(OWNER);
    expect(ideas.length).toBeGreaterThan(10);
    for (const idea of ideas) expect(idea.state).toBe("ready");
  });
});

describe("다음에", () => {
  test("a dismissed card is gone, latched as idea:<key>", async () => {
    const dismissals = latch();
    const ideas = service({ dismissals });
    await ideas.dismiss(OWNER, "study-plan");
    expect(dismissals.rows).toEqual([`${IDEA_DISMISSAL_PREFIX}study-plan`]);
    const { ideas: left } = await ideas.list(OWNER);
    expect(left.map((idea) => idea.key)).not.toContain("study-plan");
  });

  test("an idea's latch never hides a routine suggestion of the same name", async () => {
    const dismissals = latch();
    await dismissals.dismiss(OWNER.id, `${IDEA_DISMISSAL_PREFIX}tax-calendar`);
    const routines = createRoutineSuggestionService({
      routines: { list: async () => [], create: async () => ({}) as never },
      dismissals,
      connections: async () => ({ sites: [], accounts: [] }),
      bots: async () => [{ id: "bot-1", name: "봇" }],
      limit: 20,
    });
    const keys = (await routines.list(OWNER)).map((card) => card.key);
    expect(keys).toContain("tax-calendar");
  });

  test("the doors: the list behind a session, and an unknown key a 404 with a code", async () => {
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", OWNER as never);
      await next();
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/api/ideas", createIdeaRoutes(service(), requireUser));
    const listed = await app.request("http://laf.local/api/ideas");
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { ideas: { key: string }[] };
    expect(body.ideas.length).toBeGreaterThan(0);
    const unknown = await app.request(
      "http://laf.local/api/ideas/no-such-idea/dismiss",
      { method: "POST" },
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: "laf:idea_unknown",
      code: "laf:idea_unknown",
    });
    const dismissed = await app.request(
      "http://laf.local/api/ideas/word-quiz/dismiss",
      { method: "POST" },
    );
    expect(await dismissed.json()).toEqual({ dismissed: true });
  });
});
