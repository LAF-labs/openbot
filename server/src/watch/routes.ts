/**
 * The watch surface: which sources this deployment polls, and a hand-crank for
 * proving one works.
 *
 * Writes are an administrator's for the same reason plugins are — a source is a
 * URL this server will call forever, and when `wakeAgentId` is set it decides
 * which Bot spends money on the answer. Reading is open to any signed-in
 * person: what the deployment watches is not a secret from the people it
 * watches it for.
 */

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { DigestService } from "./digest-service";
import type { NewWatchSource, WatchService } from "./poller";

const MAX_NAME = 200;
const MIN_INTERVAL_SECONDS = 10;
const MAX_INTERVAL_SECONDS = 86_400;

function parseNewSource(body: unknown): NewWatchSource | string {
  const candidate = body as Record<string, unknown>;
  const name = typeof candidate?.name === "string" ? candidate.name.trim() : "";
  if (!name || name.length > MAX_NAME) {
    return "name is required (at most 200 characters)";
  }
  const kind = candidate.kind;
  if (kind !== "http" && kind !== "mcp") {
    return "kind must be 'http' or 'mcp'";
  }
  const url = typeof candidate.url === "string" ? candidate.url : "";
  try {
    new URL(url);
  } catch {
    return "url must be a valid URL";
  }
  let intervalSeconds: number | undefined;
  if (candidate.intervalSeconds !== undefined) {
    const parsed = Number(candidate.intervalSeconds);
    if (
      !Number.isInteger(parsed) ||
      parsed < MIN_INTERVAL_SECONDS ||
      parsed > MAX_INTERVAL_SECONDS
    ) {
      return `intervalSeconds must be an integer between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}`;
    }
    intervalSeconds = parsed;
  }
  const wakeAgentId =
    typeof candidate.wakeAgentId === "string" && candidate.wakeAgentId.trim()
      ? candidate.wakeAgentId.trim()
      : null;
  return { name, kind, url, intervalSeconds, wakeAgentId };
}

export function createWatchRoutes(
  service: WatchService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  digest?: DigestService,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use(requireUser);

  routes.get("/sources", async (context) =>
    context.json({ sources: await service.listSources() }),
  );

  routes.post("/sources", async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    const parsed = parseNewSource(await context.req.json().catch(() => ({})));
    if (typeof parsed === "string") {
      return context.json({ error: parsed }, 400);
    }
    return context.json({ source: await service.createSource(parsed) }, 201);
  });

  routes.delete("/sources/:id", async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    const removed = await service.deleteSource(context.req.param("id"));
    return removed
      ? context.body(null, 204)
      : context.json({ error: "No such source" }, 404);
  });

  routes.post("/sources/:id/poll", async (context) => {
    const denied = requireAdmin(context);
    if (denied) {
      return denied;
    }
    const outcome = await service.pollNow(context.req.param("id"));
    if (!outcome) {
      return context.json({ error: "No such source" }, 404);
    }
    return context.json(outcome);
  });

  if (digest) {
    routes.post("/digest/preview", async (context) => {
      const denied = requireAdmin(context);
      if (denied) {
        return denied;
      }
      return context.json(await digest.preview());
    });
    routes.post("/digest/send", async (context) => {
      const denied = requireAdmin(context);
      if (denied) {
        return denied;
      }
      return context.json(await digest.sendNow());
    });
  }

  return routes;
}
