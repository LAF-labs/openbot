import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createApprovalRegistry } from "../src/computer/approvals";
import {
  type ComputerClient,
  ComputerUnavailableError,
  ElementNotFoundError,
  PageLoadTimeoutError,
  StaleSnapshotError,
} from "../src/computer/client";
import { createComputerGateway } from "../src/computer/gateway";
import { createPolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * What the two routes a pane reads say when they cannot answer.
 *
 * MEASURED 2026-09-06: the screen card rendered `error` out of these bodies — "The assistant's
 * computer did not respond in time.", a Playwright call log, once the bare `laf:page_timeout` —
 * under a Korean heading, because a sentence was all the body carried. The server sends facts:
 * `code` is the fact, in the same shape as every other refusal that crosses this boundary, and it
 * has to agree with the status beside it or an operator and a person are told two different
 * stories about one failure.
 */

const SHOT = {
  base64: "aGVsbG8=",
  width: 1280,
  height: 800,
  capturedAt: "2026-09-06T00:00:00.000Z",
};

const STAFF = {
  id: "staff-user",
  email: "staff@laf.test",
  role: "user",
} as const;

/** A computer whose screenshot and read both fail the given way, or succeed when nothing is given. */
function surface(failure?: Error) {
  const fail = async () => {
    if (failure) throw failure;
    return SHOT;
  };
  const client = {
    screenshot: fail,
    read: async () => {
      if (failure) throw failure;
      return { url: "https://example.com", title: "Example", text: "" };
    },
    forBot() {
      return client;
    },
  } as unknown as ComputerClient;
  const auditStore: AuditStore = { insert: async () => {} };
  const gateway = createComputerGateway({
    client,
    auditStore,
    policy: () => ({ deny: [], ask: [], allow: ["true"] }),
    approvals: createApprovalRegistry(),
  });
  const policyStore = createPolicyStore({ deny: [], ask: [], allow: ["true"] });
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", STAFF);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createComputerRoutes(client, gateway, policyStore, requireUser),
  );
  return app;
}

async function answer(app: Hono<{ Variables: AppVariables }>, path: string) {
  const response = await app.request(path);
  const body = (await response.json()) as { error?: string; code?: string };
  return { status: response.status, code: body.code, error: body.error };
}

/**
 * Each failure the client can raise, with the one status and the one code it deserves.
 *
 * The two columns are the point: `statusFor` and `codeFor` are separate functions over the same
 * branches, and this is what holds them to the same answer.
 */
const FAILURES: Array<[string, Error, number, string]> = [
  [
    "the computer is not running",
    new ComputerUnavailableError("The assistant's computer is not running."),
    503,
    "laf:computer_unavailable",
  ],
  [
    "the computer did not answer in time",
    new ComputerUnavailableError(
      "The assistant's computer did not respond in time.",
    ),
    503,
    "laf:computer_unavailable",
  ],
  [
    "a person holds the wheel",
    new ComputerUnavailableError("laf:human_has_control"),
    409,
    "laf:human_has_control",
  ],
  [
    "the page never loaded",
    new PageLoadTimeoutError(),
    504,
    "laf:page_timeout",
  ],
  [
    "the refs are stale",
    new StaleSnapshotError("snapshot 3 is not current"),
    409,
    "laf:snapshot_stale",
  ],
  [
    "the element left the page",
    new ElementNotFoundError("Element e9 is not on the page any more."),
    409,
    "laf:snapshot_stale",
  ],
  [
    "something nobody named",
    new Error("insert into audit_events (...) values ($1, $2)"),
    500,
    "laf:computer_failed",
  ],
];

describe("the screenshot route", () => {
  for (const [when, failure, status, code] of FAILURES) {
    test(`says ${code} with ${status} when ${when}`, async () => {
      const answered = await answer(surface(failure), "/bot-1/screenshot");
      expect({ status: answered.status, code: answered.code }).toEqual({
        status,
        code,
      });
      // `error` is still there for an older reader — a sentence, never the code's twin by accident.
      expect(typeof answered.error).toBe("string");
    });
  }

  test("a refused Bot id is the same fact it always was, and still a 400", async () => {
    const answered = await answer(surface(), "/..%2F..%2Ftmp/screenshot");
    expect({ status: answered.status, code: answered.code }).toEqual({
      status: 400,
      code: "laf:bot_id_invalid",
    });
  });

  test("a screenshot that works carries no code at all", async () => {
    const response = await surface().request("/bot-1/screenshot");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SHOT);
  });
});

describe("the read route", () => {
  // The sibling a pane reads for the page's text: the same failures, the same two columns.
  for (const [when, failure, status, code] of FAILURES) {
    test(`says ${code} with ${status} when ${when}`, async () => {
      const answered = await answer(surface(failure), "/bot-1/read");
      expect({ status: answered.status, code: answered.code }).toEqual({
        status,
        code,
      });
    });
  }
});
