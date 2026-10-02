import type { AttachmentPart } from "@shared/attachments";
import { useSyncExternalStore } from "react";

/**
 * WHAT WAS TYPED AND NEVER REACHED THE SERVER, KEPT ON THIS DEVICE UNTIL IT DOES.
 *
 * MEASURED ON 2026-09-24 (UI/UX audit, item 6): with the server down, "오늘 마감 체크리스트 써 줘"
 * was sent, got "서버에 닿지 못했습니다 [다시 시도]", and was still not sent when the server came
 * back. A reload then took it off the screen without a trace. The person had seen it land and walked
 * away believing it was on its way.
 *
 * The server keeps a person's words the moment a run begins, so the one message it can lose is the
 * one whose run never reached it. That one is kept here — per conversation, in `localStorage` — and
 * drawn in the conversation as not sent, with a way to send it again, until the server has it. When
 * the connection comes back it is sent once by itself (`ChannelChat`), under the same id, which the
 * server's store treats as that one message however many times it arrives.
 *
 * AND WHAT WAS TYPED WHILE THE BOT WORKED, WHERE THE SERVER OWNS THE TURN (`waiting`, below). It used
 * to be a rule that a queued message is never here: the queue (`queue.ts`) was React state in one
 * mount, on the reasoning that words waiting for a turn mean nothing once the window that drove the
 * turn is gone. With the turn on the server that reasoning is gone too — reloading, or closing the
 * laptop, is what a server-owned turn is for — and the correction somebody had watched land was
 * lost by it, with nothing saying so (review, 2026-10-02). So there it is kept here, marked as
 * waiting for the Bot, and the send that already takes what this device kept takes it when the turn
 * is over. One outbox; the window-driven conversation (`ChannelChat`) still queues in its mount.
 *
 * Only the words and the skill instructions that went in front of them — what the person typed and
 * the instructions they asked for, nothing the Bot or the server said.
 */
export type UnsentMessage = {
  /** The id the message was sent under, and will be sent under again. */
  id: string;
  text: string;
  /** The skill instructions that went in front of it, so a resend asks the same thing. */
  instructions: string[];
  /** ISO-8601, when it was first sent. */
  at: string;
  /** It has been sent once by itself already. The next try is the person's. */
  autoTried: boolean;
  /**
   * The files it carried, as references. The files themselves are already on the server — they were
   * sent up when they were picked — so what is kept here is only what to send again.
   */
  attachments?: AttachmentPart[];
  /**
   * Typed while the Bot had the turn: it has not failed to leave, it has not been sent yet, and it
   * goes when the turn is over. Never written as `false` — a message that only failed to leave is
   * stored exactly as it was before this existed.
   *
   * It stays on the message while its first send is out (claimed, so `autoTried`), which is how the
   * transcript tells words on their way for the first time from words being sent AGAIN; a send
   * that fails takes it off, and from then it is an unsent message like any other.
   */
  waiting?: true;
};

/**
 * Whether a kept message is waiting for the Bot: parked, and not yet taken by the one send it gets
 * by itself. Drawn as waiting, never as "not sent" — nothing has gone wrong with it.
 */
export function isWaitingForBot(message: UnsentMessage): boolean {
  return message.waiting === true && !message.autoTried;
}

const KEY_PREFIX = "laf:unsent:";
const EMPTY: readonly UnsentMessage[] = Object.freeze([]);

/** Per conversation, read once and then kept in step with every write — this tab's and others'. */
const cache = new Map<string, readonly UnsentMessage[]>();
const watchers = new Set<() => void>();
/**
 * Sent again by itself in this tab: the line under it says so, until the tab is gone. Replaced
 * rather than added to, so a subscriber sees a new set when it changes.
 */
let resent: ReadonlySet<string> = new Set<string>();

function isUnsent(value: unknown): value is UnsentMessage {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.text === "string" &&
    typeof entry.at === "string" &&
    Array.isArray(entry.instructions) &&
    entry.instructions.every((line) => typeof line === "string")
  );
}

/**
 * Storage can be missing, full or refused (a private window, blocked site data). Every read and
 * write goes through these two, and a failure is the same as nothing kept — which is what there
 * was before any of this.
 */
function load(channelId: string): readonly UnsentMessage[] {
  try {
    const raw = globalThis.localStorage?.getItem(`${KEY_PREFIX}${channelId}`);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(isUnsent).map(({ waiting, ...entry }) => ({
          ...entry,
          autoTried: entry.autoTried === true,
          // Read as strictly as it is written: anything but `true` is no mark at all.
          ...(waiting === true ? { waiting } : {}),
        }))
      : EMPTY;
  } catch {
    return EMPTY;
  }
}

/**
 * The conversations whose last write storage did not take: what this tab holds of them is all
 * there is, and storage — empty, or behind — is not to be believed over it.
 */
const unstored = new Set<string>();

function save(channelId: string, entries: readonly UnsentMessage[]): void {
  cache.set(channelId, entries.length ? entries : EMPTY);
  try {
    const storage = globalThis.localStorage;
    if (!storage) throw new Error("no storage");
    const key = `${KEY_PREFIX}${channelId}`;
    if (entries.length) {
      storage.setItem(key, JSON.stringify(entries));
    } else {
      storage.removeItem(key);
    }
    unstored.delete(channelId);
  } catch {
    // Kept for this tab only, then. Still on screen, still sent again when the connection returns.
    unstored.add(channelId);
  }
  for (const watcher of watchers) watcher();
}

/** What this conversation has that the server does not, in the order it was typed. */
export function readUnsent(channelId: string): readonly UnsentMessage[] {
  let entries = cache.get(channelId);
  if (!entries) {
    entries = load(channelId);
    cache.set(channelId, entries);
  }
  return entries;
}

/**
 * Keep a message that did not reach the server, or one waiting for the Bot. The same id again
 * replaces it in place.
 *
 * A NEW ONE GOES WHERE IT WAS TYPED, NOT LAST. A message is kept only once its send has failed, and
 * a correction typed while that send was still out is kept at once — so the correction was in the
 * list first, and everything kept went with the correction ahead of the sentence it corrects
 * (measured in `queued-message-kept.test.tsx`). `at` is when each was typed.
 */
export function keepUnsent(
  channelId: string,
  message: Omit<UnsentMessage, "autoTried"> & { autoTried?: boolean },
): void {
  const entries = readUnsent(channelId);
  const kept: UnsentMessage = {
    ...message,
    autoTried: message.autoTried ?? false,
  };
  const at = entries.findIndex((entry) => entry.id === message.id);
  if (at !== -1) {
    save(
      channelId,
      entries.map((entry, index) =>
        index === at
          ? { ...kept, autoTried: entry.autoTried || kept.autoTried }
          : entry,
      ),
    );
    return;
  }
  // ISO-8601 from one clock sorts as text. Behind everything typed at or before it.
  const later = entries.findIndex((entry) => entry.at > kept.at);
  save(
    channelId,
    later === -1
      ? [...entries, kept]
      : [...entries.slice(0, later), kept, ...entries.slice(later)],
  );
}

/** The server has these now: forget them. Ids this conversation never kept are ignored. */
export function forgetUnsent(channelId: string, ids: Iterable<string>): void {
  const gone = new Set(ids);
  const entries = readUnsent(channelId);
  const left = entries.filter((entry) => !gone.has(entry.id));
  if (left.length !== entries.length) save(channelId, left);
}

/**
 * Take the one automatic send for these, if nobody has: marks them tried and hands back the ones
 * this call claimed. A second tab asking a moment later is handed nothing.
 *
 * Read from storage rather than the cache, because the tab that got there first wrote it there.
 *
 * What was waiting for the Bot is claimed the same way, in the order it was typed: two tabs of one
 * conversation both hear the turn end, and the correction goes once. For those this is their first
 * send, not a second, and they keep their mark until it is answered (`UnsentMessage.waiting`).
 *
 * FROM THIS TAB WHERE STORAGE TOOK NOTHING. Storage that refuses the write reads back empty, and
 * the claim believed it: nothing to send, and the tab's own copy thrown away with it. That cost
 * a message its one send by itself; once what somebody queues goes through here, it would cost a
 * correction its only one — on a device with site data blocked the queue would have stopped
 * working at all (measured in `queued-message-kept.test.tsx`). No other tab can hold what storage
 * never had, so there is nobody to race.
 */
export function claimAutoSend(channelId: string): UnsentMessage[] {
  const entries = unstored.has(channelId)
    ? readUnsent(channelId)
    : load(channelId);
  const claimed = entries.filter((entry) => !entry.autoTried);
  if (claimed.length === 0) {
    cache.set(channelId, entries);
    return [];
  }
  save(
    channelId,
    entries.map((entry) => ({ ...entry, autoTried: true })),
  );
  return claimed;
}

/** Sent again by itself: said under the message in this tab. */
export function noteResent(ids: Iterable<string>): void {
  resent = new Set([...resent, ...ids]);
  for (const watcher of watchers) watcher();
}

function subscribe(onChange: () => void): () => void {
  watchers.add(onChange);
  /*
   * Another tab of the same conversation kept, sent or forgot one. Without this, a message the
   * other tab already sent would still be drawn here as not sent.
   */
  const onStorage = (event: StorageEvent) => {
    if (!event.key?.startsWith(KEY_PREFIX)) return;
    cache.delete(event.key.slice(KEY_PREFIX.length));
    onChange();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    watchers.delete(onChange);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

/** The conversation's unsent messages, kept current. */
export function useUnsent(
  channelId: string | undefined,
): readonly UnsentMessage[] {
  return useSyncExternalStore(
    subscribe,
    () => (channelId ? readUnsent(channelId) : EMPTY),
    () => EMPTY,
  );
}

const NONE_RESENT: ReadonlySet<string> = new Set();

/** The messages sent again by themselves in this tab. Subscribed, so the line appears. */
export function useResent(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => resent,
    () => NONE_RESENT,
  );
}

/** Test seam: back to a tab that has kept nothing. Storage is the test's to clear. */
export function forgetUnsentCache(): void {
  cache.clear();
  unstored.clear();
  resent = new Set();
}
