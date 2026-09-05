import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { FUNCTION_NOT_GRANTED } from "../src/audit";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createComponentRoutes } from "../src/components/routes";
import type { ComponentStore } from "../src/components/store";

/**
 * What one decision covers.
 *
 * A component is allowed by two grants: the Bot may use it, and it may read the data it draws. Both
 * are enforced when the data is fetched, which happens while the component renders. The decision is
 * asked before that, and answers whoever asked for the component, so it has to speak for the data
 * as well when the caller says which data that is.
 */

const GRANTED = "recentRefusals";
const WITHHELD = "botActivity";

const store = {
  decide: async () => ({ allowed: true as const, description: "Published." }),
  mayCall: async (_name: string, functionName: string) =>
    functionName === GRANTED,
} as unknown as ComponentStore;

const asSignedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { id: "u1", email: "someone@laf.test", role: "user" });
  return next();
};

function app() {
  return new Hono().route(
    "/components",
    createComponentRoutes(store, asSignedIn),
  );
}

async function decide(body: Record<string, unknown>) {
  const response = await app().request(
    "http://laf.local/components/showActivityReport/decision",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return (await response.json()) as {
    allowed: boolean;
    reason?: string;
    function?: string;
  };
}

describe("deciding a component", () => {
  test("allows one whose Bot holds it and which names no data", async () => {
    expect(await decide({ agentId: "risk-analyst" })).toEqual({
      allowed: true,
    });
  });

  test("allows one whose data it may also read", async () => {
    expect(
      await decide({ agentId: "risk-analyst", functions: [GRANTED] }),
    ).toEqual({ allowed: true });
  });

  test("refuses one that would be drawn empty, and says which grant is missing", async () => {
    const decision = await decide({
      agentId: "risk-analyst",
      functions: [WITHHELD],
    });
    expect(decision.allowed).toBe(false);
    // The code says WHICH refusal; the field beside it says which grant. They used to be one
    // English sentence, which is exactly why the name is a field now — the surface says the words
    // and cannot say them without the fact.
    expect(decision.reason).toBe(FUNCTION_NOT_GRANTED);
    expect(decision.function).toBe(WITHHELD);
  });

  test("refuses when any one of the functions is withheld", async () => {
    const decision = await decide({
      agentId: "risk-analyst",
      functions: [GRANTED, WITHHELD],
    });
    expect(decision.allowed).toBe(false);
  });

  test("ignores anything in the list that is not a name", async () => {
    expect(
      await decide({ agentId: "risk-analyst", functions: [1, null, {}] }),
    ).toEqual({ allowed: true });
  });
});

/**
 * WHAT A FAILED READ IS ALLOWED TO WRITE DOWN.
 *
 * Every data function is a query, and a Drizzle query error puts the SQL it sent AND its bound
 * parameters into `message`. That string went into the `component.function_failed` row verbatim —
 * so the one row written when a read fails was the row most likely to hold the read itself, in a
 * trail that is append-only by design and cannot be edited afterwards.
 */
describe("a data function that threw", () => {
  const failing = (error: Error) =>
    ({
      decide: async () => ({ allowed: true as const, description: "ok" }),
      mayCall: async () => true,
      callFunction: async () => {
        throw error;
      },
    }) as unknown as ComponentStore;

  async function call(error: Error) {
    const rows: AuditEventInput[] = [];
    const auditStore: AuditStore = {
      insert: async (event) => void rows.push(event),
    };
    const response = await new Hono()
      .route(
        "/components",
        createComponentRoutes(failing(error), asSignedIn, auditStore),
      )
      .request("http://laf.local/components/showActivityReport/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "risk-analyst",
          function: "recentRefusals",
        }),
      });
    return { rows, response };
  }

  test("is recorded by its database code, never by the statement it sent", async () => {
    const error = new Error(
      'select * from "audit_events" where owner = $1 — params: ["010-2222-3333"]',
    ) as Error & { query: string; params: unknown[]; cause: { code: string } };
    error.query = 'select * from "audit_events" where owner = $1';
    error.params = ["010-2222-3333"];
    error.cause = { code: "42P01" };

    const { rows, response } = await call(error);

    expect(response.status).toBe(502);
    const row = rows.find(
      (entry) => entry.eventType === "component.function_failed",
    );
    expect(row?.payload).toMatchObject({ failure: "database error (42P01)" });
    // The whole row, not the one field: a trail this file cannot rewrite is the wrong place to
    // discover later that the statement went in through another key.
    const written = JSON.stringify(rows);
    expect(written).not.toContain("select * from");
    expect(written).not.toContain("010-2222-3333");
  });

  test("keeps saying what an ordinary failure was", async () => {
    const { rows } = await call(new Error("The report is not available."));

    expect(
      rows.find((entry) => entry.eventType === "component.function_failed")
        ?.payload,
    ).toMatchObject({ failure: "The report is not available." });
  });
});
