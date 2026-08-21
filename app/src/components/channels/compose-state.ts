/**
 * The rules a compose screen follows before there is a channel to hold them.
 *
 * Pure helpers so recipient-cap and sendability behavior stay testable without rendering.
 */

export type Recipient = {
  id: string;
  name: string;
};

/**
 * How many Bots one room can hold.
 *
 * It was 1, matching a chat screen that refused to render anything else. That screen renders a room
 * now, so the cap is a product decision rather than a technical one: a handful of colleagues is a
 * meeting, and a list of twenty is a mailing list nobody reads. Eight is generous for the first
 * and short of the second.
 */
export const MAX_RECIPIENTS = 8;

/** Add a coworker, replacing the oldest once the channel recipient cap is reached. */
export function addRecipient(
  current: readonly Recipient[],
  next: Recipient,
): Recipient[] {
  if (current.some((recipient) => recipient.id === next.id)) {
    return [...current];
  }
  return [...current, next].slice(-MAX_RECIPIENTS);
}

export function removeRecipient(
  current: readonly Recipient[],
  id: string,
): Recipient[] {
  return current.filter((recipient) => recipient.id !== id);
}

/**
 * Whether this draft can start a channel: at least one coworker, and something to say.
 *
 * `>= 1`, not `=== MAX_RECIPIENTS`. Those were the same test while the cap was one, and raising it
 * would have quietly made the composer refuse every draft until eight Bots were picked.
 */
export function canSend(
  recipients: readonly Recipient[],
  text: string,
): boolean {
  return recipients.length >= 1 && text.trim().length > 0;
}
