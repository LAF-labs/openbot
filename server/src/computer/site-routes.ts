/**
 * The 사이트 연결 surface: what this person has connected, and "look now and tell me".
 *
 * TWO ROUTES, AND NEITHER OF THEM NAVIGATES. Opening the login page is
 * `POST /api/computers/:botId/navigate`, which already exists and is the ONE governed, audited door
 * to a Bot's browser. A second navigate route here — quieter, aimed at a fixed list of "safe"
 * addresses — would be a way past the boundary that a person's own screen offered them, and the
 * fact that this deployment's policy would probably have allowed it is not the point.
 *
 * So the flow is: the surface navigates through that route, hands the wheel over through the
 * control routes, and then asks THIS surface one question — "is the page in front of the browser
 * signed in?" — which is a read plus a predicate out of the shared catalogue.
 */
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { siteById } from "../../../shared/sites/catalogue";
import type { AppVariables } from "../auth/guards";
import { BOT_ID_INVALID, isBotId } from "./bot-id";
import { ComputerUnavailableError, factOfError } from "./client";
import type { ComputerGateway } from "./gateway";
import type { SiteConnectionStore } from "./site-connections";

export function createSiteRoutes(
  /** Only the read. This surface never acts on a page. */
  gateway: Pick<ComputerGateway, "read">,
  store: SiteConnectionStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/connections", requireUser, async (context) =>
    context.json({ connections: await store.list(context.var.actor.id) }),
  );

  /**
   * Look at what the Bot's browser is showing and write down what it says about this site.
   *
   * Called when somebody hands the wheel back, which is the moment their login either worked or
   * did not. The answer is the same fact the gateway writes on every later navigation, decided by
   * the same predicate — one definition of "signed in", so a card cannot mean two things.
   */
  routes.post("/:siteId/check", requireUser, async (context) => {
    const site = siteById(context.req.param("siteId"));
    if (!site) return context.json(SITE_UNKNOWN_BODY, 404);

    const body = (await context.req.json().catch(() => null)) as {
      botId?: unknown;
    } | null;
    if (typeof body?.botId !== "string" || !body.botId.trim()) {
      return context.json(
        { error: "laf:site_bot_required", code: "laf:site_bot_required" },
        400,
      );
    }
    const botId = body.botId.trim();
    /*
     * The other door into the computer's `x-openbot-bot-id`, and the one that carries the Bot in a
     * body rather than in the address — which is why it needs the check of its own that the routes
     * next door get from a middleware. The header is a directory name on the far side; see
     * bot-id.ts for what `../..` reached before anything looked.
     */
    if (!isBotId(botId)) {
      return context.json({ error: BOT_ID_INVALID, code: BOT_ID_INVALID }, 400);
    }

    let page: { url: string; text: string };
    try {
      /*
       * WHOLE, NOT THE ARTICLE. Since `bd2ce0a9` a page that calls itself an article is read as
       * Reader View's cut of it, and the cut leaves out the header where "로그인/회원가입" sits.
       * MEASURED 2026-09-25: 배민 사장님's home page, signed out, read as 769 characters of forum
       * posts with no 로그인 in them, and the card said "연결됨 · 복실이가 확인" for a login nobody made.
       */
      page = await gateway.read(botId, { whole: true });
    } catch (error) {
      // A browser that will not answer is not a failed login. The card must not start saying "log
      // in again" because the container was restarting. Answered with the computer's own fact —
      // unreachable, timed out — rather than a sentence about it.
      const status = error instanceof ComputerUnavailableError ? 503 : 500;
      const code = factOfError(error);
      return context.json({ error: code, code }, status);
    }

    const signedIn = site.signedIn(page.url, page.text);
    const connection = await store.record({
      userId: context.var.actor.id,
      siteId: site.id,
      botId,
      signedIn,
    });
    /*
     * The address is NOT returned. It is the person's own browser and they are looking at it, so
     * this would tell them nothing they cannot see — and a login URL carrying a one-time token in
     * its query string is exactly the sort of thing that ends up in a log because somebody once
     * echoed it back "for debugging".
     */
    return context.json({ signedIn, connection });
  });

  /**
   * Turn one site off: the row goes, and nothing is claimed about the browser.
   *
   * The switch on the 연결 screen needs somewhere to go when it is turned off, and a switch that
   * could only ever be turned on is not a switch. This is the whole of what the product can
   * truthfully do — see {@link SiteConnectionStore.forget} — and the screen's confirmation says the
   * other half out loud rather than letting the gesture imply it.
   */
  routes.delete("/:siteId/connection", requireUser, async (context) => {
    const site = siteById(context.req.param("siteId"));
    if (!site) return context.json(SITE_UNKNOWN_BODY, 404);
    const forgotten = await store.forget({
      userId: context.var.actor.id,
      siteId: site.id,
    });
    return context.json({ forgotten });
  });

  return routes;
}

/** A site the catalogue does not have. A fact, like every refusal these routes answer. */
const SITE_UNKNOWN = "laf:site_unknown";
const SITE_UNKNOWN_BODY = { error: SITE_UNKNOWN, code: SITE_UNKNOWN };
