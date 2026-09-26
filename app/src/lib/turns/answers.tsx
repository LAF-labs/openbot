/**
 * A card the Bot put on screen to ask the person something, answered to the turn the server owns.
 *
 * A decision card (`components/gallery/decisions.tsx`) is handed a `respond` only while CopilotKit
 * is carrying its call out in this window — which, with the turn on the server, it never is. The
 * server waits for the answer instead (`server/src/turns/people.ts`) and says which cards it is
 * waiting on; this hands those cards a `respond` that goes to it, from whichever window the person
 * presses it in.
 */
import { createContext, type ReactNode, useContext } from "react";

export type ServerAnswers = {
  /** The cards the turn is waiting on, by tool call. */
  waiting: ReadonlySet<string>;
  answer: (toolCallId: string, value: unknown) => Promise<void>;
};

const Answers = createContext<ServerAnswers | null>(null);

export function ServerAnswersProvider({
  value,
  children,
}: {
  value: ServerAnswers;
  children: ReactNode;
}) {
  return <Answers.Provider value={value}>{children}</Answers.Provider>;
}

/**
 * The `respond` for this card when a server-owned turn is waiting on it, and undefined otherwise —
 * in a conversation the window drives, and once the card has its answer.
 */
export function useServerRespond(
  toolCallId: string | undefined,
): ((value: unknown) => Promise<void>) | undefined {
  const answers = useContext(Answers);
  if (!answers || !toolCallId || !answers.waiting.has(toolCallId)) {
    return undefined;
  }
  return (value: unknown) => answers.answer(toolCallId, value);
}
