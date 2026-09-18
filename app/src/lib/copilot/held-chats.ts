/**
 * The conversations this window is running a turn in, each with the Stop its own button presses.
 *
 * `모두 멈추기` lives in the sidebar, outside the CopilotKit provider each conversation screen mounts
 * for itself, so it cannot reach a conversation's agent — the conversation hands its Stop over
 * instead, for as long as it is mounted. Module state because there is one of these per window, and
 * the conversation that holds a turn is whichever one is on screen.
 *
 * WHY THE SERVER'S STOP IS NOT ENOUGH ON ITS OWN. The server stops a run on the wire and refuses to
 * carry on a step a browser was doing (`server/src/runner/laf-runner.ts`), but it lets that step
 * finish: it cannot reach into a browser. The window that holds the turn can — its Stop aborts the
 * step itself, a click still on its way included — and it also covers the second and a half before
 * a turn's first run exists, which nothing on the server can see yet.
 */
export type HeldChat = {
  threadId: string;
  /** A turn is in flight: from the send until the whole answer is back, browser steps included. */
  busy: () => boolean;
  /** Stop the turn the way the conversation's own Stop does. */
  stop: () => void;
};

const held = new Set<HeldChat>();

/** Hold a conversation while it is mounted. The function handed back lets go of it. */
export function holdChat(chat: HeldChat): () => void {
  held.add(chat);
  return () => {
    held.delete(chat);
  };
}

/** The conversations with a turn in flight right now, by thread. */
export function busyHeldChats(): string[] {
  return [...held].filter((chat) => chat.busy()).map((chat) => chat.threadId);
}

/**
 * Stop every conversation this window holds that has a turn in flight, and say which were stopped
 * and which could not be.
 *
 * One conversation's Stop throwing — an agent torn down mid-unmount — must not leave the next one
 * running, so each is asked on its own, and the one that threw is reported as not stopped rather
 * than quietly dropped from the count.
 */
export function stopHeldChats(): { stopped: string[]; notStopped: string[] } {
  const stopped: string[] = [];
  const notStopped: string[] = [];
  for (const chat of held) {
    if (!chat.busy()) continue;
    try {
      chat.stop();
      stopped.push(chat.threadId);
    } catch {
      notStopped.push(chat.threadId);
    }
  }
  return { stopped, notStopped };
}
