/**
 * Whose computer a Bot drives, and how many Bots one person has.
 *
 * The product decision (2026-08-20): an account gets one virtual computer, and what stays per-Bot
 * is governance — policy identity, approvals, repetition counts, credentials, and the audit trail
 * all keyed on the Bot, exactly as the gateway already keys them. The computer is the account's
 * desk; the Bot is who sits at it.
 *
 * Upstream's supervisor hands out one container per Bot, which prices a roster linearly and gives
 * Bots nothing to share. Ours resolves every Bot of an account to the account's one container, so
 * the cost of an account is one computer.
 *
 * This deployment is single-account (docs/laf/deployment-model.md), so the mapping is a constant:
 * every Bot resolves to the computer at `AGENT_COMPUTER_URL`.
 */

/**
 * ONE. The owner's decision of 2026-09-24 — "봇 1개로 하자" — see docs/laf/deployment-model.md,
 * "봇은 하나다".
 *
 * It was five from 2026-08-20 and a deployment could raise it through `BOT_SEATS_PER_ACCOUNT`. The
 * variable is gone rather than defaulted to one: nothing on the surface can make or show a second
 * Bot any more, so a deployment that set five would have had a number the API honoured and no
 * screen could reach — a control that saves and does nothing.
 *
 * Enforced where Bots are created (`reserveSeat` in `agents/profile-store.ts`) rather than where
 * computers are resolved: a second Bot must fail to exist, not exist and fail to reach a computer.
 * An account that already had several before this keeps them all; the count only stops creation.
 */
export const BOTS_PER_ACCOUNT = 1;
