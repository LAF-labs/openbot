import { count, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import {
  HUB_FACTS,
  HUB_PREFIX,
  HUB_PROTOCOL,
  HUB_SYNC_LIMIT,
  type HubFailure,
  type HubMe,
  type HubRole,
} from "../../shared/hub/protocol";
import type { Logger } from "../../shared/log";
import { type MemberVariables, requireMember } from "./auth";
import type { HubDatabase } from "./db/client";
import { hubMembers, hubWorkspace } from "./db/schema";
import { createListeners, eventsSince, headSeq } from "./events";
import { type BlobMirror, countUnmirrored } from "./files/mirror";
import { fileRoutes } from "./files/routes";
import { fleetRoutes } from "./fleet";
import { countIdempotency } from "./idempotency";
import { roomRoutes } from "./rooms";
import { searchRoute } from "./search";
import { memoryRoutes } from "./memory";
import { skillRoutes } from "./skills";
import { eventSocket } from "./socket";
import { readVersions } from "./versions";

export type HubAppOptions = {
  database: HubDatabase;
  log: Logger;
  /** `HUB_PUBLIC_ORIGIN`. */
  publicOrigin: string;
  /** `HUB_FLEET_SECRET`. */
  fleetSecret: string | undefined;
  /** `HUB_PRIVATE_IP`: given to members so a VM in the same network tries it first. */
  privateIp: string | null;
  /** `HUB_FILES_DIR`, or null when this hub keeps no files. */
  filesDir?: string | null;
  /** `HUB_FILES_QUOTA_BYTES`, or null. */
  filesQuotaBytes?: number | null;
  /** The largest file taken; `HUB_FILE_MAX_BYTES` unless a test sets a smaller one. */
  fileMaxBytes?: number;
  /** The copy of each blob to the company's bucket; absent, nothing is copied (and `/metrics` says so). */
  mirror?: BlobMirror;
  heartbeatMs?: number;
  rotationGraceMs?: number;
  now?: () => Date;
};

/** A non-negative whole number from a query string, or null when it is anything else. */
function cursorOf(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (!/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

/**
 * The hub's routes. Built by a function so a test can run the real thing on port 0 against its own
 * database; `src/index.ts` is the one caller that serves it.
 */
export function createHubApp(options: HubAppOptions) {
  const { database, log } = options;
  const listeners = createListeners();
  const { upgradeWebSocket, websocket } = createBunWebSocket();
  const app = new Hono();
  const hub = new Hono<{ Variables: MemberVariables }>();

  /**
   * Whether this hub can serve, for Caddy's healthcheck and laf-control's watch. Answers 503 when
   * the database does not, by the product's health rule: a dial that cannot go red is not a dial.
   */
  hub.get("/health", async (context) => {
    try {
      await database.execute(sql`select 1`);
      return context.json({ status: "ok", checks: { db: "ok" } });
    } catch {
      return context.json(
        { status: "degraded", checks: { db: "unreachable" } },
        503,
      );
    }
  });

  /**
   * Counts only, for `laf collect`. Caddy does not route this path from outside (`hub/Caddyfile`):
   * it is read on the hub VM itself, through the loopback port compose publishes.
   */
  hub.get("/metrics", async (context) => {
    const members = await database
      .select({ state: hubMembers.state, n: count() })
      .from(hubMembers)
      .groupBy(hubMembers.state);
    const byState = Object.fromEntries(
      members.map((row) => [row.state, row.n]),
    );
    return context.json({
      ok: true,
      members: { active: byState.active ?? 0, left: byState.left ?? 0 },
      events: { head: await headSeq(database) },
      sockets: listeners.size,
      idempotencyKept: await countIdempotency(database),
      // Blobs a live file holds that the bucket does not: what a lost disk would lose. With the
      // door "off" or "invalid" it only grows.
      unmirrored: await countUnmirrored(database),
      mirror: options.mirror?.door() ?? "off",
    });
  });

  hub.route(
    "/fleet",
    fleetRoutes({
      database,
      listeners,
      secret: options.fleetSecret,
      hubOrigin: options.publicOrigin,
      ...(options.now ? { now: options.now } : {}),
      ...(options.rotationGraceMs
        ? { rotationGraceMs: options.rotationGraceMs }
        : {}),
    }),
  );

  const member = requireMember(database);
  const filesDir = options.filesDir ?? null;

  hub.route(
    "/files",
    fileRoutes({
      database,
      listeners,
      member,
      filesDir,
      quotaBytes: options.filesQuotaBytes ?? null,
      log,
      ...(options.fileMaxBytes ? { fileMaxBytes: options.fileMaxBytes } : {}),
      ...(options.mirror ? { onBlobWritten: options.mirror.kick } : {}),
    }),
  );
  hub.route("/search", searchRoute({ database, member, filesDir }));

  hub.get("/me", member, async (context) => {
    const self = context.get("member");
    const [workspace] = await database
      .select({ id: hubWorkspace.id, name: hubWorkspace.name })
      .from(hubWorkspace)
      .where(eq(hubWorkspace.one, true));
    const body: HubMe = {
      ok: true,
      member: { id: self.id, role: self.role as HubRole, name: self.name },
      workspace: workspace ?? null,
      protocol: HUB_PROTOCOL,
      privateIp: options.privateIp,
      seq: await headSeq(database),
      versions: await readVersions(database),
    };
    return context.json(body);
  });

  hub.route("/skills", skillRoutes({ database, listeners, member }));
  hub.route(
    "/memory",
    memoryRoutes({
      database,
      listeners,
      member,
      ...(options.now ? { now: options.now } : {}),
    }),
  );

  hub.get("/sync", member, async (context) => {
    const since = cursorOf(context.req.query("since"), 0);
    const limit = cursorOf(context.req.query("limit"), HUB_SYNC_LIMIT);
    if (since === null || limit === null || limit < 1) {
      return context.json(
        { ok: false, code: "laf:request_invalid", field: "since" },
        400,
      );
    }
    const page = await eventsSince(
      database,
      context.get("member").id,
      since,
      Math.min(limit, HUB_SYNC_LIMIT),
    );
    return context.json({ ok: true, ...page });
  });

  hub.route("/rooms", roomRoutes({ database, listeners, member }));

  hub.get(
    "/events",
    member,
    async (context, next) => {
      const since = context.req.query("since");
      if (since !== undefined && cursorOf(since, 0) === null) {
        return context.json(
          { ok: false, code: "laf:request_invalid", field: "since" },
          400,
        );
      }
      await next();
    },
    eventSocket({
      database,
      listeners,
      upgradeWebSocket,
      log,
      ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
    }),
  );

  app.route(HUB_PREFIX, hub);
  app.notFound((context) => {
    const body: HubFailure = { ok: false, code: HUB_FACTS.notFound };
    return context.json(body, 404);
  });
  app.onError((error, context) => {
    log.error("request_failed", { path: context.req.path, error });
    const body: HubFailure = { ok: false, code: "laf:hub_failed" };
    return context.json(body, 500);
  });

  return { app, websocket, listeners };
}
