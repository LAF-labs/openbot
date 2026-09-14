import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAccountDeletion } from "../src/account/deletion";
import { createAccountExport } from "../src/account/export";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { createAuth } from "../src/auth";
import { createSignInAllowlist } from "../src/auth/allowlist";
import { createRoleRepository } from "../src/auth/guards";
import { createRequestActors } from "../src/auth/request-actor";
import {
  createSessionRevocation,
  SESSION_REVOKED,
} from "../src/auth/session-revocation";
import type { websocket as channelSocket } from "../src/channels/socket";
import { createDemonstrationRecorder } from "../src/computer/demonstration";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { sessions, userRoles, users } from "../src/db/schema";
import {
  createLiveScreen,
  SCREEN_SESSION_ENDED,
  type SocketData,
} from "../src/live-screen";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * A PERSON WHO IS REMOVED IS OUT — ON THE NEXT REQUEST, NOT IN SEVEN DAYS.
 *
 * MEASURED 2026-09-14 on a local stack (`dab7754`, a stub broker): staff struck off
 * `SIGN_IN_ALLOWED_EMAILS` and the server restarted were refused a new sign-in, and the cookie they
 * already held answered `GET /api/me` 200 and renewed on use. The administrator's delete route
 * removed the rows, and the old cookie then read as nobody signed in, telling the person nothing.
 *
 * Driven here the way a deployment runs it: real better-auth over the test database, sessions minted
 * by its own adapter and cookies signed the way it signs them (it verifies them on every request, so
 * a cookie made wrong fails the "still admitted" half of every test), the app `main.ts` composes, the
 * real account deletion, and the live screen on a real Bun server. A "restart" is a second deployment
 * built over the same tables with the shorter list, which is all a restart is to a session row.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:55432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const run = randomUUID().slice(0, 8);
const ORIGIN = "http://sessions.laf.test";

type Person = { id: string; email: string; role: "admin" | "user" };
const person = (label: string, role: Person["role"] = "user"): Person => ({
  id: `revoke-${label}-${run}`,
  email: `revoke-${label}-${run}@laf.test`,
  role,
});
const OWNER = person("owner", "admin");
const REMOVED_BY_ADMIN = person("staff-a");
const STRUCK_OFF = person("staff-b");
const SWEPT = person("staff-c");
const LEAVER = person("leaver");
const WATCHER = person("staff-d");
const PEOPLE = [OWNER, REMOVED_BY_ADMIN, STRUCK_OFF, SWEPT, LEAVER, WATCHER];
const IDS = PEOPLE.map((one) => one.id);

/** One deployment of this server over the test database, reading the sign-in list it is given. */
function deploymentWith(admitted: Person[]) {
  const config = loadConfig(
    testEnvironment({
      DATABASE_URL: databaseUrl,
      TRUSTED_ORIGINS: ORIGIN,
      INITIAL_ADMIN_EMAILS: OWNER.email,
      SIGN_IN_ALLOWED_EMAILS: admitted.map((one) => one.email).join(","),
    }),
  );
  if (!config.auth) throw new Error("the test environment has no sign-in");
  const auth = createAuth(config, database);
  const revocation = createSessionRevocation({
    database,
    allowlist: createSignInAllowlist(config.auth),
  });
  const roles = createRoleRepository(database);
  const args: Parameters<typeof createApp> = [config, auth, roles];
  // `accountService` and, last, `sessionAdmission` — by position; the compiler holds each index to
  // its type, so a wrong one does not build.
  args[34] = {
    exporter: createAccountExport(database),
    deletion: createAccountDeletion({ database, sessions: revocation }),
    auditStore: createAuditStore(database),
  };
  args[44] = revocation;
  const app = createApp(...args);
  const actors = createRequestActors({
    devNoAuth: false,
    auth,
    roles,
    admission: revocation,
  });
  return { auth, revocation, app, actors };
}

type Deployment = ReturnType<typeof deploymentWith>;

/**
 * A session for this person, as better-auth's callback makes one — through its adapter, so the
 * create hook's own list check runs — and the cookie it would set, signed as better-call signs it.
 */
async function signIn(deployment: Deployment, who: Person): Promise<string> {
  const context = await deployment.auth.$context;
  const session = await context.internalAdapter.createSession(who.id);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(context.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(session.token),
  );
  const signature = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`;
}

/** `GET /api/me` with a cookie: the status, and who it answered for or the code it refused with. */
async function me(deployment: Deployment, cookie: string) {
  const response = await deployment.app.request("http://laf.local/api/me", {
    headers: { cookie },
  });
  const body = (await response.json()) as {
    code?: string;
    user?: { email?: string };
  };
  return {
    status: response.status,
    ...(body.user ? { email: body.user.email } : { code: body.code }),
  };
}

const sessionRowsOf = async (who: Person) =>
  (
    await database
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, who.id))
  ).length;

const post = (
  deployment: Deployment,
  path: string,
  cookie: string,
  body: unknown = {},
) =>
  deployment.app.request(`http://laf.local${path}`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  for (const one of PEOPLE) {
    await database
      .insert(users)
      .values({ id: one.id, email: one.email, name: one.id });
    await database.insert(userRoles).values({ userId: one.id, role: one.role });
  }
});

afterAll(async () => {
  // Scoped to this file's people. The deletions already took some of them, and their sessions with them.
  await database.delete(sessions).where(inArray(sessions.userId, IDS));
  await database.delete(users).where(inArray(users.id, IDS));
  await database.$client.close();
});

describe("removed by an administrator", () => {
  test("the old cookie gets 401 laf:session_revoked on the next request, and the session rows are gone", async () => {
    const deployment = deploymentWith(PEOPLE);
    const owner = await signIn(deployment, OWNER);
    const staff = await signIn(deployment, REMOVED_BY_ADMIN);
    expect(await me(deployment, staff)).toEqual({
      status: 200,
      email: REMOVED_BY_ADMIN.email,
    });

    const removed = await post(
      deployment,
      `/api/admin/users/${REMOVED_BY_ADMIN.id}/delete`,
      owner,
    );
    expect(removed.status).toBe(200);

    expect(await sessionRowsOf(REMOVED_BY_ADMIN)).toBe(0);
    expect(await me(deployment, staff)).toEqual({
      status: 401,
      code: SESSION_REVOKED,
    });
    // Every time, not once: a second tab asking a moment later is told the same.
    expect(await me(deployment, staff)).toEqual({
      status: 401,
      code: SESSION_REVOKED,
    });
    // And the person who removed them is untouched.
    expect(await me(deployment, owner)).toEqual({
      status: 200,
      email: OWNER.email,
    });
  });

  test("leaving by one's own hand is a plain sign-out: nobody else decided it", async () => {
    const deployment = deploymentWith(PEOPLE);
    const leaver = await signIn(deployment, LEAVER);
    const left = await post(deployment, "/api/me/delete", leaver, {
      confirm: LEAVER.email,
    });
    expect(left.status).toBe(200);
    expect(await sessionRowsOf(LEAVER)).toBe(0);
    expect(await me(deployment, leaver)).toEqual({
      status: 401,
      code: "laf:unauthenticated",
    });
  });
});

describe("struck off the sign-in list, and the server restarted", () => {
  test("the next request gets 401 laf:session_revoked, every session the person held goes, and the owner stays in", async () => {
    const before = deploymentWith(PEOPLE);
    const owner = await signIn(before, OWNER);
    const phone = await signIn(before, STRUCK_OFF);
    const laptop = await signIn(before, STRUCK_OFF);
    expect(await me(before, phone)).toEqual({
      status: 200,
      email: STRUCK_OFF.email,
    });

    // `laf member remove`, then the push: the same tables, a process that read a shorter list.
    const after = deploymentWith(PEOPLE.filter((one) => one !== STRUCK_OFF));

    expect(await me(after, phone)).toEqual({
      status: 401,
      code: SESSION_REVOKED,
    });
    // Revoked in the store, not refused and left there for `/api/auth/*` to renew — both devices.
    expect(await sessionRowsOf(STRUCK_OFF)).toBe(0);
    expect(await me(after, laptop)).toEqual({
      status: 401,
      code: SESSION_REVOKED,
    });
    // better-auth's own session read agrees: there is nothing left to renew.
    const direct = await after.auth.handler(
      new Request("http://localhost:3001/api/auth/get-session", {
        headers: { cookie: laptop },
      }),
    );
    expect(await direct.json()).toBeNull();

    expect(await me(after, owner)).toEqual({
      status: 200,
      email: OWNER.email,
    });
  });

  test("the boot sweep ends them before the person knocks", async () => {
    const before = deploymentWith(PEOPLE);
    const staff = await signIn(before, SWEPT);
    const owner = await signIn(before, OWNER);
    expect(await sessionRowsOf(SWEPT)).toBe(1);

    const after = deploymentWith(PEOPLE.filter((one) => one !== SWEPT));
    // Narrowed to this file's people: see `sweep` on why a test may not sweep the shared database.
    expect(await after.revocation.sweep(IDS)).toEqual({
      people: 1,
      sessions: 1,
    });
    expect(await sessionRowsOf(SWEPT)).toBe(0);
    expect(await me(after, staff)).toEqual({
      status: 401,
      code: SESSION_REVOKED,
    });
    expect(await me(after, owner)).toEqual({
      status: 200,
      email: OWNER.email,
    });
  });

  test("a list that is not set sweeps nobody, and a cookie that never was is only signed out", async () => {
    const open = deploymentWith([]);
    expect(await open.revocation.sweep(IDS)).toEqual({
      people: 0,
      sessions: 0,
    });
    expect(
      await me(open, "better-auth.session_token=never-issued.c2lnbmF0dXJl"),
    ).toEqual({ status: 401, code: "laf:unauthenticated" });
  });
});

describe("the live screen of a removed person", () => {
  test("closes when an administrator removes them, and the owner's screen stays open", async () => {
    // A computer that opens every stream and sends one frame, as `live-screen.test.ts` has it.
    const computer = Bun.serve<{ opened: true }>({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, server) {
        return server.upgrade(request, { data: { opened: true } })
          ? undefined
          : new Response("no", { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send("frame");
        },
        message() {},
      },
    });
    const deployment = deploymentWith(PEOPLE);
    const live = createLiveScreen({
      computer: {
        baseUrl: `http://127.0.0.1:${computer.port}/`,
        token: "computer-token",
        allowPrivateHosts: false,
      },
      trustedOrigins: [ORIGIN],
      actorOf: deployment.actors.resolveOrNull,
      // A Bot nobody made, which the rule lets every signed-in person watch.
      botOwner: async () => null,
      screenViews: { opened: async () => {}, replayed: async () => {} },
      demonstrations: createDemonstrationRecorder(),
      sessions: deployment.revocation,
    });
    const server = Bun.serve<SocketData>({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, bun) {
        const botId = live.botOf(request);
        if (botId !== null) return live.upgrade(request, bun, botId);
        return deployment.app.fetch(request, { server: bun });
      },
      websocket: live.websocket({
        open() {},
        message() {},
        close() {},
      } as unknown as typeof channelSocket),
    });

    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await Bun.sleep(20);
      }
    };
    const openScreen = async (cookie: string) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${server.port}/api/computers/agent_shared-screen/stream`,
        { headers: { origin: ORIGIN, cookie } } as never,
      );
      const seen = { frames: 0, closedWith: null as number | null };
      socket.onmessage = () => {
        seen.frames += 1;
      };
      socket.onclose = (event) => {
        seen.closedWith = event.code;
      };
      await until(() => seen.frames > 0);
      return { socket, seen };
    };

    try {
      const owner = await signIn(deployment, OWNER);
      const staff = await signIn(deployment, WATCHER);
      const ownerScreen = await openScreen(owner);
      const staffScreen = await openScreen(staff);
      expect(live.openFor(WATCHER.id)).toBe(1);

      const removed = await fetch(
        `http://127.0.0.1:${server.port}/api/admin/users/${WATCHER.id}/delete`,
        {
          method: "POST",
          headers: {
            cookie: owner,
            origin: ORIGIN,
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      expect(removed.status).toBe(200);

      await until(() => staffScreen.seen.closedWith !== null);
      expect(staffScreen.seen.closedWith).toBe(SCREEN_SESSION_ENDED);
      expect(live.openFor(WATCHER.id)).toBe(0);
      // Nobody else's screen went with it.
      await Bun.sleep(100);
      expect(ownerScreen.seen.closedWith).toBeNull();
      expect(ownerScreen.socket.readyState).toBe(WebSocket.OPEN);

      // And the same cookie cannot open another.
      const again = await fetch(
        `http://127.0.0.1:${server.port}/api/computers/agent_shared-screen/stream`,
        {
          headers: {
            upgrade: "websocket",
            connection: "Upgrade",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
            origin: ORIGIN,
            cookie: staff,
          },
        },
      );
      expect(again.status).toBe(401);
      ownerScreen.socket.close();
    } finally {
      server.stop(true);
      computer.stop(true);
    }
  });
});
