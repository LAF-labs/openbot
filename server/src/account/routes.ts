/**
 * Taking your data with you, and leaving.
 *
 * THREE ROUTES AND ONE MOUNT. They sit under `/api` rather than under a prefix of their own because
 * two of them are about the person asking (`/me/…`) and one is about somebody else (`/admin/…`),
 * and inventing `/api/account` for both would put an administrator's action inside a namespace that
 * reads as "mine".
 *
 * FACTS, NEVER SENTENCES. Every refusal carries a `code`, and the surface owns the words — the same
 * arrangement `routines/routes.ts` uses, for the reason CLAUDE.md gives: a server sentence is
 * English on a Korean screen.
 */

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { AccountDeletion } from "./deletion";
import { type AccountExport, EXPORT_LIMITS } from "./export";

export type AccountService = {
  exporter: AccountExport;
  deletion: AccountDeletion;
  auditStore: AuditStore;
};

export function createAccountRoutes(
  service: AccountService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * Everything this deployment holds about you, as one JSON document.
   *
   * The audit row is written BEFORE the stream opens. An export that is recorded only on success
   * records nothing about the one case worth recording — somebody pulling the whole account and
   * the connection dropping halfway — and "they asked for it" is the fact, not "it arrived".
   */
  routes.get("/me/export", requireUser, async (context) => {
    const actor = context.var.actor;
    await recordAuditEvent(service.auditStore, {
      eventType: "account.exported",
      targetType: "user",
      targetId: actor.id,
      actorUserId: actor.id,
      payload: { limits: EXPORT_LIMITS },
    });

    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(service.exporter.stream(actor.id), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="laf-export-${stamp}.json"`,
        // Nothing between here and the browser gets to hold a copy of somebody's whole account.
        "cache-control": "no-store",
      },
    });
  });

  /**
   * Leaving. The confirmation is the person's own address, typed back.
   *
   * AN ADDRESS RATHER THAN A PHRASE, because a phrase has to be in some language and this product
   * is read in two. "DELETE" is a word a Korean reader is being asked to copy from an English
   * instruction, and a Korean phrase is one an English reader cannot type; an address is the same
   * string on both screens and is the one string that is theirs alone, so it cannot be typed by
   * accident and cannot be guessed by somebody who found an unlocked laptop mid-session.
   */
  routes.post("/me/delete", requireUser, async (context) => {
    const actor = context.var.actor;
    const body = (await context.req.json().catch(() => null)) as {
      confirm?: unknown;
    } | null;
    const confirm =
      typeof body?.confirm === "string" ? body.confirm.trim() : "";
    if (!confirm) {
      return context.json(
        {
          error: "Type your email address to confirm.",
          code: "laf:account_confirmation_required",
          expects: actor.email,
        },
        400,
      );
    }
    if (confirm.toLowerCase() !== actor.email.trim().toLowerCase()) {
      return context.json(
        {
          error: "That is not the email address on this account.",
          code: "laf:account_confirmation_mismatch",
          expects: actor.email,
        },
        400,
      );
    }

    const result = await service.deletion.delete({
      userId: actor.id,
      by: actor.id,
    });
    if (!result.deleted) {
      return context.json(
        { error: "No such account.", code: "laf:account_not_found" },
        404,
      );
    }
    // Their sessions went with the rest of it, so the cookie in this browser now names nothing.
    return context.json({
      deleted: true,
      counts: result.counts,
      computers: result.computers,
    });
  });

  /**
   * An administrator removing somebody else.
   *
   * NOT THEMSELVES. Leaving is a decision a person makes about their own account and it has its own
   * route with its own confirmation; an administrator working down a list of people and reaching
   * their own row is a different act entirely, and the two must not share a button.
   */
  routes.post("/admin/users/:id/delete", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const actor = context.var.actor;
    const target = context.req.param("id");
    if (target === actor.id) {
      return context.json(
        {
          error: "Leave from your own account page instead.",
          code: "laf:account_self_via_admin",
        },
        400,
      );
    }

    const result = await service.deletion.delete({
      userId: target,
      by: actor.id,
    });
    if (!result.deleted) {
      return context.json(
        { error: "No such account.", code: "laf:account_not_found" },
        404,
      );
    }
    return context.json({
      deleted: true,
      counts: result.counts,
      computers: result.computers,
    });
  });

  return routes;
}
