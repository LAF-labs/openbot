/**
 * What a boot says about itself: to the operator reading the log, and to the audit trail.
 *
 * Each is called by `main.ts` at the point in the boot where the fact became true, so the lines come
 * out in the order an operator has always read them — `fleet_webhook_unconfigured` before the runner
 * reconciles, `partner_connectors` and `public_data` once the vendors are assembled, `boot` once the
 * port is open.
 */
import { buildOf } from "../../../shared/log";
import { COMPUTER_TOOLS } from "../../../shared/tools/computer";
import { SELF_TOOLS } from "../../../shared/tools/self";
import { SKILL_TOOLS } from "../../../shared/tools/skills";
import {
  type AuditStore,
  ONE_SHARED_COMPUTER,
  auditRowLost,
  recordAuditEvent,
} from "../audit";
import { DEV_ACTOR } from "../auth/dev-actor";
import type { ActionPolicy } from "../computer/policy";
import type { DeploymentConfig } from "../config";
import { log } from "../log";
import type { TenantPackage } from "../tenant-package";

/**
 * The fleet tool created this machine and is the only thing that can destroy it, so its absence is
 * announced.
 *
 * A deployment with no fleet webhook is correct on a laptop and wrong on a VM, and the wrongness is
 * invisible from every surface: a withdrawal completes, the person is told their account is gone,
 * and the machine keeps running and keeps being paid for because nothing outside this process ever
 * heard. So it says so once, at boot, where an operator reading the logs of a deployment that is
 * behaving perfectly can still see it.
 */
export function sayFleetIsUnconfigured(): void {
  log.warn("fleet_webhook_unconfigured", {
    note: "LAF_FLEET_WEBHOOK_URL is unset. Sign-ups and withdrawals on this deployment reach nothing: a person who leaves is gone from here and the machine outlives them.",
  });
}

/**
 * Which vendors this VM holds LAF's keys for.
 *
 * A VM with no partner key gets a runtime with nothing in it, no cards and no tools, which is a
 * correct deployment (`config.partners` refused to start on half of one). A VM with the data.go.kr
 * key offers 나라장터 and 기업마당 to every Bot on it from boot, and a VM without it has no entry.
 * Said at boot either way, so an operator reading the log knows which it is.
 */
export function sayConnectors(input: {
  alimtalk: boolean;
  dataGoKr: boolean;
}): void {
  log.info("partner_connectors", { alimtalk: input.alimtalk });
  log.info("public_data", { dataGoKr: input.dataGoKr });
}

/**
 * Two rows for a later reader of the trail: which boundary this process started with, and that every
 * Bot shares the account's one computer.
 *
 * Not awaited and never fatal: the rows are notes for a reader, not something the server depends on.
 */
export function recordStartingArrangement(input: {
  auditStore: AuditStore;
  /** The boundary in force, as the policy store holds it after reading back a saved one. */
  policy: ActionPolicy;
  /** Where that boundary came from, as `policyStore.load()` answered. */
  source: "the database" | "configuration";
  /** Whether the deployment configured a policy at all, rather than running the built-in default. */
  configured: boolean;
}): void {
  /*
   * The trail records the boundary a process starts with, so later audit reads can distinguish the
   * configured default from any administrator-updated policy that was persisted before restart.
   */
  void recordAuditEvent(input.auditStore, {
    eventType: "computer.policy_loaded",
    targetType: "policy",
    payload: {
      ...input.policy,
      source:
        input.source === "the database"
          ? "an administrator, saved in this deployment"
          : input.configured
            ? "configuration"
            : "the built-in default",
      note:
        input.source === "the database"
          ? "Set while running and kept. A restart returns to this."
          : "The deployment default. Anything an administrator sets from here is kept.",
    },
  }).catch(auditRowLost("computer.policy_loaded"));

  /*
   * The sharing is a product decision (computer/assignment.ts), not an accident of configuration,
   * but it must still be visible in the trail rather than inferred: sessions, files and logins are
   * common to the roster, and a reader of the audit log has to be told that.
   */
  void recordAuditEvent(input.auditStore, {
    eventType: "computer.isolation_loaded",
    targetType: "computer",
    payload: {
      isolation: "one shared computer",
      /*
       * A code. This was a 200-character English paragraph, on the one row whose entire content is a
       * sentence — and the audit page drew no `note` at all, so the arrangement this row exists to
       * state was legible only to somebody reading the database. The surface says it in Korean now,
       * and draws it.
       */
      note: ONE_SHARED_COMPUTER,
    },
  }).catch(auditRowLost("computer.isolation_loaded"));
}

/**
 * The lines an operator reads first after a restart, once the port is open.
 *
 * `dev_no_auth` first, loud, every boot: a server that is not checking who is asking should never be
 * a quiet default. Then `boot`: which build, which model, how many core tools a Bot is offered, and
 * where the browser is. `tools` counts the catalogue in `shared/tools` — the computer, self and skill
 * tools every Bot can be handed — not the connected-service tools, which are per person and per run.
 * `port` is the one the server was given rather than the one configured, because a test starts this
 * process on port 0 and reads the port it got from here.
 */
export function sayBooted(input: {
  config: Pick<
    DeploymentConfig,
    | "devNoAuth"
    | "computer"
    | "agentStallTimeoutMs"
    | "auditRetentionDays"
    | "notifications"
  >;
  model: TenantPackage["model"];
  port: number | undefined;
  fleetWebhook: boolean;
  /**
   * The harness this build puts in front of the model (`shared/prompt/harness.ts`) and how many
   * conversations were loaded with an epoch already frozen. A deploy whose harness moved starts a
   * new epoch in every one of them, and the line says so before the first cache miss does.
   */
  harness?: { version: string; conversations: number };
}): void {
  const { config } = input;
  if (config.devNoAuth) {
    log.warn("dev_no_auth", {
      actor: DEV_ACTOR.email,
      role: "administrator",
      note: "LAF_DEV_NO_AUTH is on: every request is treated as this person. Local development only.",
    });
  }
  log.info("boot", {
    ...buildOf(),
    model: input.model.defaultModel,
    reviewModel: input.model.reviewModel,
    supportsEffort: input.model.supportsEffort,
    tools: COMPUTER_TOOLS.length + SELF_TOOLS.length + SKILL_TOOLS.length,
    port: input.port,
    computer: config.computer ? "one shared computer" : "none",
    fleetWebhook: input.fleetWebhook,
    supportWebhook: Boolean(config.notifications.alertWebhookUrl),
    stallTimeoutMs: config.agentStallTimeoutMs,
    retentionDays: config.auditRetentionDays,
    ...(input.harness
      ? {
          harness: input.harness.version,
          conversations: input.harness.conversations,
        }
      : {}),
  });
}
