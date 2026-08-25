/**
 * Who may sign in at all.
 *
 * One VM belongs to one person (docs/laf/deployment-model.md), and until now nothing enforced
 * that: the only thing keeping a second account out was the OAuth consent screen still being in
 * test mode — a Google console setting, not a property of this deployment. This is the lock.
 *
 * Semantics, chosen for the failure modes:
 *
 * - Unset means open. That is the behavior every existing deployment and local setup has today;
 *   an empty new variable must not lock anybody out of anything. The deployment closes the door
 *   by setting it, and `.env.example` says so where the variable is introduced.
 * - The admin list is always admitted. The lockout nobody can undo is the administrator listing
 *   everyone but themselves — recovering from it means editing the VM's .env over SSH, so it is
 *   cheaper to make the mistake impossible than to document the recovery.
 * - Matching is case-insensitive on the whole address and nothing more. No dot-folding, no
 *   plus-stripping: those are Gmail conventions, not address semantics, and a lock that admits
 *   addresses it was never given is a worse surprise than one that wants the exact spelling.
 */
export function createSignInAllowlist(options: {
  allowedEmails: string[];
  initialAdminEmails: string[];
}): { enforced: boolean; admits(email: string): boolean } {
  const normalize = (address: string) => address.trim().toLowerCase();
  const admitted = new Set(
    [...options.allowedEmails, ...options.initialAdminEmails]
      .map(normalize)
      .filter((address) => address.length > 0),
  );
  // Only the allow variable arms the lock. Admin emails alone must not: they predate this lock,
  // and arming on them would have turned every existing deployment exclusive on upgrade.
  const enforced = options.allowedEmails.some(
    (address) => address.trim().length > 0,
  );
  return {
    enforced,
    admits(email: string): boolean {
      if (!enforced) return true;
      return admitted.has(normalize(email));
    },
  };
}
