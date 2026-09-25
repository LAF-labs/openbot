import type { Message } from "@ag-ui/core";

/**
 * What a transcript shows while a brand-new channel is still joining.
 *
 * Channel join replaces the agent's local messages with restored thread history. The first message
 * is held here as a seed until restored messages arrive, then ignored to avoid duplicate rendering.
 */
export function transcriptMessages(
  messages: readonly Message[],
  seed: Message | null,
): readonly Message[] {
  if (messages.length > 0 || seed === null) {
    return messages;
  }
  return [seed];
}

/** The person's message, in the shape the transcript and the agent both take. */
export function seedMessage(text: string, id: string): Message {
  return { id, role: "user", content: text };
}

/**
 * The message a channel was created by, waiting for the screen that will send it.
 *
 * A module-level map rather than router state because `HistoryState` is an empty interface and
 * typing a value into it means augmenting `@tanstack/history`, which is not a dependency of this
 * app. It also earns something router state would not give: it is forgotten once a conversation
 * that read it is on screen, so a component that mounts twice cannot send the same message twice.
 *
 * READ WHILE DRAWING, FORGOTTEN ONLY ONCE DRAWN. It used to be taken — read and deleted in one
 * call — inside the conversation's first render. A render React throws away does not keep what it
 * read, and React throws one away whenever something inside it fails: measured 2026-09-24, with the
 * browser banner failing on the new conversation's first draw, the banner's seam caught it, and the
 * render React drew again found nothing here — the first message somebody typed was never sent.
 *
 * Deliberately not persisted. A reload finds nothing here, which is correct, by then the message
 * is in the thread and arrives through the normal replay.
 */
const firstMessages = new Map<string, string>();

/**
 * The conversations on screen now, each ready to send a message handed to it.
 *
 * A stash is read only when a conversation MOUNTS, and starting a channel that already exists lands
 * on that same channel. So a first message for the conversation already on screen — the sidebar's
 * 오늘 chips on an empty one — was stashed, navigated to the page it was on, and never read: nothing
 * mounted. The chip then put its sentence in the composer instead, which on a fresh account it sent.
 * Measured 2026-09-25. A conversation on screen now takes it as it is stashed, and sends it.
 */
const listening = new Map<string, (text: string) => void>();

export function stashFirstMessage(channelId: string, text: string): void {
  const send = listening.get(channelId);
  if (send) {
    send(text);
    return;
  }
  firstMessages.set(channelId, text);
}

/** While a conversation is on screen, a first message stashed for it is sent by it. */
export function hearFirstMessages(
  channelId: string,
  send: (text: string) => void,
): () => void {
  listening.set(channelId, send);
  return () => {
    if (listening.get(channelId) === send) listening.delete(channelId);
  };
}

/** The pending first message, left in place. Null for a channel opened any other way. */
export function peekFirstMessage(channelId: string): string | null {
  return firstMessages.get(channelId) ?? null;
}

/** Forget the first message: called once the conversation that read it has been drawn. */
export function forgetFirstMessage(channelId: string): void {
  firstMessages.delete(channelId);
}
