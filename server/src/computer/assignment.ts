/**
 * Whose computer a Bot drives, and how many Bots may share it.
 *
 * The product decision (2026-08-20): an account gets one virtual computer, up to five Bots share
 * it, and what stays per-Bot is governance — policy identity, approvals, repetition counts,
 * credentials, and the audit trail all keyed on the Bot, exactly as the gateway already keys them.
 * The computer is the account's desk; the Bots are the people sitting at it.
 *
 * Upstream's supervisor hands out one container per Bot, which prices a roster linearly and gives
 * Bots nothing to share. Ours resolves every Bot of an account to the account's one container, so
 * a login one Bot performed is there when the next Bot needs it — the point of the desk — and the
 * cost of an account is one computer, whatever its roster looks like.
 *
 * This deployment is single-account until AUTH lands (M1-2), so the mapping is a constant. When
 * accounts arrive this function takes the Bot's account instead; it is the only place that decides,
 * which is why it exists as a module rather than as an inline lambda in index.ts.
 */

/**
 * Five, from the product decision above.
 *
 * Enforced where Bots are created rather than where computers are resolved: a sixth Bot must fail
 * to exist, not exist and fail to reach a computer.
 *
 * Read from the environment so a deployment can be given a different number without a build, and so
 * the test suite can stop competing with real rows for the same five seats: integration tests write
 * to a real database, and once four Bots existed in it, tests that create two of their own began
 * failing with a roster-full error that had nothing to do with what they were testing.
 */
export const MAX_BOTS_PER_COMPUTER = seatsPerAccount();

function seatsPerAccount(): number {
  const configured = Number.parseInt(
    process.env.BOT_SEATS_PER_ACCOUNT ?? "",
    10,
  );
  return Number.isFinite(configured) && configured > 0 ? configured : 5;
}

/** The supervisor key for the one account this deployment serves. */
const SINGLE_ACCOUNT_COMPUTER = "account-default";

/** The supervisor key of the computer this Bot drives: its account's, never its own. */
export function accountComputerKey(_botId: string): string {
  return SINGLE_ACCOUNT_COMPUTER;
}
