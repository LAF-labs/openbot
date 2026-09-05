import { t } from "@/lib/i18n";

/**
 * How a stalled turn reads on the audit page.
 *
 * The row for a Bot that stopped talking carries two numbers nothing else in the trail carries: how
 * long its stream had been quiet when the deployment gave up on it, and how much it had managed to
 * say first. They are the whole reason that row exists. An endpoint that dies halfway through an
 * answer and one that accepts a connection and never writes are different faults with different
 * fixes, and on the page they are the same line unless these two are drawn.
 *
 * Chunks, not events, because that is what was counted: one chunk can carry several AG-UI events and
 * the boundaries are the network's. Saying "events" here would be a number that looks precise and is
 * not. What a reader needs from it is whether it is zero, and that it says plainly.
 *
 * Returns null rather than a placeholder when the payload does not carry both. An older row written
 * before this was recorded should show nothing, not "0 chunks", which would be a claim about a Bot
 * that nobody ever measured.
 */
export function silenceOf(payload: Record<string, unknown>): string | null {
  const silentForMs = payload.silentForMs;
  const chunks = payload.chunks;
  if (typeof silentForMs !== "number" || typeof chunks !== "number") {
    return null;
  }

  const seconds = Math.max(1, Math.round(silentForMs / 1000));
  if (chunks === 0) {
    return t("Silent for {seconds}s, having said nothing at all", { seconds });
  }
  /*
   * Three whole sentences rather than a stem and a tail glued together.
   *
   * This was built as `${quiet}, after ${n} chunk(s)` and had no `t()` anywhere in it, so a Korean
   * reader got an English line in the middle of the trail — invisible to `i18n-coverage.test.ts`,
   * which walks calls with a quoted key and finds nothing to complain about in a template literal.
   * Korean does not inflect the noun for the count either, so the singular and plural are one
   * sentence there and two here; composing them from parts would have made both wrong.
   */
  return chunks === 1
    ? t("Silent for {seconds}s, after 1 chunk", { seconds })
    : t("Silent for {seconds}s, after {chunks} chunks", { seconds, chunks });
}
