import { useSyncExternalStore } from "react";

/**
 * WHAT THE BOT'S BROWSER IS DOING NOW, FOR THE PARTS OF THE SCREEN THAT ARE NOT THE CONVERSATION.
 *
 * The conversation knows: its last item is a browsing task while a turn runs (`openBrowsingTask`).
 * The header's "in use" mark and the live view are drawn outside it, so the conversation publishes
 * the fact here and they read it.
 *
 * THIS REPLACES AN AUTO-OPEN. The module before it counted "runs" of browser calls — any two within
 * ten seconds were one — and opened the Bot's screen once per run. A model that thinks for eleven
 * seconds between steps started a new run at every step, so a person who closed the screen had it
 * opened again at the next one: the complaint that it could not be closed. Nothing here opens
 * anything. It says what is happening, and a person decides whether to look.
 */

/** The task the Bot is on, as the banner says it. */
export type OpenTask = {
  botId: string;
  /** The first call's id: the task's identity, the same as its card's. */
  taskId: string;
  sites: readonly string[];
  /** What it is doing right now, already in the person's words (`doingNow`). */
  doing: string;
  /**
   * The step a question is open on, while the Bot waits for the owner's answer. The banner said
   * "누르는 중" through the whole wait (UX review 0.5.4, item 13): the click was the last call, and
   * it had not happened — it was waiting on a person.
   */
  askingOn?: string;
  /** The conversation the task is in, so the banner can take the owner to the question's card. */
  channelId?: string;
};

export type BrowsingNow = {
  task: OpenTask | null;
  /**
   * The browser was in use a moment ago.
   *
   * Held for `LINGER_MS` after a task ends, so the header's mark does not blink off and on between
   * the last step and the sentence the Bot writes about it — or between two tasks a breath apart.
   */
  isLingering: boolean;
  /** Tasks whose banner the person put away. Per tab, and only for that task. */
  dismissed: ReadonlySet<string>;
  /**
   * The Bot this tab last saw with no page open, found when the live view looked and closed.
   *
   * The newest task card reads it to say there is nothing live to open, rather than offer a view
   * that would open and close again. Cleared when the Bot starts a task, which opens a page.
   */
  pageGoneFor: string | null;
};

export const LINGER_MS = 2_500;

const EMPTY: ReadonlySet<string> = new Set();

let state: BrowsingNow = {
  task: null,
  isLingering: false,
  dismissed: EMPTY,
  pageGoneFor: null,
};
let lingerTimer: ReturnType<typeof setTimeout> | undefined;
const watchers = new Set<() => void>();

function set(next: BrowsingNow): void {
  state = next;
  for (const watcher of watchers) watcher();
}

function sameTask(left: OpenTask | null, right: OpenTask | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.botId === right.botId &&
    left.taskId === right.taskId &&
    left.doing === right.doing &&
    left.askingOn === right.askingOn &&
    left.channelId === right.channelId &&
    left.sites.join("\n") === right.sites.join("\n")
  );
}

/** Called by the conversation on every change it sees. The same task twice is not a change. */
export function publishOpenTask(task: OpenTask | null): void {
  if (sameTask(state.task, task)) return;
  clearTimeout(lingerTimer);
  lingerTimer = undefined;
  if (task) {
    set({
      ...state,
      task,
      isLingering: false,
      pageGoneFor: state.pageGoneFor === task.botId ? null : state.pageGoneFor,
    });
    return;
  }
  set({ ...state, task: null, isLingering: true });
  lingerTimer = setTimeout(() => {
    lingerTimer = undefined;
    set({ ...state, isLingering: false });
  }, LINGER_MS);
}

/** The banner, put away for this task. The next task has a banner of its own. */
export function dismissTask(taskId: string): void {
  if (state.dismissed.has(taskId)) return;
  set({ ...state, dismissed: new Set([...state.dismissed, taskId]) });
}

/** The live view looked and found no page. */
export function markPageGone(botId: string): void {
  if (state.pageGoneFor === botId) return;
  set({ ...state, pageGoneFor: botId });
}

/** Test seam: back to a tab that has seen nothing. */
export function forgetBrowsingNow(): void {
  clearTimeout(lingerTimer);
  lingerTimer = undefined;
  set({ task: null, isLingering: false, dismissed: EMPTY, pageGoneFor: null });
}

export function readBrowsingNow(): BrowsingNow {
  return state;
}

function subscribe(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => {
    watchers.delete(onChange);
  };
}

export function useBrowsingNow(): BrowsingNow {
  return useSyncExternalStore(subscribe, readBrowsingNow, readBrowsingNow);
}

/** Whether this Bot's browser is in use, or was a moment ago. */
export function isInUse(now: BrowsingNow, botId: string | undefined): boolean {
  if (!botId) return false;
  if (now.task) return now.task.botId === botId;
  return now.isLingering;
}
