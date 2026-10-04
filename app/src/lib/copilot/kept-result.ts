/**
 * A call's result as the conversation keeps it, as the text the Bot was told.
 *
 * What a renderer is handed is the stored string. A sentence is stored as it is by a turn the
 * server carried out; a conversation from before 2026-10-05 may hold one a window's runtime wrote,
 * which quoted a string once as JSON. Either way this is the sentence; an object stays the JSON it
 * is, and nothing kept is the empty string.
 */
export function keptText(result: string | undefined): string {
  if (!result) return "";
  if (!result.startsWith('"')) return result;
  try {
    const parsed: unknown = JSON.parse(result);
    return typeof parsed === "string" ? parsed : result;
  } catch {
    return result;
  }
}
