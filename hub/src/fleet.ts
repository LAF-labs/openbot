import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, ne, or } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  HUB_FACTS,
  HUB_FLEET_HEADERS,
  HUB_FLEET_KEY_LABEL,
  HUB_ROLES,
  type HubFleetEnvelope,
  type HubFleetMember,
  type HubRole,
} from "../../shared/hub/protocol";
import { recordAudit } from "./audit";
import { canonicalOrigin } from "./auth";
import type { HubDatabase, HubTransaction } from "./db/client";
import { hubMembers, hubWorkspace } from "./db/schema";
import { emitEvent, type Listeners } from "./events";
import { type Answer, IDEMPOTENCY_KEY_SHAPE, onceFor } from "./idempotency";

/**
 * The registry's door: laf-control tells the hub who its members are.
 *
 * SIGNED THE WAY THE FLEET WEBHOOK IS (laf-control `core/webhook-key.ts`, openbot
 * `server/src/fleet/notify.ts`): HMAC-SHA256 over the exact body bytes, `sha256=<hex>` in
 * `x-laf-signature`, the event repeated in `x-laf-event`. The key is derived per hub —
 * `HMAC(master, "laf-hub-fleet/v1 <hub origin>")` — and the hub holds only its own, so a key read
 * off one hub signs nothing another accepts. The body also names the hub it is for, and carries a
 * time and an id inside the signed bytes: a captured request is refused after five minutes, and
 * within them its id makes a replay a no-op (`hub_idempotency`, member `fleet`).
 *
 * What laf-control writes here is the registry only — email, role, the VM's origin and the hash
 * of the pass the VM made for itself. Never the pass.
 */

/** How far a body's `at` may be from the hub's clock, either way. */
export const FLEET_SKEW_MS = 5 * 60 * 1000;

/** How long a rotated pass keeps working, for the requests in flight when it was rotated. */
export const ROTATION_GRACE_MS = 10 * 60 * 1000;

/** The idempotency ledger's member for the registry's own writes. */
const FLEET_MEMBER = "fleet";

const HASH_SHAPE = /^[0-9a-f]{64}$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

/** The key one hub verifies with; laf-control derives the same from its master. */
export function hubFleetKeyFor(master: string, hubOrigin: string): string {
  return createHmac("sha256", master)
    .update(`${HUB_FLEET_KEY_LABEL} ${canonicalOrigin(hubOrigin)}`)
    .digest("hex");
}

export function signHubFleetBody(body: string, key: string): string {
  return `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
}

/** Length first: `timingSafeEqual` throws on unequal lengths, and a throw is not a 401. */
function signatureMatches(
  body: string,
  header: string | undefined,
  key: string,
): boolean {
  if (!header) return false;
  const expected = Buffer.from(signHubFleetBody(body, key));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if ((current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

class Invalid extends Error {
  constructor(readonly field: string) {
    super(field);
  }
}

const isString = (value: unknown): value is string => typeof value === "string";

function originField(value: unknown, field: string): string {
  if (!isString(value) || !/^https?:\/\/[^\s/]+$/.test(canonicalOrigin(value)))
    throw new Invalid(field);
  return canonicalOrigin(value);
}

function parseMember(value: unknown): HubFleetMember {
  if (!value || typeof value !== "object") throw new Invalid("member");
  const member = value as Record<string, unknown>;
  if (
    !isString(member.email) ||
    member.email.length > 320 ||
    !EMAIL_SHAPE.test(member.email)
  )
    throw new Invalid("member.email");
  if (!HUB_ROLES.includes(member.role as HubRole))
    throw new Invalid("member.role");
  if (
    member.name !== undefined &&
    member.name !== null &&
    (!isString(member.name) || member.name.length > 200)
  )
    throw new Invalid("member.name");
  if (!isString(member.vmKeyHash) || !HASH_SHAPE.test(member.vmKeyHash))
    throw new Invalid("member.vmKeyHash");
  if (member.state !== "active" && member.state !== "left")
    throw new Invalid("member.state");
  return {
    email: member.email.trim().toLowerCase(),
    role: member.role as HubRole,
    name: isString(member.name) ? member.name : null,
    vmOrigin: originField(member.vmOrigin, "member.vmOrigin"),
    vmKeyHash: member.vmKeyHash,
    state: member.state,
  };
}

/** Parses the signed body. Throws `Invalid` naming the first field that is wrong. */
export function parseFleetEnvelope(raw: string): HubFleetEnvelope {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Invalid("body");
  }
  if (!body || typeof body !== "object") throw new Invalid("body");
  if (!isString(body.id) || !IDEMPOTENCY_KEY_SHAPE.test(body.id))
    throw new Invalid("id");
  if (!isString(body.at) || Number.isNaN(Date.parse(body.at)))
    throw new Invalid("at");
  const hub = originField(body.hub, "hub");
  if (body.event === "member.put") {
    return {
      event: "member.put",
      id: body.id,
      at: body.at,
      hub,
      member: parseMember(body.member),
    };
  }
  if (body.event === "workspace.put") {
    const workspace = body.workspace as Record<string, unknown> | undefined;
    if (
      !workspace ||
      !isString(workspace.name) ||
      workspace.name.trim() === "" ||
      workspace.name.length > 200
    )
      throw new Invalid("workspace.name");
    if (
      workspace.plan !== undefined &&
      workspace.plan !== null &&
      (!isString(workspace.plan) || workspace.plan.length > 40)
    )
      throw new Invalid("workspace.plan");
    return {
      event: "workspace.put",
      id: body.id,
      at: body.at,
      hub,
      workspace: {
        name: workspace.name.trim(),
        plan: isString(workspace.plan) ? workspace.plan : null,
      },
    };
  }
  throw new Invalid("event");
}

type Effects = { emitted: boolean; closeMember: string | null };

/**
 * One member, created or changed, in the caller's transaction. Keyed by email: the registry knows
 * a person by their address, and the hub's own id is what every other row refers to.
 */
async function putMember(
  tx: HubTransaction,
  input: HubFleetMember,
  now: Date,
  effects: Effects,
): Promise<Answer> {
  const [existing] = await tx
    .select()
    .from(hubMembers)
    .where(eq(hubMembers.email, input.email))
    .for("update");

  if (input.state === "left") {
    if (!existing) {
      return { status: 404, body: { ok: false, code: HUB_FACTS.notFound } };
    }
    if (existing.state === "left") {
      return {
        status: 200,
        body: { ok: true, member: { id: existing.id, state: "left" } },
      };
    }
    // Leaving drops the pass and the VM with it: the hash, the grace, the origin. Nothing the
    // departed VM holds opens anything after this commit.
    await tx
      .update(hubMembers)
      .set({
        state: "left",
        leftAt: now,
        vmKeyHash: null,
        prevKeyHash: null,
        prevKeyUntil: null,
        vmOrigin: null,
      })
      .where(eq(hubMembers.id, existing.id));
    const seq = await emitEvent(tx, {
      type: "member.changed",
      refId: existing.id,
    });
    await recordAudit(tx, {
      action: "member.left",
      member: FLEET_MEMBER,
      target: existing.id,
      outcome: "ok",
    });
    effects.emitted = true;
    effects.closeMember = existing.id;
    return {
      status: 200,
      body: { ok: true, member: { id: existing.id, state: "left" }, seq },
    };
  }

  // Another member already holding this VM or this pass is a registry mistake, refused rather
  // than resolved by taking it from them.
  const [clash] = await tx
    .select({ id: hubMembers.id })
    .from(hubMembers)
    .where(
      and(
        existing ? ne(hubMembers.id, existing.id) : undefined,
        or(
          eq(hubMembers.vmOrigin, input.vmOrigin),
          eq(hubMembers.vmKeyHash, input.vmKeyHash),
          eq(hubMembers.prevKeyHash, input.vmKeyHash),
        ),
      ),
    )
    .limit(1);
  if (clash) {
    return { status: 409, body: { ok: false, code: "laf:hub_conflict" } };
  }

  if (!existing) {
    const id = `m_${randomUUID()}`;
    await tx.insert(hubMembers).values({
      id,
      email: input.email,
      role: input.role,
      name: input.name ?? null,
      vmOrigin: input.vmOrigin,
      vmKeyHash: input.vmKeyHash,
      state: "active",
      joinedAt: now,
    });
    const seq = await emitEvent(tx, { type: "member.changed", refId: id });
    await recordAudit(tx, {
      action: "member.joined",
      member: FLEET_MEMBER,
      vmOrigin: input.vmOrigin,
      target: id,
      outcome: "ok",
      payload: { role: input.role },
    });
    effects.emitted = true;
    return {
      status: 200,
      body: { ok: true, member: { id, state: "active" }, seq },
    };
  }

  const rotated = existing.vmKeyHash !== input.vmKeyHash;
  const changed =
    rotated ||
    existing.state !== "active" ||
    existing.role !== input.role ||
    existing.name !== (input.name ?? null) ||
    existing.vmOrigin !== input.vmOrigin;
  if (!changed) {
    return {
      status: 200,
      body: { ok: true, member: { id: existing.id, state: "active" } },
    };
  }
  const rejoined = existing.state === "left";
  await tx
    .update(hubMembers)
    .set({
      role: input.role,
      name: input.name ?? null,
      vmOrigin: input.vmOrigin,
      vmKeyHash: input.vmKeyHash,
      // The old pass keeps working for the grace, unless the member is coming back: a pass from
      // before they left is not one anybody should be holding.
      prevKeyHash: rotated && !rejoined ? existing.vmKeyHash : null,
      prevKeyUntil:
        rotated && !rejoined && existing.vmKeyHash
          ? new Date(now.getTime() + ROTATION_GRACE_MS)
          : null,
      state: "active",
      leftAt: null,
      ...(rejoined ? { joinedAt: now } : {}),
    })
    .where(eq(hubMembers.id, existing.id));
  const seq = await emitEvent(tx, {
    type: "member.changed",
    refId: existing.id,
  });
  await recordAudit(tx, {
    action: rejoined
      ? "member.joined"
      : rotated
        ? "pass.rotated"
        : "member.changed",
    member: FLEET_MEMBER,
    vmOrigin: input.vmOrigin,
    target: existing.id,
    outcome: "ok",
    payload: { role: input.role },
  });
  effects.emitted = true;
  return {
    status: 200,
    body: { ok: true, member: { id: existing.id, state: "active" }, seq },
  };
}

async function putWorkspace(
  tx: HubTransaction,
  input: { name: string; plan?: string | null },
): Promise<Answer> {
  const [row] = await tx
    .insert(hubWorkspace)
    .values({
      id: `w_${randomUUID()}`,
      name: input.name,
      plan: input.plan ?? null,
    })
    .onConflictDoUpdate({
      target: hubWorkspace.one,
      set: { name: input.name, plan: input.plan ?? null },
    })
    .returning({ id: hubWorkspace.id });
  if (!row) throw new Error("hub_workspace upsert returned nothing");
  await recordAudit(tx, {
    action: "workspace.changed",
    member: FLEET_MEMBER,
    target: row.id,
    outcome: "ok",
  });
  return { status: 200, body: { ok: true, workspace: { id: row.id } } };
}

export type FleetRouteOptions = {
  database: HubDatabase;
  listeners: Listeners;
  /** `HUB_FLEET_SECRET`: this hub's derived key. Absent, the route answers 503. */
  secret: string | undefined;
  /** `HUB_PUBLIC_ORIGIN`: the hub a body must name. */
  hubOrigin: string;
  now?: () => Date;
};

export function fleetRoutes(options: FleetRouteOptions) {
  const now = options.now ?? (() => new Date());
  const hubOrigin = canonicalOrigin(options.hubOrigin);
  const route = new Hono();
  route.post(
    "/",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (context) =>
        context.json({ ok: false, code: "laf:request_invalid" }, 413),
    }),
    async (context) => {
      const secret = options.secret;
      if (!secret) {
        // Not 401: the request may be right and this end unconfigured, which laf-control should
        // retry rather than give up on.
        return context.json({ ok: false, code: "laf:hub_fleet_unset" }, 503);
      }
      // The exact bytes, read once: a re-serialised body matches the signature only by luck.
      const raw = await context.req.text();
      const refused = () =>
        context.json({ ok: false, code: "laf:hub_signature_refused" }, 401);
      if (
        !signatureMatches(
          raw,
          context.req.header(HUB_FLEET_HEADERS.signature),
          secret,
        )
      ) {
        return refused();
      }
      let envelope: HubFleetEnvelope;
      try {
        envelope = parseFleetEnvelope(raw);
      } catch (error) {
        if (error instanceof Invalid) {
          return context.json(
            { ok: false, code: "laf:request_invalid", field: error.field },
            400,
          );
        }
        throw error;
      }
      const at = Date.parse(envelope.at);
      const clock = now();
      if (
        envelope.hub !== hubOrigin ||
        Math.abs(clock.getTime() - at) > FLEET_SKEW_MS
      ) {
        return refused();
      }
      const headerEvent = context.req.header(HUB_FLEET_HEADERS.event);
      if (headerEvent !== undefined && headerEvent !== envelope.event) {
        return context.json(
          { ok: false, code: "laf:request_invalid", field: "event" },
          400,
        );
      }

      const effects: Effects = { emitted: false, closeMember: null };
      let answer: Awaited<ReturnType<typeof onceFor>>;
      try {
        answer = await onceFor(
          options.database,
          FLEET_MEMBER,
          envelope.id,
          (tx) =>
            envelope.event === "member.put"
              ? putMember(tx, envelope.member, clock, effects)
              : putWorkspace(tx, envelope.workspace),
        );
      } catch (error) {
        // Two first-time writes for one address racing each other: the loser's insert meets the
        // winner's row. Nothing was kept for this id, so the registry's retry is answered afresh.
        if (isUniqueViolation(error)) {
          return context.json({ ok: false, code: "laf:hub_conflict" }, 409);
        }
        throw error;
      }
      // After the commit, never inside it: a listener reads the table, and before the commit the
      // table does not have the event yet.
      if (!answer.replayed) {
        if (effects.closeMember) {
          options.listeners.closeMember(
            effects.closeMember,
            4401,
            HUB_FACTS.passRefused,
          );
        }
        if (effects.emitted) options.listeners.pokeAll();
      }
      return context.json(
        answer.body as Record<string, unknown>,
        answer.status as 200,
      );
    },
  );
  return route;
}
