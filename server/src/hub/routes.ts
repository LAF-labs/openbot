import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { HUB_FACTS, type HubMe } from "../../../shared/hub/protocol";
import type { AppVariables } from "../auth/guards";
import type { HubHttp } from "./http";
import type { HubLink } from "./link";

/**
 * The app's two doors to the company hub, behind the person's session like every other route:
 *
 *   GET /api/hub/status   whether this VM belongs to a company, and whether the line is up
 *   GET /api/hub/me       who this person is in their company, asked of the hub now
 *
 * The server asks the hub with the pass and hands back facts; the browser never learns the hub's
 * address, the pass, or the private address `/me` offers a VM. A hub failure is a 502 with its
 * fact, never the hub's own status: a 401 passed through would read to the app as this person's
 * session having ended.
 */
export function createHubRoutes(
  hub: { http: HubHttp; link: HubLink } | undefined,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/status", requireUser, (context) => {
    context.header("cache-control", "no-store");
    if (!hub) return context.json({ configured: false });
    return context.json({ configured: true, ...hub.link.status() });
  });

  routes.get("/me", requireUser, async (context) => {
    context.header("cache-control", "no-store");
    if (!hub) {
      return context.json({ ok: false, code: "laf:hub_not_configured" }, 404);
    }
    if (hub.link.status().state === "refused") {
      return context.json({ ok: false, code: HUB_FACTS.passRefused }, 502);
    }
    const answer = await hub.http.request<HubMe>({ path: "/me" });
    if (!answer.ok) {
      if (answer.code === HUB_FACTS.passRefused) {
        hub.link.passRefused("api_me");
      }
      return context.json({ ok: false, code: answer.code }, 502);
    }
    const { member, workspace } = answer.body;
    return context.json({
      ok: true,
      member: { id: member.id, role: member.role, name: member.name },
      workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
    });
  });

  return routes;
}
