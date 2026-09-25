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
 * NOT THE QUEUE (`queue.ts`). That holds words typed while the Bot is working, for one follow-up in
 * this mount; this holds words that failed to leave, for as long as it takes. A queued message is
 * never here and an unsent one is never there.
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
};

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
      ? parsed
          .filter(isUnsent)
          .map((entry) => ({ ...entry, autoTried: entry.autoTried === true }))
      : EMPTY;
  } catch {
    return EMPTY;
  }
}

function save(channelId: string, entries: readonly UnsentMessage[]): void {
  cache.set(channelId, entries.length ? entries : EMPTY);
  try {
    const key = `${KEY_PREFIX}${channelId}`;
    if (entries.length) {
      globalThis.localStorage?.setItem(key, JSON.stringify(entries));
    } else {
      globalThis.localStorage?.removeItem(key);
    }
  } catch {
    // Kept for this tab only, then. Still on screen, still sent again when the connection returns.
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

/** Keep a message that did not reach the server. The same id again replaces it in place. */
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
  save(
    channelId,
    at === -1
      ? [...entries, kept]
      : entries.map((entry, index) =>
          index === at
            ? { ...kept, autoTried: entry.autoTried || kept.autoTried }
            : entry,
        ),
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
 */
export function claimAutoSend(channelId: string): UnsentMessage[] {
  const entries = load(channelId);
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
  resent = new Set();
}
