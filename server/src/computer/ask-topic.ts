import type { AskSubject } from "./approvals";

/**
 * The topic of a question: what kind of action, and where — the site, or the connected service and
 * its tool. Never the element's label, a path or the arguments: those are the page's and the Bot's
 * words, and a topic leaves the VM for the whole company's board (`hub/task-pickup.ts`).
 *
 * In the boundary's folder because the boundary reads it too: an allowance a person gave for one
 * task on the board ("이 일감에서는 해도 돼") answers only for the topic they were shown, and the
 * settle step works the topic out of the action in front of it the same way the stop's note did
 * (`settle.ts`). One function, so the note and the allowance cannot name the same action two ways.
 */
export function topicOf(subject: unknown): string {
  const ask = subject as Partial<AskSubject> | null;
  if (!ask || typeof ask !== "object") return "action";
  const kind = typeof ask.kind === "string" ? ask.kind : "action";
  const intent = typeof ask.intent === "string" ? `/${ask.intent}` : "";
  const where =
    typeof ask.host === "string" && ask.host
      ? `@${ask.host}`
      : ask.tool && typeof ask.tool.server === "string"
        ? `@${ask.tool.server}/${ask.tool.name}`
        : "";
  return `${kind}${intent}${where}`.replace(/[^\p{L}\p{N}@/._:-]/gu, "");
}
