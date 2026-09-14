import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import { createFleetDoor, type FleetNotifier } from "../fleet/notify";
import { log } from "../log";
import type { PartnerConnections } from "../plugins/partner-connections";
import { createSupportWebhookAdapter } from "../support/feedback";
import { createAlimtalkAdapter } from "./alimtalk";
import { createSocketAdapter, type NotificationSockets } from "./in-app";
import { createWebhookAdapter } from "./notify";
import { createNotificationOutbox, type NotificationOutbox } from "./outbox";

/**
 * One outbox for "somebody has to be told", and every door it goes out through.
 *
 * There is exactly one of these, and the things that write into it — a boundary opening a question,
 * a Bot asking for a password, a routine finishing at seven in the morning — are spread across the
 * process, so the process builds it before anything that raises a notification. Three doors:
 *
 *   socket    the page itself, when somebody is connected. The common case, and the fast one.
 *   webhook   `LAF_NOTIFY_WEBHOOK_URL`, unchanged in what it sends but now carrying the row's id.
 *   alimtalk  the phone in the owner's hand, once they have connected their own 카카오톡 채널 and
 *             카카오 has approved LAF's template under it. Until then it declines honestly and the
 *             row stays undelivered for the other two.
 *
 * And two that face the other way:
 *
 *   support   `LAF_ALERT_WEBHOOK_URL`, the fleet's alert channel. The only door that takes a
 *             `support.feedback` row, and it takes nothing else — a person's message to the
 *             operator must not buzz the person, and an approval must not page the operator.
 *   fleet     the fleet tool, told about a withdrawal. The one door a `fleet.*` row goes through.
 *
 * The socket goes first because it is the only door that is free and instantaneous, and the order
 * is otherwise cosmetic — they are offered the row together (see `outbox.ts`).
 */
export function createDeploymentOutbox(input: {
  database: Database;
  sockets: NotificationSockets;
  config: Pick<DeploymentConfig, "notifications" | "publicOrigin" | "auth">;
  /** 알림톡's door reads whose channel to send as from the partner rows. */
  partners: PartnerConnections;
  alimtalk: DeploymentConfig["partners"]["alimtalk"];
  /** Absent on a deployment with no fleet webhook, which then has no fleet door either. */
  fleetNotifier: FleetNotifier | undefined;
}): NotificationOutbox {
  const { notifications } = input.config;
  return createNotificationOutbox({
    database: input.database,
    adapters: [
      createSocketAdapter(input.sockets),
      ...(notifications.webhookUrl
        ? [createWebhookAdapter(notifications.webhookUrl)]
        : []),
      createAlimtalkAdapter({
        partners: input.partners,
        settings: input.alimtalk,
        log: (message) => log.info("alimtalk", { message }),
      }),
      /*
       * Absent is announced on the `boot` line (`supportWebhook: false`): a message kept in
       * `laf_feedback` that nobody was told about is correct on a laptop and wrong on a VM, and
       * invisible from every surface — the box still says 보냈습니다, because the row is there.
       */
      ...(notifications.alertWebhookUrl
        ? [
            createSupportWebhookAdapter({
              webhookUrl: notifications.alertWebhookUrl,
              // What the fleet knows this deployment by, or the auth origin on a laptop.
              origin:
                input.config.publicOrigin || input.config.auth?.baseUrl || "",
            }),
          ]
        : []),
      ...(input.fleetNotifier ? [createFleetDoor(input.fleetNotifier)] : []),
    ],
    // The outbox and the adapter each take a line-writer so their tests can read them; here the
    // writer is the process log, so their one-line reports come out in the same shape as everything
    // else instead of as bare sentences between JSON objects.
    log: (message) => log.error("notification_outbox", { message }),
  });
}
