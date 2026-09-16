/**
 * Who may sign in at all.
 *
 * A deployment belongs to one account (docs/laf/deployment-model.md, 2026-09-16: "1계정 1VM을
 * 코드로 강제한다"). This is the address half of that lock; `auth/admission.ts` is the half that
 * asks the database, and `config.ts` is where a production deployment is refused for not naming
 * exactly one address.
 *
 * Semantics, chosen for the failure modes:
 *
 * - ON A PRODUCTION DEPLOYMENT THE LIST IS ALWAYS A DOOR. `config.ts` refuses to start unless the two
 *   lines name exactly one address together, and says the door is closed (`allowlistEnforced`) even
 *   when that address is written only as the administrator — so a VM whose `.env` lost its
 *   `SIGN_IN_ALLOWED_EMAILS` line no longer admits anybody the provider authenticates (audit
 *   2026-09-16 R9-04).
 * - Outside production, unset means open. A laptop and the test suites are not somebody's shop, and
 *   an empty new variable must not lock a developer out of their own machine; the boot says so out
 *   loud instead. There the allow variable alone arms the lock, as it always did.
 * - The admin list is always admitted. The lockout nobody can undo is the administrator listing
 *   everyone but themselves — recovering from it means editing the VM's .env over SSH, so it is
 *   cheaper to make the mistake impossible than to document the recovery.
 * - Matching is case-insensitive on the whole address and nothing more. No dot-folding, no
 *   plus-stripping: those are Gmail conventions, not address semantics, and a lock that admits
 *   addresses it was never given is a worse surprise than one that wants the exact spelling.
 */

/** The one spelling addresses are compared in — here, at boot, and against the database. */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Every address the two sign-in lines admit between them, each once.
 *
 * `config.ts` counts these to decide whether a production deployment names exactly one account, so
 * the fleet writing the owner on both lines (`INITIAL_ADMIN_EMAILS` and `SIGN_IN_ALLOWED_EMAILS`) is
 * one address, not two.
 */
export function admittedAddresses(options: {
  allowedEmails: readonly string[];
  initialAdminEmails: readonly string[];
}): string[] {
  return [
    ...new Set(
      [...options.allowedEmails, ...options.initialAdminEmails]
        .map(normalizeAddress)
        .filter((address) => address.length > 0),
    ),
  ];
}

export type SignInAllowlist = {
  /** Whether the list is a door at all. False only outside production, with no allow variable. */
  enforced: boolean;
  /** What it admits, normalised. Read only when `enforced`; an open door admits everybody. */
  addresses: readonly string[];
  admits(email: string): boolean;
};

export function createSignInAllowlist(options: {
  allowedEmails: string[];
  initialAdminEmails: string[];
  /**
   * Whether the list closes the door, as `config.ts` decided it for this deployment — always true
   * in production. Absent, for a caller that assembled the lists itself, the allow variable alone
   * arms it: admin emails predate the lock, and arming on them outside production would have
   * turned every laptop exclusive.
   */
  allowlistEnforced?: boolean;
}): SignInAllowlist {
  const addresses = admittedAddresses(options);
  const enforced =
    options.allowlistEnforced ??
    options.allowedEmails.some((address) => address.trim().length > 0);
  const admitted = new Set(addresses);
  return {
    enforced,
    addresses,
    admits(email: string): boolean {
      if (!enforced) return true;
      return admitted.has(normalizeAddress(email));
    },
  };
}
