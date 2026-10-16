import { HUB_PROTOCOL } from "../../shared/hub/protocol";
import { buildOf, createLogger, reportCrashes } from "../../shared/log";
import { createHubApp } from "./app";
import { readHubConfig } from "./config";
import { createHubDatabase, migrateHub } from "./db/client";
import { createBlobMirror } from "./files/mirror";
import { sweepIdempotency } from "./idempotency";
import { startTaskSweeper } from "./task-sweeper";
import { closeUploads, serveUploads } from "./uploads";

const log = createLogger("hub");
reportCrashes(log);

const config = readHubConfig(process.env);
const database = createHubDatabase(config.databaseUrl);
await migrateHub(database);
await sweepIdempotency(database);

// Off without a files volume or a door file; with a door file named, it is read on every pass, so a
// door laf-control installs after the hub is up starts the copy by itself.
const mirror = config.filesDir
  ? createBlobMirror({
      database,
      dir: config.filesDir,
      doorFile: config.blobDoorFile,
      log,
    })
  : null;

const { app, websocket, listeners } = createHubApp({
  database,
  log,
  publicOrigin: config.publicOrigin,
  fleetSecret: config.fleetSecret,
  privateIp: config.privateIp,
  filesDir: config.filesDir,
  filesQuotaBytes: config.filesQuotaBytes,
  ...(mirror ? { mirror } : {}),
  vaultKey: config.vaultKey,
});

const server = Bun.serve({
  port: config.port,
  // Longer than the heartbeat's three missed pings, so the hub's own silence rule closes a quiet
  // socket and Bun's idle cut never does it first.
  idleTimeout: 60,
  // Every body this listener takes is a small JSON one (the largest, the registry's, is 64 KB). A
  // team file comes through the upload listener below, and here it would be held whole in memory
  // (src/uploads.ts says why), so a large one is refused before it is read.
  maxRequestBodySize: 1024 * 1024,
  fetch: (request, bunServer) => app.fetch(request, { server: bunServer }),
  websocket,
});

// Answers older than a day are of no use to a retry; an hour is often enough to keep the table
// small and rare enough to cost nothing.
// The listener `PUT /files` is served on, reached through the front door (hub/Caddyfile).
const uploads = await serveUploads({ app, port: config.uploadPort, log });
const door = (await mirror?.check()) ?? "off";
mirror?.start();

const sweep = setInterval(
  () => {
    sweepIdempotency(database).catch((error: unknown) =>
      log.warn("idempotency_sweep_failed", { error }),
    );
  },
  60 * 60 * 1000,
);

// A claim whose run stopped beating is freed within a minute of running out; once at boot too, for
// the claims that ran out while the hub was down.
const tasks = startTaskSweeper({ database, listeners, log });
void tasks.sweep();

log.info("boot", {
  ...buildOf(process.env),
  port: server.port,
  protocol: HUB_PROTOCOL,
  fleet: config.fleetSecret ? "set" : "unset",
  files: config.filesDir ? "set" : "unset",
  uploadPort: config.uploadPort,
  // The one boot line about the mirror: "off" until laf-control installs the door, which a later
  // pass finds by itself and logs (`blob_mirror_door`), as it logs any later change.
  mirror: door,
  vault: config.vaultKey ? "set" : "unset",
});

// An upgrade stops this container. The VMs are told the hub is going away (1001) and reconnect to
// the next process with their cursors; what was in flight, an upload on its own listener too, is
// given a few seconds. Bounded, because Bun 1.3.14's `stop` can wait forever on a socket it closed
// itself (hub/tests/support/hub.ts).
process.on("SIGTERM", () => {
  clearInterval(sweep);
  tasks.stop();
  listeners.closeAll(1001, "laf:hub_stopping");
  void Promise.race([
    Promise.all([server.stop(), mirror?.stop(), closeUploads(uploads)]),
    Bun.sleep(5_000),
  ])
    .then(() => database.close())
    .finally(() => process.exit(0));
});
