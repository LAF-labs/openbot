import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import type { AuthService } from "../src/auth/guards";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { loadConfig } from "../src/config";
import {
  createCredentialAdminService,
  createCredentialStore,
} from "../src/credentials";
import { createDatabase, type Database } from "../src/db/client";
import { agentProfiles, agents, lafRoutines, users } from "../src/db/schema";
import { createRoutineService } from "../src/routines/service";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * What a thrown route error becomes on the wire, and in the operator log — against the real app,
 * the real routine service and the real database.
 *
 * There was no `app.onError`, so a route that threw fell through to Hono's default: `500 Internal
 * Server Error` as text/plain, and `console.error(err)` — the whole error object. Audit A1-2
 * (2026-09-10) sent one request naming a Bot that does not exist, as the local administrator, and
 * the foreign-key failure put the SQL AND its bound parameters — the routine's instruction, the
 * trigger token's hash — into the log, thirty frames deep.
 *
 * The auditor's request is sent here as it was sent then. It is a 404 now, before any row is
 * written; and the boundary behind it is proven with the same request losing a race — the Bot
 * deleted between the check and the insert — which reaches the same foreign key for real.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const config = loadConfig(testEnvironment());
const run = randomUUID().slice(0, 8);

const PERSON = `route-boundary-${run}`;
const BOT = `agent_boundary_${run}`;
/** What a person might really write into a routine, and must never read back out of `docker logs`. */
const INSTRUCTION = `로그인 비번은 1234로 하고 재고를 확인해줘 ${run}`;

/** Sessions as this file mints them: whoever the header names, in the role the test gives. */
function authAs(role: "admin" | "user") {
  const auth: AuthService = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({
        user: { id: PERSON, email: `${PERSON}@laf.test` },
      }),
    },
  };
  return { auth, roles: { rolesForUser: async () => [role] } };
}

/** The app as `main.ts` builds it, as far as these routes reach: routines and credentials. */
function appWith(role: "admin" | "user", routineDatabase: Database = database) {
  const { auth, roles } = authAs(role);
  const routineService = createRoutineService({
    database: routineDatabase,
    resolveAgents: async () => ({}),
  });
  const auditStore = createAuditStore(database);
  // Positional, so every slot up to the routines is named; see the warning on `createApp`.
  return createApp(
    config,
    auth,
    roles,
    undefined, // auditReader
    createCredentialAdminService(
      config.keyEncryptionKey,
      createCredentialStore(database),
      auditStore,
    ),
    undefined, // packageStatusReader
    undefined, // onboarding
    undefined, // copilotHandler
    undefined, // computerClient
    undefined, // computerGateway
    undefined, // computerPolicy
    undefined, // agentProfileStore
    undefined, // channelStore
    undefined, // channelEvents
    undefined, // auditStore
    undefined, // componentStore
    undefined, // pluginStore
    undefined, // sandboxedStore
    // The routine routes are mounted beside the thread routes, so this is what mounts them.
    createThreadIdentity(`boundary-${run}`),
    undefined, // approvals
    undefined, // coworkerCall
    routineService,
  );
}

/** Every line anything printed while `act` ran, from every console method a logger could use. */
async function printedDuring<T>(
  act: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const keep = (...parts: unknown[]) => {
    lines.push(
      parts
        .map((part) =>
          part instanceof Error
            ? `${part.message}\n${JSON.stringify(part)}\n${part.stack ?? ""}`
            : String(part),
        )
        .join(" "),
    );
  };
  const spies = (["error", "warn", "log", "info", "debug"] as const).map(
    (method) => spyOn(console, method).mockImplementation(keep),
  );
  try {
    return { result: await act(), lines };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

function events(lines: readonly string[]): Record<string, unknown>[] {
  return lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as unknown;
      return parsed && typeof parsed === "object"
        ? [parsed as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

const routineBody = (agentId: string) =>
  JSON.stringify({
    agentId,
    name: "아침 보고",
    instruction: INSTRUCTION,
    schedule: { kind: "interval", minutes: 30 },
  });

async function post(
  app: ReturnType<typeof appWith>,
  path: string,
  body = "{}",
) {
  const response = await app.request(`http://laf.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    text: await response.text(),
  };
}

/** Nothing of the request, and nothing of the statement, anywhere a line went. */
function expectNothingOfTheRequestIn(lines: readonly string[]) {
  const everything = lines.join("\n");
  expect(everything).not.toContain(INSTRUCTION);
  expect(everything).not.toContain("비번");
  expect(everything).not.toContain(BOT);
  expect(everything).not.toMatch(/insert into/i);
  expect(everything).not.toMatch(/params:/);
  expect(everything).not.toMatch(/^\s*at /m);
}

afterAll(async () => {
  await database.delete(lafRoutines).where(eq(lafRoutines.createdById, PERSON));
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.delete(users).where(eq(users.id, PERSON));
});

describe("the route error boundary", () => {
  test("the auditor's unknown Bot, as the administrator: a 404 fact, and not a line of it logged", async () => {
    const { result, lines } = await printedDuring(() =>
      post(appWith("admin"), "/api/routines", routineBody("agent_nope")),
    );

    expect(result.status).toBe(404);
    expect(result.type).toContain("application/json");
    // The code; what rides beside it on a route's own refusal is `error-codes.test.ts`'s to pin.
    expect(JSON.parse(result.text)).toMatchObject({
      code: "laf:bot_not_found",
    });
    // A refusal is the request's news, not the operator's: nothing was printed at all.
    expect(lines).toEqual([]);
  });

  test("the same request losing a race to the foreign key: laf:internal, and one line of facts", async () => {
    await database
      .insert(users)
      .values({ id: PERSON, email: `${PERSON}@laf.test`, name: "Boundary" })
      .onConflictDoNothing();
    await database.insert(agents).values({
      id: BOT,
      name: "Boundary Bot",
      type: "remote_ag_ui",
      configuration: {},
    });
    await database.insert(agentProfiles).values({
      agentId: BOT,
      ownerUserId: PERSON,
      title: "Boundary",
      roleDescription: "Loses a race.",
      avatarSeed: BOT,
    });
    /*
     * The Bot is there when `create` asks whose it is, and gone by the time the insert names it —
     * its owner deleting it in the same instant. The delete runs on the pool the moment the routine
     * service opens its transaction, so the insert inside meets the real foreign key.
     */
    const racing = new Proxy(database, {
      get(target, key) {
        if (key === "transaction") {
          return async (...args: Parameters<Database["transaction"]>) => {
            await target.delete(agents).where(eq(agents.id, BOT));
            return target.transaction(...args);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const { result, lines } = await printedDuring(() =>
      post(appWith("user", racing), "/api/routines", routineBody(BOT)),
    );

    expect(result.status).toBe(500);
    expect(result.type).toContain("application/json");
    expect(JSON.parse(result.text)).toEqual({
      code: "laf:internal",
    });

    // One line, from the logger, naming the route pattern and the SQLSTATE — the kind of failure.
    expect(events(lines)).toEqual([
      expect.objectContaining({
        level: "error",
        svc: "server",
        event: "route_failed",
        method: "POST",
        route: "/api/routines",
        reason: "database error (23503)",
      }),
    ]);
    expect(lines).toHaveLength(1);
    expectNothingOfTheRequestIn(lines);
  });

  test("an administrator revoking a credential that is not there is told so, not a 500", async () => {
    const { result, lines } = await printedDuring(() =>
      post(
        appWith("admin"),
        "/api/admin/credentials/00000000-0000-4000-8000-000000000000/revoke",
      ),
    );
    expect(result.status).toBe(404);
    expect(JSON.parse(result.text)).toEqual({
      code: "laf:credential_not_found",
    });
    expect(lines).toEqual([]);
  });

  test("an id that cannot be one is bad input: 400, and a warning without the id", async () => {
    const id = `not-a-uuid-${run}`;
    const { result, lines } = await printedDuring(() =>
      post(appWith("admin"), `/api/admin/credentials/${id}/revoke`),
    );
    expect(result.status).toBe(400);
    expect(JSON.parse(result.text)).toEqual({
      code: "laf:bad_request",
    });
    expect(events(lines)).toEqual([
      expect.objectContaining({
        level: "warn",
        event: "route_refused_value",
        route: "/api/admin/credentials/:credentialId/revoke",
        reason: "database error (22P02)",
      }),
    ]);
    expect(lines.join("\n")).not.toContain(id);
  });

  test("a path nothing is mounted on is a 404 fact, not text/plain", async () => {
    const response = await appWith("user").request(
      "http://laf.test/api/nonexistent",
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      code: "laf:not_found",
    });
  });
});
