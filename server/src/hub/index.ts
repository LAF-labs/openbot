/**
 * The company hub, assembled once for the process (`main.ts`): the HTTP caller, the line, and the
 * outbox, wired so that each tells the others what only it learns — the line that the hub is back
 * (offer the outbox), the outbox that the pass was refused (stop the line).
 *
 * Absent `LAF_HUB_URL`, nothing here is made: `main.ts` gets undefined, the routes answer
 * `configured: false`, and the settings screen draws no company line.
 */
import type { HubEvent } from "../../../shared/hub/protocol";
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import { createHubHttp, type HubHttp } from "./http";
import { createHubLink, type HubFrame, type HubLink } from "./link";
import { createHubOutbox, type HubOutbox } from "./outbox";

export type HubRuntime = { http: HubHttp; link: HubLink; outbox: HubOutbox };

export function createHubRuntime(input: {
  config: NonNullable<DeploymentConfig["hub"]>;
  database: Database;
  deliver: (frame: HubFrame) => void;
  /** Every event the line applies, for what this server does itself (`link.ts`, `onEvent`). */
  onEvent?: (event: HubEvent) => void;
  /** Each time the line connects, after the outbox is offered what it kept. */
  onConnected?: () => void;
}): HubRuntime {
  const http = createHubHttp({
    url: input.config.url,
    vmKey: input.config.vmKey,
    ...(input.config.vmOrigin ? { vmOrigin: input.config.vmOrigin } : {}),
  });
  // The two refer to each other; the outbox is reached through this binding once both exist.
  let outbox: HubOutbox | undefined;
  const link = createHubLink({
    database: input.database,
    http,
    hub: input.config.url,
    deliver: input.deliver,
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    onReachable: () => {
      void outbox?.sweep();
      input.onConnected?.();
    },
  });
  outbox = createHubOutbox({
    database: input.database,
    http,
    paused: () => link.status().state === "refused",
    onPassRefused: () => link.passRefused("outbox"),
  });
  return { http, link, outbox };
}
