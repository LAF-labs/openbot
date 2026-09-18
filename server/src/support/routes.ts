/**
 * `POST /api/support/feedback`: the 문의·의견 box, as the browser reaches it. And
 * `GET /api/support/diagnostics`: what "진단 정보 같이 보내기" would attach, shown before it is.
 * And `POST /api/support/help-opened`: the guide was opened. And `/api/support/ratings`: 좋아요·
 * 아쉬워요 under an answer, which has its own file (`rating-routes.ts`).
 *
 * FACTS, NEVER SENTENCES. A refusal carries a code and the surface owns the words, the same
 * arrangement `account/routes.ts` and the consent call use. The answer to a message that landed is
 * four facts: the row's id, when it was received, which doors told the operator, and whether the
 * diagnostic details went with it — which is what lets the box say 보냈습니다 as something the
 * server said rather than something the box hoped.
 *
 * WHAT THE SERVER KEEPS FROM THE BODY, AND WHAT IT DOES NOT. The text, and — only inside `screen`,
 * which is present only when the person ticked the box — a path and a failure code. And, only
 * inside `diagnostics`, an ID: the bundle it names was assembled here and shown to this person by
 * `GET /diagnostics`, and that is the bundle stored. Nothing else is read. A client that sent a
 * screenshot, a transcript, a Bot's last answer or a bundle of its own under any key would find
 * none of it stored, because the shape of the row is the rule and the route never copies the body
 * into it. The tests send exactly that and assert it went nowhere.
 */

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { Build } from "../../../shared/log";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { HealthReport } from "../health";
import { isCatalogueKey } from "../insights/catalogue-key";
import type { NotificationOutbox } from "../notifications/outbox";
import type { AnswerRatingStore } from "./answer-ratings";
import {
  createDiagnosticsShelf,
  DIAGNOSTICS_EXPIRED,
  DIAGNOSTICS_UNAVAILABLE,
  type DiagnosticBundle,
  type DiagnosticsShelf,
  type DiagnosticsSource,
  summariseDiagnostics,
} from "./diagnostics";
import { FEEDBACK_MAX_LENGTH, type FeedbackStore } from "./feedback";
import { createAnswerRatingRoutes } from "./rating-routes";

export type SupportService = {
  feedback: FeedbackStore;
  auditStore: AuditStore;
  /** Absent on a deployment without one; the row is kept and `told` is empty. */
  outbox?: NotificationOutbox;
  /** Where a person's diagnostic details are read from. Absent, the box cannot attach any. */
  diagnostics?: DiagnosticsSource;
  /**
   * 좋아요·아쉬워요 under an answer (`answer-ratings.ts`). Absent leaves `/ratings` unmounted, and
   * the transcript then draws no rating controls rather than controls that save nowhere.
   */
  ratings?: AnswerRatingStore;
};

/**
 * The two deployment-wide facts a bundle carries, handed over by `createApp` from the routes that
 * already answer them — the same build `GET /api/version` reads and the same cached report `GET
 * /health` answers — so the bundle cannot disagree with either.
 */
export type SupportDeployment = {
  version: Build;
  health: () => Promise<HealthReport>;
  /** Injected by tests; one per mounted router otherwise. */
  shelf?: DiagnosticsShelf;
};

/** A path, not a URL: the query and the fragment go, and it has to start at the root. */
const ROUTE_MAX_LENGTH = 200;
/** The shape every failure code in this product has: `laf:turn_rate_limited`, `laf.empty_answer`. */
const FAILURE_CODE = /^laf[:.][a-z0-9_.]{1,60}$/;

function screenRoute(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.split(/[?#]/, 1)[0] ?? "";
  if (!path.startsWith("/") || path.length > ROUTE_MAX_LENGTH) return undefined;
  return path;
}

function screenFailure(value: unknown): string | undefined {
  return typeof value === "string" && FAILURE_CODE.test(value)
    ? value
    : undefined;
}

export function createSupportRoutes(
  service: SupportService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  deployment?: SupportDeployment,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const shelf = deployment?.shelf ?? createDiagnosticsShelf();

  /**
   * The bundle this person would attach, assembled now and held under an id.
   *
   * A read, and a read of their own facts only (`diagnostics.ts`). Asked when the box is ticked,
   * never when the dialog opens: nothing is gathered for somebody who did not ask.
   */
  routes.get("/diagnostics", requireUser, async (context) => {
    if (!service.diagnostics || !deployment) {
      return context.json(
        { error: DIAGNOSTICS_UNAVAILABLE, code: DIAGNOSTICS_UNAVAILABLE },
        503,
      );
    }
    const actor = context.var.actor;
    const bundle = await service.diagnostics.assemble(actor.id, {
      version: deployment.version,
      health: await deployment.health(),
    });
    return context.json({
      id: shelf.hold(actor.id, bundle),
      diagnostics: bundle,
    });
  });

  routes.post("/feedback", requireUser, async (context) => {
    const actor = context.var.actor;
    const body = (await context.req.json().catch(() => null)) as {
      text?: unknown;
      screen?: unknown;
      diagnostics?: unknown;
    } | null;

    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) {
      return context.json(
        { error: "laf:feedback_empty", code: "laf:feedback_empty" },
        400,
      );
    }
    if (text.length > FEEDBACK_MAX_LENGTH) {
      return context.json(
        {
          error: "laf:feedback_too_long",
          code: "laf:feedback_too_long",
          limit: FEEDBACK_MAX_LENGTH,
        },
        400,
      );
    }

    /*
     * ASKED FOR AND NOT FOUND IS A REFUSAL, NOT A MESSAGE WITHOUT IT. The person ticked the box and
     * read what would go; sending the words alone would say 보냈습니다 over something they believe
     * was attached. Refused before anything is written, so pressing again after the box shows the
     * new bundle sends one message, not two. And taken off the shelf as it is found, so a second
     * press that raced the first cannot attach the same bundle to a second row.
     */
    let bundle: DiagnosticBundle | null = null;
    if (body?.diagnostics !== undefined && body.diagnostics !== null) {
      const named = (body.diagnostics as { id?: unknown }).id;
      const id = typeof named === "string" ? named : "";
      bundle = id ? shelf.find(actor.id, id) : null;
      if (!bundle) {
        return context.json(
          { error: DIAGNOSTICS_EXPIRED, code: DIAGNOSTICS_EXPIRED },
          409,
        );
      }
      shelf.release(id);
    }

    const screen =
      body?.screen && typeof body.screen === "object"
        ? (body.screen as { route?: unknown; failureCode?: unknown })
        : null;
    const route = screen ? screenRoute(screen.route) : undefined;
    const failureCode = screen ? screenFailure(screen.failureCode) : undefined;

    const receipt = await service.feedback.record({
      userId: actor.id,
      text,
      ...(route ? { route } : {}),
      ...(failureCode ? { failureCode } : {}),
      ...(bundle ? { diagnostics: bundle } : {}),
    });

    /*
     * The telling, after the row. `enqueue` never throws and answers null when nothing could be
     * written; either way the message is already kept, so the worst this can do is leave `told`
     * empty — which is the truth.
     *
     * THE BUNDLE ITSELF STAYS HERE. The webhook is somebody else's chat server; what crosses to it
     * is how much was attached — counts — and the operator reads the rest on this VM, in the row.
     */
    const notice = service.outbox
      ? await service.outbox.enqueue({
          kind: "support.feedback",
          // Nobody's Bot. The column is not null; nothing reads it for a support row.
          botId: "",
          userId: actor.id,
          support: {
            feedbackId: receipt.id,
            text,
            ...(route ? { route } : {}),
            ...(failureCode ? { failureCode } : {}),
            ...(bundle ? { diagnostics: summariseDiagnostics(bundle) } : {}),
          },
        })
      : null;
    const told = notice?.deliveredVia ?? [];

    // The trail says that a message was sent and how far it got. Not what it said: the words are
    // in their own table, and the trail outlives the account by a year.
    await recordAuditEvent(service.auditStore, {
      eventType: "support.feedback_sent",
      targetType: "feedback",
      targetId: receipt.id,
      actorUserId: actor.id,
      payload: {
        length: text.length,
        withScreen: screen !== null,
        withDiagnostics: bundle !== null,
        told,
      },
    }).catch(() => undefined);

    return context.json(
      {
        id: receipt.id,
        receivedAt: receipt.createdAt.toISOString(),
        told,
        withDiagnostics: bundle !== null,
      },
      201,
    );
  });

  /**
   * The guide was opened — once per visit, which the page decides (`lib/support/help-opened.ts`).
   *
   * The launch plan asks whether anybody reads the help at all, and `/help` left nothing anywhere
   * to count. One row per visit and the section the address named, as a key: the guide's headings
   * are Korean prose and the page maps them to keys, so a `section` that is not key-shaped is not a
   * section this page has, and is recorded as none rather than kept. Nothing else in the body is
   * read. 204 either way — the page does not wait on this, and has nothing to say about it.
   */
  routes.post("/help-opened", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      section?: unknown;
    } | null;
    const named = body?.section;
    const section = isCatalogueKey(named) ? named : null;
    await recordAuditEvent(service.auditStore, {
      eventType: "support.help_opened",
      targetType: "help",
      ...(section ? { targetId: section } : {}),
      actorUserId: context.var.actor.id,
      payload: { section },
    });
    return context.body(null, 204);
  });

  if (service.ratings) {
    routes.route(
      "/ratings",
      createAnswerRatingRoutes(
        {
          ratings: service.ratings,
          ...(service.outbox ? { outbox: service.outbox } : {}),
        },
        requireUser,
      ),
    );
  }

  return routes;
}
