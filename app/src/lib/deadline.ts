/**
 * A wait a request is given up on after: the signal to hand the request, and the way to call the
 * wait off once it is over.
 *
 * NOT `AbortSignal.timeout`. The installed app comes first, and its window is a webview whose
 * engine is whatever the person's system ships (`desktop/`: macOS 12 and up). That call is newer
 * than some of them, and where it is missing it throws before the request is made. Read as "the
 * request failed", that is every read of the conversation's history failing for good, and an
 * answer typed to a card offered for ever and never sent (review, 2026-10-03). The connection
 * check keeps the same rule for the same reason (`lib/support/connection-check.ts`).
 */
export function deadline(ms: number): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
