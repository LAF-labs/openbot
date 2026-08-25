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
 * This deployment is single-account until AUTH lands (M1-2), so the mapping is a constant: every
 * Bot resolves to the computer at `AGENT_COMPUTER_URL`. When accounts arrive, this module is where
 * a Bot's account starts deciding which computer answers.
 */

/**
 * Five, from the product decision above.
 *
 * Enforced where Bots are created rather than where computers are resolved: a sixth Bot must fail
 * to exist, not exist and fail to reach a computer.
 *
 * Read from the environment so a deployment can be given a different number without a build.
 *
 * It was also how the test suite stopped competing with real rows for the same five seats, and that
 * reason is gone: the seats were counted across the whole deployment, so a few Bots existing for
 * any other reason really did starve a test that made two of its own. They are counted per person
 * now — one VM each, see docs/laf/deployment-model.md — and a test that creates its own person
 * starts from nothing.
 */
export const MAX_BOTS_PER_COMPUTER = seatsPerAccount();

function seatsPerAccount(): number {
  const configured = Number.parseInt(
    process.env.BOT_SEATS_PER_ACCOUNT ?? "",
    10,
  );
  return Number.isFinite(configured) && configured > 0 ? configured : 5;
}
