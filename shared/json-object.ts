/**
 * JSON text as an object, or null for anything else: broken JSON, an array, a bare string or number.
 *
 * Written once here because it had been written six times — tool arguments in agent-bot, the server's
 * unattended runner, secret redaction and compaction, a model's reply in `model-call.ts`, and a
 * browsing card's arguments in the app — each the same `try`/`JSON.parse`/`typeof` block with its own
 * idea of what "not an object" should become. That idea still belongs to each caller, which is why
 * this answers null and nothing else: a caller that wants `{}` says `?? {}` where it can be read, and
 * a caller whose empty string means "no arguments" says so before it asks.
 */
export function jsonObjectOf(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Not JSON is one of the answers this function exists to give, not a failure to report.
    return null;
  }
}
