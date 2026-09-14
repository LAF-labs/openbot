import { serve } from "bun";
import { buildOf } from "../../shared/log";
import type { Computer } from "./computer";
import { readConfig } from "./config";
import { liveScreen, type StreamData } from "./live-screen";
import { log } from "./log";
import { heldForJudgement, navigationRefused } from "./navigation";
import { guardNavigations } from "./navigation-guard";
import { watchPage } from "./page-watch";
import { createProfiles } from "./profiles";
import { computerFetch } from "./routes";
import { createSessions } from "./sessions";
import { createWorkspace } from "./workspace";

/**
 * The Bot's computer: one long-lived browser, reachable over HTTP.
 *
 * Acting on a page lives in this process because only this process holds the browser. In the
 * intended deployment path, the server gateway decides whether an action may run and records the
 * audit row before calling this process. This process has no policy engine and no audit trail of its
 * own; its direct-port boundary is the computer token.
 *
 * One browser stays open so state survives between
 * turns: a session it signed into an hour ago is still signed in now. Launching per request would
 * make every task start from a cold, logged-out browser, which is the behaviour we are specifically
 * trying not to have.
 *
 * It authenticates its caller: every request must present the secret, and the process refuses to
 * start without one. That is a lock on the door rather than a reason to put the door somewhere
 * public. It still belongs on the deployment network, behind the server that decides who is asking.
 *
 * THIS FILE IS WIRING. What a request may do is decided in `routes.ts`; what each route does is in
 * the module that owns it — `navigation.ts`, `actions.ts`, `snapshot.ts`, `control-routes.ts`,
 * `live-screen.ts`, `file-routes.ts` and the rest. It used to be all of those in one closure, 2,375
 * lines, and the audit's findings about secrets, approvals and redirects came out of a file no
 * reviewer could hold on one screen (audit A3 §7).
 */

const config = readConfig();
if (!config) {
  log.error("boot_refused", {
    reason: "computer_token_unset",
    hint: "This process drives a browser holding real logins and will not start without the secret its caller must present.",
  });
  process.exit(1);
}

/**
 * The Bot's durable files.
 *
 * Rooted at WORKSPACE_DIR, which the image creates and docker-compose mounts as a volume, so what a
 * Bot saves outlives the container. Built once at boot: the root is fixed, and resolving it per request
 * would only add a syscall to every call. Everything about why confinement is harder than it looks
 * lives in workspace.ts.
 */
const workspace = createWorkspace(config.workspaceDir);

// Who had the wheel is written beside the profile, so the directory is the profile's to name.
const sessions = createSessions((botId) => profiles.directoryFor(botId));

/**
 * The Bot's browser and the profile that outlives it. See profiles.ts.
 *
 * `chromium.launch()` gives a fresh anonymous profile every time. Persistent profiles live on a
 * mounted volume so sign-in state survives the container.
 */
const profiles = createProfiles(config.profilesDir, {
  onPage: (botId, page) =>
    watchPage(sessions.sessionFor(botId), botId, page, workspace),
  // Before the first page is handed out, so no request this browser ever makes goes unjudged.
  onContext: async (botId, context) => {
    await guardNavigations(context, {
      allowPrivateHosts: config.allowPrivateHosts,
      onRefused: (hop, reason) =>
        navigationRefused(sessions.sessionFor(botId), botId, hop, reason),
      holds: (hop) =>
        heldForJudgement(sessions.existing(botId)?.navigating, hop),
    });
  },
});

const computer: Computer = { config, profiles, workspace, sessions };

const listener = serve<StreamData>({
  port: config.port,
  idleTimeout: 120,
  websocket: liveScreen(computer),
  fetch: computerFetch(computer),
});

// `listener.port` rather than `PORT`: on port 0 it is the port actually given.
log.info("boot", {
  ...buildOf(),
  port: listener.port,
  profilesDir: config.profilesDir,
  navigationTimeoutMs: config.navigationTimeoutMs,
  actionTimeoutMs: config.actionTimeoutMs,
  // A boundary a deployment can move, so the boot line is where an operator checks it.
  allowPrivateHosts: config.allowPrivateHosts,
  // Which user the browser runs as. `0` here is the finding this image was rebuilt to close.
  uid: typeof process.getuid === "function" ? process.getuid() : null,
});

/**
 * Hand the profile back before dying.
 *
 * `docker stop` and a Kubernetes eviction both send SIGTERM and then wait, so this is the window in
 * which Chromium can flush its profile to the volume. This is the graceful-shutdown path for normal
 * container restarts.
 *
 * `stop_grace_period` in docker-compose.yml is what gives this time to run.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void (async () => {
      log.info("shutdown", {
        reason: signal,
        note: "closing the browser so its profile is flushed",
      });
      await profiles.closeAll();
      process.exit(0);
    })();
  });
}
