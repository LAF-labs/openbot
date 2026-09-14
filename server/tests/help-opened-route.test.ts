import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { FeedbackStore } from "../src/support/feedback";
import { createSupportRoutes } from "../src/support/routes";

/**
 * `POST /api/support/help-opened`: the guide was opened, and the one row that says so.
 *
 * The page decides "once per visit" (`app/tests/help-opened.test.tsx` presses it); this decides what
 * the row may hold, which is one section key or nothing. The guide's headings are Korean prose, and
 * a client that sent one — or anything else a person might recognise — must find a row that says
 * "no section" rather than a row that kept the words.
 */

const PERSON = {
  id: "reader-user",
  email: "reader@laf.test",
  role: "user",
} as const;

function surface() {
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const feedback: FeedbackStore = {
    record: async () => {
      throw new Error("the help page writes no feedback");
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
    "/api/support",
    createSupportRoutes({ feedback, auditStore }, requireUser),
  );
  return { app, rows };
}

const open = (app: Hono<{ Variables: AppVariables }>, body?: unknown) =>
  app.request("/api/support/help-opened", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("the guide, opened", () => {
  test("one row, the section the address named, under the person who opened it", async () => {
    const { app, rows } = surface();
    const response = await open(app, { section: "routines" });

    expect(response.status).toBe(204);
    expect(rows).toEqual([
      {
        eventType: "support.help_opened",
        targetType: "help",
        targetId: "routines",
        actorUserId: PERSON.id,
        payload: { section: "routines" },
      },
    ]);
  });

  test("no section named is a row that says none", async () => {
    const { app, rows } = surface();
    expect((await open(app, { section: null })).status).toBe(204);
    expect((await open(app, {})).status).toBe(204);
    expect((await open(app)).status).toBe(204);

    expect(rows.map((row) => row.payload)).toEqual([
      { section: null },
      { section: null },
      { section: null },
    ]);
    expect(rows.every((row) => row.targetId === undefined)).toBe(true);
  });

  test.each([
    ["a heading, in Korean", "문제가 생기면"],
    ["an address", "reader@laf.test"],
    ["a sentence", "the review summary has not worked since yesterday"],
    ["a path", "/channel/abc-123"],
    ["a number", 3],
  ])("%s is not a section, and is not kept", async (_label, section) => {
    const { app, rows } = surface();
    await open(app, { section, text: "somebody's words" });

    expect(rows.map((row) => row.payload)).toEqual([{ section: null }]);
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain("somebody's words");
    if (typeof section === "string") expect(everything).not.toContain(section);
  });
});
