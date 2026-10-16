import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { HUB_FLEET_PATH } from "../../../shared/hub/protocol";
import { createLogger, type LogLevel } from "../../../shared/log";
import { createHubApp } from "../../src/app";
import { hashPass } from "../../src/auth";
import {
  createHubDatabase,
  type HubDatabase,
  migrateHub,
} from "../../src/db/client";
import { signHubFleetBody } from "../../src/fleet";

/**
 * A hub of a test's own: a database made for it beside whatever `DATABASE_URL` names, migrated by
 * the hub's own chain, served on port 0, and dropped at the end. The gate hands each worker its own
 * `DATABASE_URL`; a database derived from it with a random suffix cannot meet another file's.
 */
export type TestHub = {
  url: string;
  database: HubDatabase;
  /** Every log line the hub wrote, as written. */
  lines: { level: LogLevel; line: string }[];
  /** This hub's registry key. */
  fleetKey: string;
  origin: string;
  stop(): Promise<void>;
};

const base = () =>
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:55432/openbot";

export async function startTestHub(
  options: {
    heartbeatMs?: number;
    rotationGraceMs?: number;
    now?: () => Date;
    /** The vault's key; a fresh one unless given, `null` for a hub started without one. */
    vaultKey?: string | null;
  } = {},
): Promise<TestHub> {
  const source = new URL(base());
  const name = `${decodeURIComponent(source.pathname.slice(1))}_hub_${randomBytes(4).toString("hex")}`;
  const admin = postgres({
    ...adminOptions(source),
    max: 1,
    onnotice: () => {},
  });
  await admin.unsafe(`create database "${name}"`);
  await admin.end();
  const target = new URL(source);
  target.pathname = `/${name}`;
  const database = createHubDatabase(target.toString(), { max: 4 });
  await migrateHub(database);

  const lines: TestHub["lines"] = [];
  const log = createLogger("hub", (level, line) => lines.push({ level, line }));
  const fleetKey = randomBytes(32).toString("hex");
  const origin = "https://test.hub.example";
  const { vaultKey, ...rest } = options;
  const { app, websocket } = createHubApp({
    database,
    log,
    publicOrigin: origin,
    fleetSecret: fleetKey,
    privateIp: "10.20.0.5",
    vaultKey:
      vaultKey === null
        ? undefined
        : (vaultKey ?? randomBytes(32).toString("hex")),
    ...rest,
  });
  const server = Bun.serve({
    port: 0,
    fetch: (request, bunServer) => app.fetch(request, { server: bunServer }),
    websocket,
  });
  return {
    url: `http://localhost:${server.port}`,
    database,
    lines,
    fleetKey,
    origin,
    async stop() {
      // Not awaited. Bun 1.3.14's `stop(true)` never resolves while it counts a socket the hub
      // closed itself (a heartbeat or a departure) as pending, though the socket's close handler
      // has run and the peer has seen the close. Stopping is still begun, and the port was 0.
      void server.stop(true);
      await database.close();
      const drop = postgres({ ...adminOptions(source), max: 1 });
      await drop.unsafe(`drop database if exists "${name}" with (force)`);
      await drop.end();
    },
  };
}

function adminOptions(source: URL) {
  return {
    host: source.hostname,
    port: Number(source.port || 5432),
    user: decodeURIComponent(source.username),
    password: decodeURIComponent(source.password),
    database: "postgres",
  };
}

/** A pass the way a VM makes one (`openssl rand -hex 32`). */
export const newPass = () => randomBytes(32).toString("hex");

export type FleetMember = {
  email: string;
  role?: "owner" | "admin" | "member";
  name?: string | null;
  vmOrigin: string;
  pass: string;
  state?: "active" | "left";
};

/** Posts a signed registry body, as laf-control will. */
export async function sendFleet(
  hub: TestHub,
  body: Record<string, unknown>,
  options: { key?: string; id?: string } = {},
): Promise<Response> {
  const raw = JSON.stringify({
    id: options.id ?? randomUUID(),
    at: new Date().toISOString(),
    hub: hub.origin,
    ...body,
  });
  return fetch(`${hub.url}${HUB_FLEET_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-laf-event": String(body.event),
      "x-laf-signature": signHubFleetBody(raw, options.key ?? hub.fleetKey),
    },
    body: raw,
  });
}

export async function putMember(
  hub: TestHub,
  member: FleetMember,
  options: { id?: string } = {},
): Promise<{ id: string; seq?: number }> {
  const response = await sendFleet(
    hub,
    {
      event: "member.put",
      member: {
        email: member.email,
        role: member.role ?? "member",
        name: member.name ?? null,
        vmOrigin: member.vmOrigin,
        vmKeyHash: hashPass(member.pass),
        state: member.state ?? "active",
      },
    },
    options,
  );
  const body = (await response.json()) as {
    ok: boolean;
    member: { id: string };
    seq?: number;
  };
  if (response.status !== 200) {
    throw new Error(`member.put answered ${response.status}`);
  }
  return { id: body.member.id, ...(body.seq ? { seq: body.seq } : {}) };
}

export const asMember = (pass: string, extra: Record<string, string> = {}) => ({
  headers: { authorization: `Bearer ${pass}`, ...extra },
});
