/**
 * `POST /api/me/first-task`: a person pressed one of the first things to ask a new Bot.
 *
 * WHY THE SERVER HEARS ABOUT IT AT ALL. The chips on a new Bot's empty conversation
 * (`app/src/lib/agents/first-tasks.ts`) were reported as a browser event and nothing else, on the
 * grounds that "did the chips get used" could be read off a console. The launch plan's first
 * question — which of the eight kinds of work people actually pick — is asked of the fleet, and a
 * console on somebody's laptop in Seoul is not a thing the fleet can read. So the press leaves one
 * audit row, which laf-control's `insights` counts (`GET /api/admin/metrics/insights`).
 *
 * CATALOGUE KEYS, CHECKED AGAINST THE CATALOGUES. What is recorded is which kind of chip, which
 * work pattern, which site or account made the sentence answerable, and what the Bot's card
 * suggested — each one checked against the table it comes from, so nothing that reaches the row
 * can be anything but a key this product ships. The SENTENCE is never read: it is an English key
 * today, but `kind`, `pattern` and `via` already name it exactly (one sentence per pattern with
 * nothing connected, one per site, one per account), and a field that carries a sentence is a field
 * one change away from carrying what somebody typed.
 *
 * A BOT THE PERSON CAN SEE, or 404 — the same answer `GET /api/agents/:agentId` gives, from the same
 * store, so a press cannot put a row in the trail naming somebody else's private Bot.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  BUSINESS_SITES,
  type SiteCategory,
} from "../../../shared/sites/catalogue";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { isBotId } from "../computer/bot-id";
import { CATALOGUE } from "../plugins/catalogue";
import type { AgentProfileStore } from "./profile-store";

/**
 * The eight work patterns, as a list the parser can check against.
 *
 * `satisfies Record<SiteCategory, true>` is the tether, the same one `app/tests/site-catalogue.test.ts`
 * uses: a pattern added to the type and not here is a typecheck error, and one here that the type
 * does not have is too. `SiteCategory` is in turn held to the app's `WORK_PATTERNS` by that test.
 */
export const WORK_PATTERN_IDS = Object.keys({
  "night-watch": true,
  approval: true,
  settlement: true,
  enquiries: true,
  schedule: true,
  stock: true,
  reputation: true,
  paperwork: true,
} satisfies Record<SiteCategory, true>) as SiteCategory[];

export const FIRST_TASK_KINDS = ["ask", "routine", "connect"] as const;
export type FirstTaskKind = (typeof FIRST_TASK_KINDS)[number];

export type FirstTaskPress = {
  agentId: string;
  kind: FirstTaskKind;
  /** The kind of work the chip asked for. Null only for the connect chip, which asks nothing. */
  pattern: SiteCategory | null;
  /** The connection that made the sentence answerable, or null when it needed none. */
  via: { kind: "site" | "account"; id: string } | null;
  /** What the Bot's card suggested when the chip was pressed, or null when it suggested nothing. */
  hint: SiteCategory | null;
};

export const FIRST_TASK_INVALID = "laf:first_task_invalid";

const SITE_IDS = new Set(BUSINESS_SITES.map((site) => site.id));
const ACCOUNT_IDS = new Set(CATALOGUE.map((entry) => entry.key));
const PATTERNS = new Set<string>(WORK_PATTERN_IDS);

const isPattern = (value: unknown): value is SiteCategory =>
  typeof value === "string" && PATTERNS.has(value);

/**
 * The press, or a refusal. Every field is checked against the catalogue it names; keys the body
 * carries that are not these five — `sentence` above all — are not read, so they cannot be kept.
 */
export function parseFirstTaskPress(
  body: unknown,
): { ok: true; value: FirstTaskPress } | { ok: false; code: string } {
  const refused = { ok: false, code: FIRST_TASK_INVALID } as const;
  if (!body || typeof body !== "object" || Array.isArray(body)) return refused;
  const input = body as Record<string, unknown>;

  // The shape every Bot id has (`computer/bot-id.ts`); whether this person can see it is the store's.
  const agentId = input.agentId;
  if (!isBotId(agentId)) return refused;
  const kind = FIRST_TASK_KINDS.find((known) => known === input.kind);
  if (!kind) return refused;

  const rawHint = input.hint ?? null;
  if (rawHint !== null && !isPattern(rawHint)) return refused;
  const hint: SiteCategory | null = isPattern(rawHint) ? rawHint : null;

  const rawPattern = input.pattern ?? null;
  const rawVia = input.via ?? null;
  // The connect chip asks nothing and goes nowhere but the 연결 screen: it has neither.
  if (kind === "connect") {
    if (rawPattern !== null || rawVia !== null) return refused;
    return {
      ok: true,
      value: { agentId, kind, pattern: null, via: null, hint },
    };
  }

  if (!isPattern(rawPattern)) return refused;
  const pattern: SiteCategory = rawPattern;
  let via: FirstTaskPress["via"] = null;
  if (rawVia !== null) {
    if (typeof rawVia !== "object" || Array.isArray(rawVia)) return refused;
    const { kind: viaKind, id } = rawVia as { kind?: unknown; id?: unknown };
    if (viaKind === "site" && typeof id === "string" && SITE_IDS.has(id)) {
      via = { kind: "site", id };
    } else if (
      viaKind === "account" &&
      typeof id === "string" &&
      ACCOUNT_IDS.has(id)
    ) {
      via = { kind: "account", id };
    } else {
      return refused;
    }
  }
  return {
    ok: true,
    value: { agentId, kind, pattern, via, hint },
  };
}

export function createFirstTaskRoutes(
  store: Pick<AgentProfileStore, "get">,
  auditStore: AuditStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/me/first-task", requireUser, async (context) => {
    const parsed = parseFirstTaskPress(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) {
      return context.json({ error: parsed.code, code: parsed.code }, 400);
    }
    const press = parsed.value;
    const actor = context.var.actor;
    if (!(await store.get(actor, press.agentId))) {
      return context.json(
        { error: "laf:agent_not_found", code: "laf:agent_not_found" },
        404,
      );
    }

    await recordAuditEvent(auditStore, {
      eventType: "onboarding.first_task_pressed",
      targetType: "agent",
      targetId: press.agentId,
      actorUserId: actor.id,
      payload: {
        agentId: press.agentId,
        kind: press.kind,
        pattern: press.pattern,
        via: press.via,
        hint: press.hint,
      },
    });
    return context.body(null, 204);
  });

  return routes;
}
