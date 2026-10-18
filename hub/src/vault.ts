import { createHash, randomBytes } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  HUB_FACTS,
  HUB_HEADERS,
  HUB_VAULT_FACTS,
  HUB_VAULT_LEASE_MS,
  HUB_VAULT_LIMITS,
  type HubVault,
  type HubVaultLease,
  type HubVaultLogin,
  type HubVaultOpened,
} from "../../shared/hub/protocol";
import type { Logger } from "../../shared/log";
import {
  LoginSealError,
  openLogin,
  type SealedLogin,
  sealLogin,
} from "../../shared/login-seal";
import { recordAudit } from "./audit";
import {
  type AuthedMember,
  canonicalOrigin,
  type MemberVariables,
} from "./auth";
import type { HubDatabase, HubTransaction } from "./db/client";
import {
  hubAudit,
  hubMembers,
  hubVaultDevices,
  hubVaultGrants,
  hubVaultLeases,
  hubVaultLogins,
} from "./db/schema";
import { emitEvent, type Listeners } from "./events";

/**
 * THE COMPANY LOGIN VAULT. An admin stores a login once (a site, the origins it is filled on, a
 * name and a password) and grants it to members; a member's VM leases it, opens it once per lease,
 * and says when it verified itself as a new device on the site.
 *
 * WHERE A VALUE MAY BE. In the request that stores it, sealed before it reaches SQL, and in the
 * answer to `open` — nowhere else. Not in `GET /vault`, not in an event, not in the trail, not in a
 * log line, and not in `hub_idempotency`: no route here goes through `onceFor`, because that ledger
 * keeps a copy of the answer, and the answer to `open` is the values. A retried `open` is refused
 * (the lease was spent) and the VM leases again, which is a new row in the trail and not a replay.
 *
 * THE SEAL IS THE PERSON'S SAVED LOGINS' (`shared/login-seal.ts`), the same functions: a key of the
 * row's own, wrapped under `HUB_KEY_ENCRYPTION_KEY`, the row's id and the field bound into each
 * seal. The hub has no second implementation of it. Without the key the vault answers
 * `laf:hub_vault_unset` and the rest of the hub runs.
 *
 * ONE VM AT A TIME. A site that signs one session out when another signs in would have two VMs
 * knocking each other off it, so a lease is exclusive: a second member's VM is told whose VM holds
 * it and until when. A login marked `concurrent` is one whose site allows several at once — its
 * leases never answer busy — but every lease still opens once, so each value handed out is one
 * row in the trail with the run that asked.
 */

/** What `SealedFor.userId` is on the hub: its logins belong to the company, not to one person. */
export const HUB_VAULT_SEAL_OWNER = "hub";

/** A login's id, chosen by the admin's VM: no spaces, bounded, the same shape as the hub's own. */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,80}$/;
const MEMBER_SHAPE = /^[A-Za-z0-9_-]{1,80}$/;
const RUN_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** A lease as `lease` hands it out: 32 random bytes, hex. */
const LEASE_SHAPE = /^[0-9a-f]{64}$/;

class Invalid extends Error {
  constructor(readonly field: string) {
    super(field);
  }
}

type Reply = { status: 200 | 400 | 403 | 404 | 409; body: unknown };

const invalid = (field: string): Reply => ({
  status: 400,
  body: { ok: false, code: "laf:request_invalid", field },
});
const notFound: Reply = {
  status: 404,
  body: { ok: false, code: HUB_FACTS.notFound },
};
const forbidden: Reply = {
  status: 403,
  body: { ok: false, code: HUB_FACTS.forbidden },
};
const leaseInvalid: Reply = {
  status: 409,
  body: { ok: false, code: HUB_VAULT_FACTS.leaseInvalid },
};

const isString = (value: unknown): value is string => typeof value === "string";
const isManager = (member: AuthedMember) =>
  member.role === "owner" || member.role === "admin";
const hashLease = (lease: string) =>
  createHash("sha256").update(lease).digest("hex");

/**
 * An origin as the browser reports one, `https://host[:port]`, or null. Parsed rather than matched,
 * so `https://Example.com/` and `https://example.com` are one origin, as they are to the page.
 */
function originOf(value: unknown): string | null {
  if (!isString(value) || value.length > 300) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return url.origin;
}

/**
 * The body as an object, or null. A body that does not parse is answered 400 and never logged:
 * a parser's message can quote what it was parsing, and here that is a password.
 */
async function readJson(
  context: Context,
): Promise<Record<string, unknown> | null> {
  try {
    const body = await context.req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

type LoginPut = {
  label: string;
  site: string | null;
  origins: string[];
  values: { username: string; password: string } | null;
  concurrent: boolean | undefined;
};

function parseLoginPut(body: Record<string, unknown>): LoginPut {
  const label = isString(body.label) ? body.label.trim() : "";
  if (label === "" || label.length > HUB_VAULT_LIMITS.label)
    throw new Invalid("label");
  let site: string | null = null;
  if (body.site !== undefined && body.site !== null) {
    if (!isString(body.site) || body.site.length > HUB_VAULT_LIMITS.site)
      throw new Invalid("site");
    site = body.site.trim() || null;
  }
  if (
    !Array.isArray(body.origins) ||
    body.origins.length === 0 ||
    body.origins.length > HUB_VAULT_LIMITS.origins
  )
    throw new Invalid("origins");
  const origins: string[] = [];
  for (const value of body.origins) {
    const origin = originOf(value);
    if (!origin) throw new Invalid("origins");
    if (!origins.includes(origin)) origins.push(origin);
  }
  // Both or neither: a change that sends one value alone would have to open the row to reseal the
  // other, and the admin's screen holds both whenever it holds one.
  const hasUsername = body.username !== undefined;
  const hasPassword = body.password !== undefined;
  if (hasUsername !== hasPassword)
    throw new Invalid(hasUsername ? "password" : "username");
  let values: LoginPut["values"] = null;
  if (hasUsername) {
    const { username, password } = body;
    if (
      !isString(username) ||
      username === "" ||
      username.length > HUB_VAULT_LIMITS.username
    )
      throw new Invalid("username");
    if (
      !isString(password) ||
      password === "" ||
      password.length > HUB_VAULT_LIMITS.password
    )
      throw new Invalid("password");
    values = { username, password };
  }
  if (body.concurrent !== undefined && typeof body.concurrent !== "boolean")
    throw new Invalid("concurrent");
  return {
    label,
    site,
    origins,
    values,
    concurrent: body.concurrent as boolean | undefined,
  };
}

function parseMembers(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.members)) throw new Invalid("members");
  const ids = [...new Set(body.members)];
  if (ids.length > HUB_VAULT_LIMITS.members) throw new Invalid("members");
  for (const id of ids) {
    if (!isString(id) || !MEMBER_SHAPE.test(id)) throw new Invalid("members");
  }
  return ids as string[];
}

function parseLease(value: unknown, field = "lease"): string {
  if (!isString(value) || !LEASE_SHAPE.test(value)) throw new Invalid(field);
  return value;
}

/** `x-laf-run` for the trail, when it has the shape of a run id; anything else is not written. */
function runHeader(context: Context): string | null {
  const value = context.req.header(HUB_HEADERS.run);
  return value !== undefined && RUN_SHAPE.test(value) ? value : null;
}

function parseRun(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!isString(value) || !RUN_SHAPE.test(value)) throw new Invalid("runId");
  return value;
}

async function holdsGrant(
  tx: HubTransaction | HubDatabase,
  loginId: string,
  memberId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ loginId: hubVaultGrants.loginId })
    .from(hubVaultGrants)
    .where(
      and(
        eq(hubVaultGrants.loginId, loginId),
        eq(hubVaultGrants.memberId, memberId),
      ),
    );
  return Boolean(row);
}

/**
 * The origins of every company login a member was granted or opened, for their leaving. Never a
 * value. Three sources, because a grant can be gone before the member is: the grants they hold now,
 * the logins the trail says they opened (a grant taken away last month left the cookies behind),
 * and the logins an earlier leaving dropped (`member.left`'s `vaultLogins`), so asking again after
 * the leaving answers the same.
 */
export async function vaultOriginsOf(
  tx: HubTransaction,
  memberId: string,
): Promise<string[]> {
  const granted = await tx
    .select({ loginId: hubVaultGrants.loginId })
    .from(hubVaultGrants)
    .where(eq(hubVaultGrants.memberId, memberId));
  const trail = await tx
    .select({
      action: hubAudit.action,
      target: hubAudit.target,
      payload: hubAudit.payload,
    })
    .from(hubAudit)
    .where(
      sql`(${hubAudit.action} = 'vault.opened' and ${hubAudit.member} = ${memberId} and ${hubAudit.outcome} = 'ok')
          or (${hubAudit.action} = 'member.left' and ${hubAudit.target} = ${memberId})`,
    );
  const ids = new Set(granted.map((row) => row.loginId));
  // The origin each open was for, as the trail wrote it: an admin may have moved the login off it
  // since, and the cookies the fill left are on the origin it was filled on, not the one it is now.
  const opened = new Set<string>();
  for (const row of trail) {
    const payload = row.payload as {
      origin?: unknown;
      vaultLogins?: unknown;
    } | null;
    if (row.action === "vault.opened") {
      if (row.target) ids.add(row.target);
      if (isString(payload?.origin)) opened.add(payload.origin);
    }
    const dropped = payload?.vaultLogins;
    if (Array.isArray(dropped)) {
      for (const id of dropped) if (isString(id)) ids.add(id);
    }
  }
  if (ids.size === 0) return [...opened].sort();
  const logins = await tx
    .select({ origins: hubVaultLogins.origins })
    .from(hubVaultLogins)
    .where(inArray(hubVaultLogins.id, [...ids]));
  return [
    ...new Set([...opened, ...logins.flatMap((row) => row.origins)]),
  ].sort();
}

/**
 * A member is leaving: their grants and leases go in the caller's transaction (the registry's
 * `member.put` with `state: "left"`), and so does every device their VM verified — the leaving has
 * that VM's cookies cleared, so the sites will ask it again, and the origin is free for the next
 * member, who would otherwise be counted as verified on arrival. Answers the logins whose grant was
 * dropped, for the trail.
 */
export async function dropVaultFor(
  tx: HubTransaction,
  member: { id: string; vmOrigin: string | null },
): Promise<string[]> {
  const dropped = await tx
    .delete(hubVaultGrants)
    .where(eq(hubVaultGrants.memberId, member.id))
    .returning({ loginId: hubVaultGrants.loginId });
  await tx.delete(hubVaultLeases).where(eq(hubVaultLeases.memberId, member.id));
  if (member.vmOrigin) {
    await tx
      .delete(hubVaultDevices)
      .where(eq(hubVaultDevices.vmOrigin, member.vmOrigin));
  }
  return dropped.map((row) => row.loginId).sort();
}

/**
 * A login that is one VM at a time keeps one lease: the one opened first, or, with none opened,
 * the one taken first. Every other lease on it goes, opened or not, in the caller's transaction
 * (a `PUT` that turns `concurrent` off, under the login row's lock), so `open` and `lease` see one
 * holder from the moment the change commits. A deleted lease that was opened cannot take its values
 * back, but it no longer renews or holds the login. The one kept is marked exclusive, so the
 * partial unique index stands under it as it does under a lease taken in exclusive mode.
 */
async function keepOneHolder(
  tx: HubTransaction,
  loginId: string,
  now: Date,
): Promise<void> {
  const [kept] = await tx
    .select({ id: hubVaultLeases.id })
    .from(hubVaultLeases)
    .where(
      and(eq(hubVaultLeases.loginId, loginId), gt(hubVaultLeases.until, now)),
    )
    .orderBy(
      sql`${hubVaultLeases.openedAt} asc nulls last`,
      asc(hubVaultLeases.at),
      asc(hubVaultLeases.id),
    )
    .limit(1);
  await tx
    .delete(hubVaultLeases)
    .where(
      and(
        eq(hubVaultLeases.loginId, loginId),
        kept ? ne(hubVaultLeases.id, kept.id) : undefined,
      ),
    );
  if (kept) {
    await tx
      .update(hubVaultLeases)
      .set({ exclusive: true })
      .where(eq(hubVaultLeases.id, kept.id));
  }
}

export type VaultRouteOptions = {
  database: HubDatabase;
  listeners: Listeners;
  member: MiddlewareHandler<{ Variables: MemberVariables }>;
  log: Logger;
  /** `HUB_KEY_ENCRYPTION_KEY`, 64 hex. Absent, every route answers `laf:hub_vault_unset`. */
  key: string | undefined;
  now?: () => Date;
  /** `HUB_VAULT_LEASE_MS`; shorter only in tests. */
  leaseMs?: number;
};

export function vaultRoutes(options: VaultRouteOptions) {
  const { database, listeners, log } = options;
  const clock = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? HUB_VAULT_LEASE_MS;
  // `shared/login-seal.ts` takes the key as base64, as the server's `KEY_ENCRYPTION_KEY` is
  // written; the hub's is written as hex like its other keys. The same 32 bytes either way.
  const encodedKey = options.key
    ? Buffer.from(options.key, "hex").toString("base64")
    : undefined;
  const sealedFor = (id: string) => ({ id, userId: HUB_VAULT_SEAL_OWNER });

  const route = new Hono<{ Variables: MemberVariables }>();
  route.use("*", options.member);
  route.use("*", async (context, next) => {
    if (!encodedKey) {
      // Not 500: nothing failed. This hub was started without the key, and an operator adding it
      // is the fix; until then the VM shows the fact and the rest of the hub serves.
      return context.json({ ok: false, code: HUB_VAULT_FACTS.unset }, 503);
    }
    await next();
  });
  route.use(
    "*",
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (context) =>
        context.json({ ok: false, code: "laf:request_invalid" }, 413),
    }),
  );

  const reply = (context: Context, answer: Reply) =>
    context.json(answer.body as Record<string, unknown>, answer.status);

  /** Every login, with what the caller may do with it. No value, ever. */
  route.get("/", async (context) => {
    const self = context.get("member");
    const now = clock();
    const logins = await database
      .select({
        id: hubVaultLogins.id,
        label: hubVaultLogins.label,
        site: hubVaultLogins.site,
        origins: hubVaultLogins.origins,
        concurrent: hubVaultLogins.concurrent,
      })
      .from(hubVaultLogins)
      .orderBy(asc(hubVaultLogins.label), asc(hubVaultLogins.id));
    // The VMs a login counts are those of active members holding a grant: a member who left holds
    // no VM, and a VM that verified and then lost its grant is no longer one of the five.
    const grants = await database
      .select({
        loginId: hubVaultGrants.loginId,
        memberId: hubVaultGrants.memberId,
        vmOrigin: hubMembers.vmOrigin,
      })
      .from(hubVaultGrants)
      .innerJoin(hubMembers, eq(hubMembers.id, hubVaultGrants.memberId))
      .where(eq(hubMembers.state, "active"));
    const devices = await database
      .select({
        loginId: hubVaultDevices.loginId,
        vmOrigin: hubVaultDevices.vmOrigin,
      })
      .from(hubVaultDevices);
    const held = await database
      .select({
        loginId: hubVaultLeases.loginId,
        memberId: hubVaultLeases.memberId,
        until: hubVaultLeases.until,
      })
      .from(hubVaultLeases)
      .where(gt(hubVaultLeases.until, now));
    const body: HubVault = {
      ok: true,
      logins: logins.map((login): HubVaultLogin => {
        const granted = grants.filter((row) => row.loginId === login.id);
        const vms = new Set(
          granted.flatMap((row) => (row.vmOrigin ? [row.vmOrigin] : [])),
        );
        const verified = devices.filter(
          (row) => row.loginId === login.id && vms.has(row.vmOrigin),
        ).length;
        // Any lease of another member's, as `lease` counts it: one taken while the login was
        // still concurrent holds it too.
        const other = login.concurrent
          ? undefined
          : held.find(
              (row) => row.loginId === login.id && row.memberId !== self.id,
            );
        return {
          id: login.id,
          label: login.label,
          site: login.site,
          origins: login.origins,
          canUse: granted.some((row) => row.memberId === self.id),
          concurrent: login.concurrent,
          verifiedVms: verified,
          totalVms: vms.size,
          ...(other
            ? {
                busy: {
                  member: other.memberId,
                  until: other.until.toISOString(),
                },
              }
            : {}),
        };
      }),
    };
    return context.json(body);
  });

  /** Store or change a login (admin). The two values are sealed here and never read back. */
  route.put("/:id", async (context) => {
    const self = context.get("member");
    const id = context.req.param("id");
    if (!isManager(self)) return reply(context, forbidden);
    if (!ID_SHAPE.test(id)) return reply(context, invalid("id"));
    const body = await readJson(context);
    if (!body) return reply(context, invalid("body"));
    let input: LoginPut;
    try {
      input = parseLoginPut(body);
    } catch (error) {
      if (error instanceof Invalid) return reply(context, invalid(error.field));
      throw error;
    }
    // Sealed before the transaction: SQL only ever carries what `sealLogin` returned.
    const sealed: SealedLogin | null = input.values
      ? await sealLogin(encodedKey as string, sealedFor(id), input.values)
      : null;
    const now = clock();
    const answer = await database.transaction(async (tx): Promise<Reply> => {
      const [existing] = await tx
        .select({
          id: hubVaultLogins.id,
          concurrent: hubVaultLogins.concurrent,
        })
        .from(hubVaultLogins)
        .where(eq(hubVaultLogins.id, id))
        .for("update");
      if (!existing && !sealed) return invalid("password");
      if (existing) {
        await tx
          .update(hubVaultLogins)
          .set({
            label: input.label,
            site: input.site,
            origins: input.origins,
            ...(input.concurrent === undefined
              ? {}
              : { concurrent: input.concurrent }),
            ...(sealed ?? {}),
            changedBy: self.id,
            changedAt: now,
          })
          .where(eq(hubVaultLogins.id, id));
        // A lease not yet opened is for one origin; one the login is no longer filled on can never
        // open, so it must not keep holding the login either. An opened lease stays until it is
        // released or lapses: its run is already signed in, and the browser is still its.
        await tx
          .delete(hubVaultLeases)
          .where(
            and(
              eq(hubVaultLeases.loginId, id),
              isNull(hubVaultLeases.openedAt),
              notInArray(hubVaultLeases.origin, input.origins),
            ),
          );
        if (!(input.concurrent ?? existing.concurrent)) {
          await keepOneHolder(tx, id, now);
        }
      } else if (sealed) {
        await tx.insert(hubVaultLogins).values({
          id,
          label: input.label,
          site: input.site,
          origins: input.origins,
          concurrent: input.concurrent ?? false,
          ...sealed,
          createdBy: self.id,
          createdAt: now,
        });
      }
      await emitEvent(tx, { type: "vault.changed", refId: id, actor: self.id });
      await recordAudit(tx, {
        action: "vault.changed",
        member: self.id,
        vmOrigin: self.vmOrigin,
        target: id,
        runId: runHeader(context),
        outcome: existing ? "changed" : "created",
        payload: { resealed: sealed !== null },
      });
      return { status: 200, body: { ok: true, id } };
    });
    if (answer.status === 200) listeners.pokeAll();
    return reply(context, answer);
  });

  /** Who may use a login (admin): the whole list, replacing the one before. */
  route.put("/:id/grants", async (context) => {
    const self = context.get("member");
    const id = context.req.param("id");
    if (!isManager(self)) return reply(context, forbidden);
    if (!ID_SHAPE.test(id)) return reply(context, notFound);
    const body = await readJson(context);
    if (!body) return reply(context, invalid("body"));
    let members: string[];
    try {
      members = parseMembers(body);
    } catch (error) {
      if (error instanceof Invalid) return reply(context, invalid(error.field));
      throw error;
    }
    const answer = await database.transaction(async (tx): Promise<Reply> => {
      const [login] = await tx
        .select({ id: hubVaultLogins.id })
        .from(hubVaultLogins)
        .where(eq(hubVaultLogins.id, id))
        .for("update");
      if (!login) return notFound;
      if (members.length > 0) {
        const known = await tx
          .select({ id: hubMembers.id })
          .from(hubMembers)
          .where(
            and(
              inArray(hubMembers.id, members),
              eq(hubMembers.state, "active"),
            ),
          );
        if (known.length !== members.length) return invalid("members");
      }
      await tx
        .delete(hubVaultGrants)
        .where(
          and(
            eq(hubVaultGrants.loginId, id),
            members.length > 0
              ? notInArray(hubVaultGrants.memberId, members)
              : undefined,
          ),
        );
      // A member whose grant was taken away keeps no lease on it: their next `open` is refused.
      await tx
        .delete(hubVaultLeases)
        .where(
          and(
            eq(hubVaultLeases.loginId, id),
            members.length > 0
              ? notInArray(hubVaultLeases.memberId, members)
              : undefined,
          ),
        );
      if (members.length > 0) {
        await tx
          .insert(hubVaultGrants)
          .values(
            members.map((memberId) => ({
              loginId: id,
              memberId,
              grantedBy: self.id,
            })),
          )
          .onConflictDoNothing();
      }
      await emitEvent(tx, { type: "vault.changed", refId: id, actor: self.id });
      await recordAudit(tx, {
        action: "vault.changed",
        member: self.id,
        vmOrigin: self.vmOrigin,
        target: id,
        outcome: "granted",
        payload: { members: [...members].sort() },
      });
      return { status: 200, body: { ok: true, id, members } };
    });
    if (answer.status === 200) listeners.pokeAll();
    return reply(context, answer);
  });

  /**
   * Take a login for one run, or renew the caller's own lease (`lease` in the body). Exclusive
   * unless the login is `concurrent`: the login row is locked first, so two VMs asking at once are
   * answered one after the other and the second is told the first holds it.
   */
  route.post("/:id/lease", async (context) => {
    const self = context.get("member");
    const id = context.req.param("id");
    if (!ID_SHAPE.test(id)) return reply(context, notFound);
    const body = await readJson(context);
    if (!body) return reply(context, invalid("body"));
    let origin: string | null;
    let runId: string | null;
    let renew: string | null;
    try {
      origin = originOf(body.origin);
      if (!origin) throw new Invalid("origin");
      runId = parseRun(body.runId ?? context.req.header(HUB_HEADERS.run));
      renew = body.lease === undefined ? null : parseLease(body.lease);
    } catch (error) {
      if (error instanceof Invalid) return reply(context, invalid(error.field));
      throw error;
    }
    const now = clock();
    const until = new Date(now.getTime() + leaseMs);
    const answer = await database.transaction(async (tx): Promise<Reply> => {
      const [login] = await tx
        .select({
          id: hubVaultLogins.id,
          origins: hubVaultLogins.origins,
          concurrent: hubVaultLogins.concurrent,
        })
        .from(hubVaultLogins)
        .where(eq(hubVaultLogins.id, id))
        .for("update");
      if (!login) return notFound;
      if (!(await holdsGrant(tx, id, self.id))) return forbidden;
      if (!login.origins.includes(origin)) {
        return {
          status: 409,
          body: { ok: false, code: HUB_VAULT_FACTS.originMismatch },
        };
      }
      const trail = {
        action: "vault.leased",
        member: self.id,
        vmOrigin: self.vmOrigin,
        target: id,
        runId,
        payload: { origin },
      };

      if (renew) {
        const renewed = await tx
          .update(hubVaultLeases)
          .set({ until })
          .where(
            and(
              eq(hubVaultLeases.id, hashLease(renew)),
              eq(hubVaultLeases.loginId, id),
              eq(hubVaultLeases.memberId, self.id),
              gt(hubVaultLeases.until, now),
            ),
          )
          .returning({ id: hubVaultLeases.id });
        if (renewed.length === 0) return leaseInvalid;
        await recordAudit(tx, { ...trail, outcome: "renewed" });
        const lease: HubVaultLease = {
          ok: true,
          lease: renew,
          until: until.toISOString(),
          concurrent: login.concurrent,
        };
        return { status: 200, body: lease };
      }

      await tx
        .delete(hubVaultLeases)
        .where(
          and(eq(hubVaultLeases.loginId, id), lte(hubVaultLeases.until, now)),
        );
      if (!login.concurrent) {
        const [holder] = await tx
          .select({
            memberId: hubVaultLeases.memberId,
            until: hubVaultLeases.until,
          })
          .from(hubVaultLeases)
          .where(
            and(
              eq(hubVaultLeases.loginId, id),
              ne(hubVaultLeases.memberId, self.id),
            ),
          )
          .limit(1);
        if (holder) {
          await recordAudit(tx, { ...trail, outcome: "busy" });
          return {
            status: 409,
            body: {
              ok: false,
              code: HUB_VAULT_FACTS.busy,
              busy: {
                member: holder.memberId,
                until: holder.until.toISOString(),
              },
            },
          };
        }
        // The caller's own earlier lease (a run that ended without releasing) gives way: one VM is
        // one browser, and it queues its own runs.
        await tx
          .delete(hubVaultLeases)
          .where(
            and(
              eq(hubVaultLeases.loginId, id),
              eq(hubVaultLeases.memberId, self.id),
            ),
          );
      }
      const lease = randomBytes(32).toString("hex");
      await tx.insert(hubVaultLeases).values({
        id: hashLease(lease),
        loginId: id,
        memberId: self.id,
        vmOrigin: self.vmOrigin,
        runId,
        origin,
        exclusive: !login.concurrent,
        until,
        at: now,
      });
      await recordAudit(tx, { ...trail, outcome: "ok" });
      const body: HubVaultLease = {
        ok: true,
        lease,
        until: until.toISOString(),
        concurrent: login.concurrent,
      };
      return { status: 200, body };
    });
    return reply(context, answer);
  });

  /**
   * The values, once per lease. The lease is spent by the same statement that checks it, so two
   * `open`s racing on one lease cannot both pass; the grant is checked again, since it may have
   * been taken away since the lease was given, and so is the lease's origin, which the login may no
   * longer be filled on.
   */
  route.post("/:id/open", async (context) => {
    const self = context.get("member");
    const id = context.req.param("id");
    if (!ID_SHAPE.test(id)) return reply(context, notFound);
    const body = await readJson(context);
    if (!body) return reply(context, invalid("body"));
    let lease: string;
    try {
      lease = parseLease(body.lease);
    } catch (error) {
      if (error instanceof Invalid) return reply(context, invalid(error.field));
      throw error;
    }
    const now = clock();
    // Filled inside the transaction and read after its commit: the values are answered only once
    // the trail row saying they were opened is written.
    const result: { opened?: HubVaultOpened } = {};
    let answer: Reply;
    try {
      answer = await database.transaction(async (tx): Promise<Reply> => {
        const [login] = await tx
          .select({
            origins: hubVaultLogins.origins,
            wrappedKey: hubVaultLogins.wrappedKey,
            kekId: hubVaultLogins.kekId,
            sealedUsername: hubVaultLogins.sealedUsername,
            sealedPassword: hubVaultLogins.sealedPassword,
          })
          .from(hubVaultLogins)
          .where(eq(hubVaultLogins.id, id))
          // Shared, so opens do not wait on each other, but a change of the login's rules (`PUT`,
          // `PUT grants`, which take it for update) is either wholly before this open or wholly
          // after it: never a grant, an origin or a holder read from before a change that commits
          // while the lease is being spent.
          .for("share");
        if (!login) return notFound;
        if (!(await holdsGrant(tx, id, self.id))) return forbidden;
        const [spent] = await tx
          .update(hubVaultLeases)
          .set({ openedAt: now })
          .where(
            and(
              eq(hubVaultLeases.id, hashLease(lease)),
              eq(hubVaultLeases.loginId, id),
              eq(hubVaultLeases.memberId, self.id),
              gt(hubVaultLeases.until, now),
              isNull(hubVaultLeases.openedAt),
              inArray(hubVaultLeases.origin, login.origins),
            ),
          )
          .returning({
            runId: hubVaultLeases.runId,
            origin: hubVaultLeases.origin,
          });
        if (!spent) {
          await recordAudit(tx, {
            action: "vault.opened",
            member: self.id,
            vmOrigin: self.vmOrigin,
            target: id,
            outcome: "refused",
          });
          return leaseInvalid;
        }
        // Throws `LoginSealError` when the row does not open under this hub's key, which rolls the
        // spending of the lease back with it.
        const values = await openLogin(
          encodedKey as string,
          sealedFor(id),
          login,
        );
        await recordAudit(tx, {
          action: "vault.opened",
          member: self.id,
          vmOrigin: self.vmOrigin,
          target: id,
          runId: spent.runId,
          outcome: "ok",
          payload: { origin: spent.origin },
        });
        result.opened = { ok: true, ...values };
        return { status: 200, body: null };
      });
    } catch (error) {
      if (error instanceof LoginSealError) {
        // The login's id and the fact; the error carries no more than its code by construction.
        log.warn("vault_seal_unreadable", { login: id });
        return context.json(
          { ok: false, code: HUB_VAULT_FACTS.sealUnreadable },
          500,
        );
      }
      throw error;
    }
    if (answer.status !== 200 || !result.opened) return reply(context, answer);
    // Nothing between here and the member's VM may keep it: no cache, no proxy's copy.
    context.header("cache-control", "no-store");
    return context.json(result.opened);
  });

  /** The run is done with it. Answers `ok` for a lease already gone, so a retry is harmless. */
  route.post("/:id/release", async (context) => {
    const self = context.get("member");
    const id = context.req.param("id");
    if (!ID_SHAPE.test(id)) return reply(context, notFound);
    const body = await readJson(context);
    if (!body) return reply(context, invalid("body"));
    let lease: string;
    try {
      lease = parseLease(body.lease);
    } catch (error) {
      if (error instanceof Invalid) return reply(context, invalid(error.field));
      throw error;
    }
    await database
      .delete(hubVaultLeases)
      .where(
        and(
          eq(hubVaultLeases.id, hashLease(lease)),
          eq(hubVaultLeases.loginId, id),
          eq(hubVaultLeases.memberId, self.id),
        ),
      );
    return context.json({ ok: true });
  });

  /**
   * The caller's VM verified itself as a device on the login's site (a person answered the
   * site's new-device check). Counted in `verifiedVms`. `vm`, when sent, has to be the caller's.
   */
  route.post("/:id/verified", async (context) => {
    const self = context.get("member");
    const id = context.req.param("id");
    if (!ID_SHAPE.test(id)) return reply(context, notFound);
    const body = await readJson(context);
    if (!body) return reply(context, invalid("body"));
    if (
      body.vm !== undefined &&
      (!isString(body.vm) || canonicalOrigin(body.vm) !== self.vmOrigin)
    ) {
      return reply(context, invalid("vm"));
    }
    const vmOrigin = self.vmOrigin;
    if (!vmOrigin) return reply(context, forbidden);
    const now = clock();
    const answer = await database.transaction(async (tx): Promise<Reply> => {
      const [login] = await tx
        .select({ id: hubVaultLogins.id })
        .from(hubVaultLogins)
        .where(eq(hubVaultLogins.id, id));
      if (!login) return notFound;
      if (!(await holdsGrant(tx, id, self.id))) return forbidden;
      await tx
        .insert(hubVaultDevices)
        .values({ loginId: id, vmOrigin, verifiedBy: self.id, verifiedAt: now })
        .onConflictDoUpdate({
          target: [hubVaultDevices.loginId, hubVaultDevices.vmOrigin],
          set: { verifiedBy: self.id, verifiedAt: now },
        });
      await emitEvent(tx, { type: "vault.changed", refId: id, actor: self.id });
      await recordAudit(tx, {
        action: "vault.verified",
        member: self.id,
        vmOrigin,
        target: id,
        runId: runHeader(context),
        outcome: "ok",
      });
      return { status: 200, body: { ok: true } };
    });
    if (answer.status === 200) listeners.pokeAll();
    return reply(context, answer);
  });

  return route;
}
