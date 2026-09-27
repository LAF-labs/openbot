/**
 * 이야기하기: a 소식 post quoted into the conversation by its id, turned into what the model reads on
 * the way out (`shared/feed.ts` on the part; muse-shape teardown §2 on why by id).
 *
 * The same seam as a message's files (`attachments/for-model.ts`): on the fetch, because finding the
 * post reads the database. The post is read again, as this Bot wrote it — never the title the part
 * carries, which is only for the chip — so the Bot answers about the post and not about whatever a
 * message claimed it said. A run with no quote in it is passed through untouched.
 */
import {
  type FeedQuotePart,
  isFeedQuotePart,
  quotedPostId,
} from "../../../shared/feed";
import {
  FEED_QUOTE_MISSING,
  feedQuoteText,
} from "../../../shared/prompt/feed.ko";
import type { AgentFetch } from "../channels/stall-guard";
import type { FeedStore } from "./store";

type Part = Record<string, unknown> & { type: string };

type RunBody = { messages?: Array<{ role?: string; content?: unknown }> };

export function withFeedQuotes(
  store: Pick<FeedStore, "forQuote">,
  botId: string,
  inner: AgentFetch,
): AgentFetch {
  return async (url, requestInit) => {
    const raw = requestInit.body;
    // The cheap test first: only a body carrying the quote's type can hold one.
    if (typeof raw !== "string" || !raw.includes("vnd.laf.feed-post")) {
      return inner(url, requestInit);
    }
    let body: RunBody;
    try {
      body = JSON.parse(raw) as RunBody;
    } catch {
      return inner(url, requestInit);
    }
    const quotes = (body.messages ?? []).flatMap((message) =>
      message.role === "user" && Array.isArray(message.content)
        ? message.content.filter(isFeedQuotePart)
        : [],
    );
    if (quotes.length === 0) return inner(url, requestInit);
    const found = new Map<string, string>();
    for (const quote of quotes) {
      const id = quotedPostId(quote);
      if (found.has(id)) continue;
      const post = await store.forQuote(botId, id);
      found.set(id, post ? feedQuoteText(post) : FEED_QUOTE_MISSING);
    }
    const messages = (body.messages ?? []).map((message) =>
      message.role === "user" && Array.isArray(message.content)
        ? {
            ...message,
            content: (message.content as Part[]).map((part) =>
              isFeedQuotePart(part)
                ? {
                    type: "text",
                    text:
                      found.get(quotedPostId(part as FeedQuotePart)) ??
                      FEED_QUOTE_MISSING,
                  }
                : part,
            ),
          }
        : message,
    );
    return inner(url, {
      ...requestInit,
      body: JSON.stringify({ ...body, messages }),
    });
  };
}
