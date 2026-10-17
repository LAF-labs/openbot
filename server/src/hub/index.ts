/**
 * The company hub, assembled once for the process (`main.ts`): the HTTP caller, the line, and the
 * outbox, wired so that each tells the others what only it learns — the line that the hub is back
 * (offer the outbox), the outbox that the pass was refused (stop the line).
 *
 * Absent `LAF_HUB_URL`, nothing here is made: `main.ts` gets undefined, the routes answer
 * `configured: false`, and the settings screen draws no company line.
 */
import type { DeploymentConfig } from "../config";
import type { Database } from "../db/client";
import { createHubHttp, type HubHttp } from "./http";
import { createHubLink, type HubFrame, type HubLink } from "./link";
import { createHubOutbox, type HubOutbox } from "./outbox";
import {
  createHubUploads,
  type HubUploadDeps,
  type HubUploads,
} from "./upload";

export type HubRuntime = {
  http: HubHttp;
  link: HubLink;
  outbox: HubOutbox;
  /** Absent where there is no computer to read the Bot's folder from. */
  uploads?: HubUploads;
};

export function createHubRuntime(input: {
  config: NonNullable<DeploymentConfig["hub"]>;
  database: Database;
  deliver: (frame: HubFrame) => void;
  /** The Bot's folder and the converter, for uploads (`upload.ts`). */
  files?: Omit<HubUploadDeps, "http" | "outbox">;
}): HubRuntime {
  const http = createHubHttp({
    url: input.config.url,
    vmKey: input.config.vmKey,
    ...(input.config.vmOrigin ? { vmOrigin: input.config.vmOrigin } : {}),
  });
  // The two refer to each other; the outbox is reached through this binding once both exist.
  let outbox: HubOutbox | undefined;
  // And the uploads and the outbox: a row is written by the one and sent by the other.
  let uploads: HubUploads | undefined;
  const link = createHubLink({
    database: input.database,
    http,
    hub: input.config.url,
    deliver: input.deliver,
    onReachable: () => void outbox?.sweep(),
  });
  outbox = createHubOutbox({
    database: input.database,
    http,
    paused: () => link.status().state === "refused",
    onPassRefused: () => link.passRefused("outbox"),
    ...(input.files
      ? {
          sendUpload: (reference, request) =>
            (uploads as HubUploads).sendReference(reference, request),
        }
      : {}),
  });
  uploads = input.files
    ? createHubUploads({ ...input.files, http, outbox })
    : undefined;
  return { http, link, outbox, ...(uploads ? { uploads } : {}) };
}
