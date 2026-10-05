/**
 * 소식 — WHAT BOTH SIDES AGREE ON (muse-shape plan §3.2, phase 7).
 *
 * How a source address is compared with the pages a run's tools returned, and what a post quoted
 * into the conversation (이야기하기) looks like on the wire. The server judges sources with the first
 * and expands the second into what the model reads; the surface draws the second as a chip.
 */

/**
 * ON THE WIRE, said once for both sides. The server's reads answer these (`server/src/feed/`) and
 * the page draws them (`app/src/lib/feed/`); each side used to declare its own copy, field for
 * field, and a field added to one was a field the other silently did not have.
 */

/** One page a post cites. */
export type FeedSource = { title: string; url: string };

export type FeedPost = {
  id: string;
  agentId: string;
  routineId: string | null;
  topic: string;
  title: string;
  body: string;
  sources: FeedSource[];
  createdAt: string;
  seen: boolean;
  liked: boolean;
};

export type FeedRoutine = {
  id: string;
  agentId: string;
  name: string;
  summary: string | null;
  instruction: string;
  enabled: boolean;
  pausedReason: string | null;
  nextRunAt: string;
  dailyLocal: string | null;
  dailyTimeZone: string | null;
};

export type FeedPage = {
  posts: FeedPost[];
  next: string | null;
  unseen: number;
  /** The person's 소식 routines — one per Bot — for the page's first card. */
  routines: FeedRoutine[];
};

/**
 * A URL as a key: no scheme, no `www.`/`m.`, no trailing slash, no fragment, lower-cased host, and
 * the path decoded — so the address a Bot cites and the one its browser landed on compare equal
 * when they are the same page (the judge `evals/grounded.ts` `pageKey` uses for the same question).
 * Null for anything that is not an http(s) address.
 */
export function feedUrlKey(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // A path that does not decode is compared as it came.
  }
  path = path.replace(/\/+$/, "");
  return `${host}${path}${url.search}`;
}

/** Every http(s) address in a piece of text, as it was written. */
export function urlsIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s"'<>\\)\]]+/g)].map((match) =>
    match[0].replace(/[.,;:!?]+$/, ""),
  );
}

/**
 * 이야기하기: A POST QUOTED INTO THE CONVERSATION BY ITS ID, NOT PASTED.
 *
 * Muse attaches the post to the composer as a structured reply target and sends no text
 * (`~/laf/docs/muse-ux-teardown-2026-09-27.md` §2). Here it is one AG-UI `binary` part of the
 * person's message — the one part whose kept fields (`id`, `filename`) survive AG-UI's strict
 * schemas (`shared/attachments.ts`) — with its own type, so it is never taken for a file. The server
 * reads the post again by its id when the message goes to the model (`server/src/feed/quote.ts`):
 * the Bot is shown the post as it was written, not whatever the message carried, and a post that is
 * gone is said to be gone.
 */
export const FEED_QUOTE_MIME = "application/vnd.laf.feed-post";

export type FeedQuotePart = {
  type: "binary";
  mimeType: typeof FEED_QUOTE_MIME;
  /** `feed:<post id>` — never a UUID alone, so no attachment reader takes it for a file. */
  id: string;
  /** The post's title, for the chip. The model is not shown this; it is shown the post. */
  filename: string;
};

const QUOTE_ID = /^feed:(feed_[0-9a-f-]{36})$/;

export function feedQuotePart(post: {
  id: string;
  title: string;
}): FeedQuotePart {
  return {
    type: "binary",
    mimeType: FEED_QUOTE_MIME,
    id: `feed:${post.id}`,
    filename: post.title,
  };
}

export function isFeedQuotePart(part: unknown): part is FeedQuotePart {
  if (!part || typeof part !== "object") return false;
  const candidate = part as Record<string, unknown>;
  return (
    candidate.type === "binary" &&
    candidate.mimeType === FEED_QUOTE_MIME &&
    typeof candidate.id === "string" &&
    QUOTE_ID.test(candidate.id) &&
    typeof candidate.filename === "string"
  );
}

/** The post a quote names. */
export function quotedPostId(part: FeedQuotePart): string {
  return QUOTE_ID.exec(part.id)?.[1] ?? "";
}

/** The quotes a message carries, in order. */
export function feedQuotesOf(content: unknown): FeedQuotePart[] {
  return Array.isArray(content) ? content.filter(isFeedQuotePart) : [];
}
