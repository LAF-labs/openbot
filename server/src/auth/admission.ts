/**
 * Who this deployment still lets act — the one answer every path asks for, signed in or not.
 *
 * ONE ACCOUNT PER DEPLOYMENT (docs/laf/deployment-model.md, 2026-09-16). Every Bot on a deployment
 * opens the same browser profile, so a second person here would work inside the first person's
 * logins. The sign-in list (`allowlist.ts`) says which ADDRESS is admitted; this module turns that
 * into the three questions the rest of the server has to ask, so no caller answers one of them its
 * own way:
 *
 *   admitsPerson         a person known only by id. A routine firing at seven, a notification about
 *                        to go out: nobody is signed in to those, so the per-request check in the
 *                        guards never runs, and until 2026-09-16 nothing else did either — a person
 *                        struck off the list kept their routines running on the owner's browser and
 *                        kept receiving 알림톡 (audit R1-04, R2-F6).
 *   heldBySomebodyElse   whether the deployment already belongs to an account other than this one.
 *                        The sign-in hook refuses a new account when it does.
 *   keepArrival          the same question again, after better-auth has written the new row, taken
 *                        one arrival at a time — see below.
 *
 * A LEFTOVER IS NOBODY. A `users` row whose address the list no longer admits (a `laf member`
 * address since removed, the second account a rehearsal VM carried) acts on nothing, and so it does
 * not count as the deployment's account: it must not keep the admitted person out on their first
 * sign-in. Nothing here deletes one — the one row this module ever removes is the one described
 * under `keepArrival`.
 *
 * WITH THE DOOR OPEN — a laptop, where `config.ts` lets the list be unset — everybody is admitted,
 * as they always were, and ANY account here holds the deployment: a second person still cannot be
 * made. The local fixture (`dev-actor.ts`) is not a person and never holds it.
 */
import { and, eq, inArray, ne, type SQL, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import { log } from "../log";
import { normalizeAddress, type SignInAllowlist } from "./allowlist";
import { DEV_ACTOR } from "./dev-actor";

export type DeploymentAdmission = {
  /** Whether the list is a closed door. False only on a laptop with no list. */
  enforced: boolean;
  /** Whether this address may sign in and act here. */
  admits(email: string): boolean;
  /**
   * Whether the person with this id may still act here: their row exists and the list admits its
   * address. Always yes with the door open, and for the local fixture where it is switched on.
   */
  admitsPerson(userId: string): Promise<boolean>;
  /**
   * Whether an account the deployment still admits exists that is not this person — not this
   * address however it is spelled, and not `userId` when the row has one already.
   */
  heldBySomebodyElse(person: {
    email: string;
    userId?: string;
  }): Promise<boolean>;
  /**
   * Keep a freshly written account only if it is still the only one, and take the row back out if
   * it is not. False means it was taken out.
   */
  keepArrival(user: { id: string; email: string }): Promise<boolean>;
};

/** Every address is admitted and the door is open: a laptop with no sign-in, or no list. */
const OPEN_DOOR: SignInAllowlist = {
  enforced: false,
  addresses: [],
  admits: () => true,
};

export function createDeploymentAdmission(input: {
  /** A transaction will do: the reads and the one delete are all this needs. */
  database: Pick<Database, "select" | "delete">;
  /** The list this process booted with. Absent is an open door. */
  allowlist?: SignInAllowlist;
  /** `LAF_DEV_NO_AUTH`: the local fixture acts only where it is switched on. */
  devNoAuth?: boolean;
}): DeploymentAdmission {
  const { database } = input;
  const allowlist = input.allowlist ?? OPEN_DOOR;
  const admits = (email: string) =>
    allowlist.admits(typeof email === "string" ? email : "");

  /** The address as it is stored, in the spelling the list compares. */
  const storedAddress: SQL<string> = sql`lower(trim(${users.email}))`;

  const heldBySomebodyElse: DeploymentAdmission["heldBySomebodyElse"] = async ({
    email,
    userId,
  }) => {
    const self = normalizeAddress(email);
    const others = allowlist.enforced
      ? allowlist.addresses.filter((address) => address !== self)
      : null;
    // A closed door naming nobody else: nobody else can be here, and nothing needs reading.
    if (others?.length === 0) return false;
    const [somebody] = await database
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          ne(users.id, DEV_ACTOR.id),
          ...(userId ? [ne(users.id, userId)] : []),
          others ? inArray(storedAddress, others) : ne(storedAddress, self),
        ),
      )
      .limit(1);
    return Boolean(somebody);
  };

  /*
   * ONE ARRIVAL AT A TIME, IN THIS PROCESS — the race the sign-in hook's first look cannot close.
   *
   * better-auth asks `user.create.before`, writes the row, and only then runs `user.create.after`,
   * with no transaction this server can hold across the three. Two first sign-ins pressed at the
   * same moment each look, each find the deployment empty, and each write. So the look is taken
   * again after the write, one arrival after another: whoever settles while another admitted
   * account is already there takes its own row back out and is refused. Each look sees every row
   * written before it, and each arrival that stays has been seen by every look after it, so of any
   * number of racers exactly one is kept.
   *
   * In memory, and correct there: one API process per deployment (deployment-model.md). The row
   * taken out is the one this very sign-in wrote a moment ago — no session, no Bot, nothing anybody
   * has seen — and its provider link goes with it by cascade. That is a creation being undone, not
   * an account being deleted, and it is the only delete in this module.
   */
  let settling: Promise<unknown> = Promise.resolve();
  const keepArrival: DeploymentAdmission["keepArrival"] = (user) => {
    const settle = async () => {
      const taken = await heldBySomebodyElse({
        email: user.email,
        userId: user.id,
      });
      if (!taken) return true;
      await database.delete(users).where(eq(users.id, user.id));
      log.warn("sign_in_second_account_undone", { user: user.id });
      return false;
    };
    const settled = settling.then(settle);
    settling = settled.catch(() => undefined);
    return settled;
  };

  return {
    enforced: allowlist.enforced,
    admits,
    async admitsPerson(userId) {
      if (!allowlist.enforced) return true;
      if (input.devNoAuth && userId === DEV_ACTOR.id) return true;
      const [person] = await database
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return person ? admits(person.email) : false;
    },
    heldBySomebodyElse,
    keepArrival,
  };
}
