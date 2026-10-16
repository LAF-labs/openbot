import type { Context } from "hono";
import { HUB_HEADERS } from "../../shared/hub/protocol";
import type { AuthedMember, MemberVariables } from "./auth";
import type { HubDatabase, HubTransaction } from "./db/client";
import type { Listeners } from "./events";
import { type Answer, IDEMPOTENCY_KEY_SHAPE, onceFor } from "./idempotency";

/** What a write did beyond its answer, acted on after the commit. */
export type WriteEffects = { emitted: boolean };

export const isAdmin = (member: AuthedMember): boolean =>
  member.role === "owner" || member.role === "admin";

/** The run a write came from, for the trail: the `x-laf-run` header, bounded so it cannot be a payload. */
export function runOf(
  context: Context<{ Variables: MemberVariables }>,
  fromBody?: unknown,
): string | null {
  const value =
    typeof fromBody === "string"
      ? fromBody
      : context.req.header(HUB_HEADERS.run);
  return value && IDEMPOTENCY_KEY_SHAPE.test(value) ? value : null;
}

export const invalid = (field: string): Answer => ({
  status: 400,
  body: { ok: false, code: "laf:request_invalid", field },
});

/**
 * A member's write: refused without an `Idempotency-Key`, done once per key in one transaction, and
 * listeners poked after the commit when it wrote an event.
 *
 * The key is required rather than optional because every member write here raises a version or adds
 * a row, and a VM retrying after a timeout would otherwise raise it twice or add the row twice. The
 * whole decision — refusals included — runs inside the transaction, so a repeat of a refused write
 * is answered with the same refusal and the trail holds it once.
 */
export async function memberWrite(
  context: Context<{ Variables: MemberVariables }>,
  options: { database: HubDatabase; listeners: Listeners },
  work: (tx: HubTransaction, effects: WriteEffects) => Promise<Answer>,
): Promise<Response> {
  const key = context.req.header(HUB_HEADERS.idempotencyKey);
  if (!key || !IDEMPOTENCY_KEY_SHAPE.test(key)) {
    return context.json(
      { ok: false, code: "laf:request_invalid", field: "idempotency-key" },
      400,
    );
  }
  const effects: WriteEffects = { emitted: false };
  const answer = await onceFor(
    options.database,
    context.get("member").id,
    key,
    (tx) => work(tx, effects),
  );
  // After the commit, never inside it: a listener reads the table.
  if (!answer.replayed && effects.emitted) options.listeners.pokeAll();
  return context.json(
    answer.body as Record<string, unknown>,
    answer.status as 200,
  );
}

/** The JSON body, or null when it is not an object. */
export async function jsonBody(
  context: Context,
): Promise<Record<string, unknown> | null> {
  const body = (await context.req.json().catch(() => null)) as unknown;
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}
