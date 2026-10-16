import { HUB_PROTOCOL } from "../../shared/hub/protocol";
import { buildOf, createLogger, reportCrashes } from "../../shared/log";
import { createHubApp } from "./app";
import { readHubConfig } from "./config";
import { createHubDatabase, migrateHub } from "./db/client";
import { sweepIdempotency } from "./idempotency";

const log = createLogger("hub");
reportCrashes(log);

const config = readHubConfig(process.env);
const database = createHubDatabase(config.databaseUrl);
await migrateHub(database);
await sweepIdempotency(database);

const { app, websocket, listeners } = createHubApp({
  database,
  log,
  publicOrigin: config.publicOrigin,
  fleetSecret: config.fleetSecret,
  privateIp: config.privateIp,
  vaultKey: config.vaultKey,
});

const server = Bun.serve({
  port: config.port,
  // Longer than the heartbeat's three missed pings, so the hub's own silence rule closes a quiet
  // socket and Bun's idle cut never does it first.
  idleTimeout: 60,
  fetch: (request, bunServer) => app.fetch(request, { server: bunServer }),
  websocket,
});

// Answers older than a day are of no use to a retry; an hour is often enough to keep the table
// small and rare enough to cost nothing.
const sweep = setInterval(
  () => {
    sweepIdempotency(database).catch((error: unknown) =>
      log.warn("idempotency_sweep_failed", { error }),
    );
  },
  60 * 60 * 1000,
);

log.info("boot", {
  ...buildOf(process.env),
  port: server.port,
  protocol: HUB_PROTOCOL,
  fleet: config.fleetSecret ? "set" : "unset",
  vault: config.vaultKey ? "set" : "unset",
});

// An upgrade stops this container. The VMs are told the hub is going away (1001) and reconnect to
// the next process with their cursors; what was in flight is given a few seconds. Bounded, because
// Bun 1.3.14's `stop` can wait forever on a socket it closed itself (hub/tests/support/hub.ts).
process.on("SIGTERM", () => {
  clearInterval(sweep);
  listeners.closeAll(1001, "laf:hub_stopping");
  void Promise.race([server.stop(), Bun.sleep(5_000)])
    .then(() => database.close())
    .finally(() => process.exit(0));
});
