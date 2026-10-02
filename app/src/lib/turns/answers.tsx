/**
 * A card the Bot put on screen to ask the person something, answered to the turn the server owns.
 *
 * A decision card (`components/gallery/decisions.tsx`) is handed a `respond` only while CopilotKit
 * is carrying its call out in this window — which, with the turn on the server, it never is. The
 * server waits for the answer instead (`server/src/turns/people.ts`) and says which cards it is
 * waiting on; this hands those cards a `respond` that goes to it, from whichever window the person
 * presses it in.
 */
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
} from "react";

export type ServerAnswers = {
  /** The cards the turn is waiting on, by tool call. */
  waiting: ReadonlySet<string>;
  answer: (toolCallId: string, value: unknown) => Promise<void>;
  /**
   * Words typed as a card's answer and on their way to it, or taken by the server and not yet on
   * the conversation, by tool call (`lib/turns/typed-answer.ts`).
   */
  inWords?: ReadonlyMap<string, string>;
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

/**
 * The words on their way to this card as its answer, where there are any.
 *
 * THE CARD SAYS THEM, BECAUSE NOTHING ELSE DOES. Typed under a card they leave the composer, and
 * they are not a message waiting for the turn; until the conversation showed them as the card's
 * answer they were drawn nowhere at all. That is a blink while the server is quick. It is minutes
 * where a routine took the Bot while the question waited: the answer is taken at once and filed
 * only when the Bot is free again (`awaitPerson` in `server/src/turns/engine.ts`), and for all of
 * that the person looked at a card with nothing on it and an empty box.
 */
export function useAnswerOnItsWay(
  toolCallId: string | undefined,
): string | undefined {
  const answers = useContext(Answers);
  return toolCallId ? answers?.inWords?.get(toolCallId) : undefined;
}

/**
 * A decision card, answerable wherever its call is waiting: in this window while CopilotKit carries
 * the call out here, or on the server while a turn the server owns waits for it there — which
 * hands the card the `respond` CopilotKit never will. And where the person's own words are on
 * their way to it, the card shows them and takes no press meanwhile (`useAnswerOnItsWay`).
 *
 * Here rather than beside the gallery (`lib/copilot/gallery-tools.tsx`), which is found through
 * Vite and cannot be drawn under `bun test`: what a card is handed is tested by drawing this.
 */
export function DecisionCard({
  Component,
  props,
}: {
  Component: (props: Record<string, unknown>) => ReactElement | null;
  props: Record<string, unknown>;
}) {
  const toolCallId =
    typeof props.toolCallId === "string" ? props.toolCallId : undefined;
  const serverRespond = useServerRespond(toolCallId);
  const onItsWay = useAnswerOnItsWay(toolCallId);
  if (props.status === "complete") return <Component {...props} />;
  if (onItsWay !== undefined) {
    return (
      <Component
        {...props}
        answering={onItsWay}
        respond={undefined}
        status="executing"
      />
    );
  }
  const shown = serverRespond
    ? { ...props, status: "executing", respond: serverRespond }
    : props;
  return <Component {...shown} />;
}

/**
 * Whether this conversation's turns are the server's (inside `ServerChannelChat`). What a card asks
 * before telling the server anything: in a conversation the window drives there is nobody there to
 * tell, and the door does not exist (review L8).
 */
export function useServerOwnsTurn(): boolean {
  return useContext(Answers) !== null;
}
