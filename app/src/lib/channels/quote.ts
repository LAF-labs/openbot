import { plainLine } from "@/components/computer/task-title";

/**
 * The composer's text for 인용해 답하기 under a Bot's answer: its first line as a quote, markdown
 * marks off, and a new line to answer on. Null for an answer with no words to quote.
 */
export function quotedReply(text: string): string | null {
  const first = plainLine(text);
  return first ? `> ${first}\n` : null;
}
