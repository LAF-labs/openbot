/**
 * The 문의·의견 box's call, and the exact shape of what it sends.
 *
 * THE BODY IS BUILT HERE AND NOWHERE ELSE, so that "send what is on screen too" means one thing
 * that can be read in one place: the path of the screen and the code of the last failure it drew.
 * Never a screenshot, never a message from the conversation — `feedback.test.ts` serialises the
 * body and says so. The server keeps only these keys whatever arrives (`support/routes.ts`), but
 * a client that never sends more is the half of that promise this file owns.
 *
 * 보냈습니다 IS A READING OF THE SERVER'S ANSWER. The receipt carries the row's id, when it was
 * received and which doors told the operator; the dialog draws those, and draws nothing on a
 * request that did not come back 201.
 */
import { t } from "@/lib/i18n";
import type { RememberedFailure } from "./last-failure";

/** The server's limit, repeated so the box can stop somebody before the refusal. */
export const FEEDBACK_MAX_LENGTH = 2_000;

/** What "this screen" means on the wire. */
export type ScreenFacts = {
  route: string;
  failureCode?: string;
};

export type FeedbackBody = {
  text: string;
  screen?: ScreenFacts;
};

export type FeedbackReceipt = {
  id: string;
  receivedAt: string;
  /** Which doors told the operator. Empty is honest: the row is kept and nobody was paged. */
  told: string[];
};

/**
 * The refusals the route can answer with, in the English `t()` reads as a key.
 *
 * `t()` on a variable is invisible to `i18n-coverage.test.ts`; `feedback.test.ts` walks this table.
 */
export const FEEDBACK_REFUSALS: Record<string, string> = {
  "laf:feedback_empty": "Write something first.",
  "laf:feedback_too_long":
    "That is longer than {limit} characters. Shorten it a little.",
};

export function screenFactsFor(
  pathname: string,
  failure: RememberedFailure | null,
): ScreenFacts {
  return { route: pathname, ...(failure ? { failureCode: failure.code } : {}) };
}

export function feedbackBody(
  text: string,
  screen: ScreenFacts | null,
): FeedbackBody {
  return { text: text.trim(), ...(screen ? { screen } : {}) };
}

export async function sendFeedback(
  text: string,
  screen: ScreenFacts | null,
  fetchImpl: typeof fetch = fetch,
): Promise<FeedbackReceipt> {
  const response = await fetchImpl("/api/support/feedback", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(feedbackBody(text, screen)),
  });
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    const code = typeof body?.error === "string" ? body.error : "";
    const known = FEEDBACK_REFUSALS[code];
    throw new Error(
      known
        ? t(known, {
            limit:
              typeof body?.limit === "number"
                ? body.limit
                : FEEDBACK_MAX_LENGTH,
          })
        : t("That did not go through. Try again."),
    );
  }
  if (
    !body ||
    typeof body.id !== "string" ||
    typeof body.receivedAt !== "string"
  ) {
    throw new Error(t("That did not go through. Try again."));
  }
  return {
    id: body.id,
    receivedAt: body.receivedAt,
    told: Array.isArray(body.told)
      ? body.told.filter((door): door is string => typeof door === "string")
      : [],
  };
}
