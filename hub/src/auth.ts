import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, gt, or } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import {
  HUB_FACTS,
  HUB_HEADERS,
  type HubRole,
} from "../../shared/hub/protocol";
import type { HubDatabase } from "./db/client";
import { hubMembers } from "./db/schema";

/** A pass is what `openssl rand -hex 32` prints: 64 lowercase hex characters. */
const PASS_SHAPE = /^[0-9a-f]{64}$/;

/** The SHA-256 a member row holds for a pass. The pass itself is never stored. */
export function hashPass(pass: string): string {
  return createHash("sha256").update(pass).digest("hex");
}

export type AuthedMember = {
  id: string;
  role: HubRole;
  name: string | null;
  vmOrigin: string | null;
  /** The hash of the pass this request came with. */
  passHash: string;
  /** When that pass stops working: its rotation grace's end, or null for the current pass. */
  passUntil: Date | null;
};

/** The origin as a VM writes `PUBLIC_ORIGIN`: no trailing slash. */
export const canonicalOrigin = (origin: string): string =>
  origin.trim().replace(/\/+$/, "");

/**
 * The member a pass belongs to, or null.
 *
 * Looked up by hash, so the database index only ever sees a hash, and then compared again in
 * constant time against the hash the row holds — the lookup alone would let response timing say
 * how much of a guessed hash matched. A member who left holds no hash at all, so they are not
 * found; a rotated pass is found through `prev_key_hash` until its grace runs out.
 */
export async function memberForPass(
  database: HubDatabase,
  pass: string,
  now: Date = new Date(),
): Promise<AuthedMember | null> {
  if (!PASS_SHAPE.test(pass)) return null;
  const hash = hashPass(pass);
  const [row] = await database
    .select({
      id: hubMembers.id,
      role: hubMembers.role,
      name: hubMembers.name,
      vmOrigin: hubMembers.vmOrigin,
      vmKeyHash: hubMembers.vmKeyHash,
      prevKeyHash: hubMembers.prevKeyHash,
      prevKeyUntil: hubMembers.prevKeyUntil,
    })
    .from(hubMembers)
    .where(
      and(
        eq(hubMembers.state, "active"),
        or(
          eq(hubMembers.vmKeyHash, hash),
          and(
            eq(hubMembers.prevKeyHash, hash),
            gt(hubMembers.prevKeyUntil, now),
          ),
        ),
      ),
    )
    .limit(1);
  if (!row) return null;
  const given = Buffer.from(hash);
  const matches = [row.vmKeyHash, row.prevKeyHash].some((stored) => {
    if (!stored) return false;
    const expected = Buffer.from(stored);
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  if (!matches) return null;
  return {
    id: row.id,
    role: row.role as HubRole,
    name: row.name,
    vmOrigin: row.vmOrigin,
    passHash: hash,
    passUntil: row.vmKeyHash === hash ? null : row.prevKeyUntil,
  };
}

export type MemberVariables = { member: AuthedMember };

/**
 * `Authorization: Bearer <pass>` → the member, or a 401 of one line.
 *
 * NOTHING ABOUT A REFUSED REQUEST IS LOGGED. The hub's door is open to the internet (a VM's
 * public address cannot be put in an allow-list), so most refusals are scanners, and a log line
 * per scanner is a disk filled by strangers. And the line would be next to a pass: a header that
 * was somebody's real pass typed into the wrong place is exactly what must not be written down.
 *
 * `x-laf-vm`, when a VM sends it, must name the origin the member row holds: a pass copied off one
 * VM and used from another is refused even though the pass itself is good.
 */
export function requireMember(
  database: HubDatabase,
): MiddlewareHandler<{ Variables: MemberVariables }> {
  return async (context, next) => {
    const header = context.req.header("authorization") ?? "";
    const pass = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const member = pass ? await memberForPass(database, pass) : null;
    const claimedVm = context.req.header(HUB_HEADERS.vm);
    if (
      !member ||
      (claimedVm !== undefined &&
        canonicalOrigin(claimedVm) !== (member.vmOrigin ?? ""))
    ) {
      return context.json({ ok: false, code: HUB_FACTS.passRefused }, 401);
    }
    context.set("member", member);
    await next();
  };
}
