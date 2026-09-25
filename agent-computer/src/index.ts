import { serve } from "bun";
import type { Page } from "playwright";
import { buildOf } from "../../shared/log";
import type { Computer } from "./computer";
import { readConfig } from "./config";
import { deploymentEgress, ignoredEgressVariables } from "./egress";
import { liveScreen, type StreamData } from "./live-screen";
import { log } from "./log";
import { heldForJudgement, navigationRefused } from "./navigation";
import {
  guardNavigations,
  mainFrameIdOf,
  type NavigationHop,
  originOf,
} from "./navigation-guard";
import { watchPage } from "./page-watch";
import { createProfiles } from "./profiles";
import { computerFetch } from "./routes";
import { createSessions, note } from "./sessions";
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

// Who had the wheel is a Bot's own, and the cookie jar is the deployment's, so the two live in
// different directories. `legacyStateDirectoryFor` is the pre-2026-09-16 place, read as a fallback.
const sessions = createSessions({
  stateDirectoryFor: (botId) => profiles.stateDirectoryFor(botId),
  legacyStateDirectoryFor: (botId) => profiles.legacyStateDirectoryFor(botId),
});

/**
 * WHOSE HOP THE GUARD JUST STOPPED.
 *
 * The navigation guard sits on the BROWSER target so it sees every tab and every redirect
 * (navigation-guard.ts) — and the browser now belongs to every Bot, so a stopped hop arrives with a
 * frame id and nothing else. Three questions, in order, and only the first two are facts:
 *
 *  1. Is a Bot's `/navigate` driving that exact frame? Then it is that Bot's, and the call waiting
 *     for an answer gets the refusal directly instead of as a note next time.
 *  2. Is that frame a tab's main frame we have seen handed to a Bot? `mainFrameIdOf` is the tab's
 *     target id, so a click that navigated a tab lands on its owner.
 *  3. Is exactly one Bot holding a tab at all? Then every frame in this browser is that Bot's. Not a
 *     guess — a count. It is what keeps a popup's first request and a refused iframe attributable on
 *     the machine this product actually runs on, where one person drives one Bot at a time.
 *
 * NOTHING ELSE IS GUESSED AT. Two Bots acting at once, and a refused sub-frame belonging to neither
 * of their in-flight navigations, is told to nobody — the hop is still stopped and still logged, and
 * a note in the wrong Bot's hands would be a lie about a page it never opened. That is the one thing
 * this change costs the guard, and it is here rather than in a document nobody reads.
 */
const framesOwned = new Map<string, string>();

const botForHop = (hop: NavigationHop): string | null => {
  const navigating = sessions.botNavigating(hop.frameId);
  if (navigating) return navigating;
  const owner = framesOwned.get(hop.frameId);
  if (owner) return owner;
  const liveBots = profiles.liveBots();
  return liveBots.length === 1 ? (liveBots[0] as string) : null;
};

/** A tab's main frame, remembered against the Bot it was handed to, and forgotten when it closes. */
const rememberFrame = (botId: string, page: Page): void => {
  void mainFrameIdOf(page)
    .then((frameId) => {
      if (!frameId) return;
      framesOwned.set(frameId, botId);
      page.once("close", () => {
        if (framesOwned.get(frameId) === botId) framesOwned.delete(frameId);
      });
    })
    .catch(() => undefined);
};

/**
 * The deployment's browser and the profile that outlives it. See profiles.ts.
 *
 * `chromium.launch()` gives a fresh anonymous profile every time. The persistent profile lives on a
 * mounted volume so sign-in state survives the container, and every Bot opens that one — a site one
 * Bot signed into is signed in for the others, which is the promise the onboarding screen makes.
 */
const profiles = createProfiles(config.profilesDir, {
  onPage: (botId, page) => {
    rememberFrame(botId, page);
    watchPage(sessions.sessionFor(botId), botId, page, workspace);
  },
  // Before the first page is handed out, so no request this browser ever makes goes unjudged. Once
  // for the browser, not once per Bot: there is one browser.
  onContext: async (context) => {
    await guardNavigations(context, {
      allowPrivateHosts: config.allowPrivateHosts,
      behindProxy: deploymentEgress(process.env) !== null,
      onRefused: (hop, reason) => {
        const botId = botForHop(hop);
        if (!botId) {
          log.warn("navigation_refused_unattributed", {
            origin: originOf(hop.url),
            redirected: hop.redirectedFrom !== null,
            reason,
          });
          return;
        }
        navigationRefused(sessions.sessionFor(botId), botId, hop, reason);
      },
      holds: (hop) => {
        const botId = botForHop(hop);
        return botId
          ? heldForJudgement(sessions.existing(botId)?.navigating, hop)
          : false;
      },
    });
  },
  /*
   * The person's logins did not start over because the container did. An upgrade from a profile per
   * Bot takes over the one that was used most recently and leaves the rest untouched; the Bot whose
   * call caused that launch is told which, and how many are still sitting on the volume, because
   * "why is 배민 asking me to log in again" has an answer and it is this.
   */
  onProfileAdopted: (botId, adoption) =>
    note(sessions.sessionFor(botId), {
      code: "laf:profile_adopted",
      adopted: adoption.adoptedFrom,
      kept: adoption.kept,
    }),
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

/*
 * A deployment that still names a per-Bot proxy is told, once, at boot.
 *
 * One profile is one Chromium is one proxy (egress.ts). A machine whose security team handed out an
 * address per Bot would otherwise go on browsing somebody's bank from whatever `EGRESS_PROXY_DEFAULT`
 * says — or from no proxy at all — and nothing would ever mention it. Names only: the values are URLs
 * that routinely carry a password.
 */
const ignoredEgress = ignoredEgressVariables(process.env);
if (ignoredEgress.length) {
  log.warn("egress_per_bot_ignored", {
    variables: ignoredEgress,
    using: process.env.EGRESS_PROXY_DEFAULT ? "EGRESS_PROXY_DEFAULT" : "direct",
    note: "every Bot shares one browser, so one proxy is chosen at launch",
  });
}

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
