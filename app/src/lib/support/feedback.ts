/**
 * The 문의·의견 box's calls, and the exact shape of what it sends.
 *
 * THE BODY IS BUILT HERE AND NOWHERE ELSE, so that "send what is on screen too" means one thing
 * that can be read in one place: the path of the screen and the code of the last failure it drew.
 * Never a screenshot, never a message from the conversation — `feedback.test.ts` serialises the
 * body and says so. The server keeps only these keys whatever arrives (`support/routes.ts`), but
 * a client that never sends more is the half of that promise this file owns.
 *
 * "SEND DIAGNOSTIC DETAILS TOO" SENDS AN ID, NOT THE DETAILS. The server assembles the bundle and
 * hands it over to be SHOWN (`fetchDiagnostics`); what goes back with the message is the id of the
 * one that was shown, and the server stores that one. A browser that could send the bundle could
 * send anything under its name.
 *
 * 보냈습니다 IS A READING OF THE SERVER'S ANSWER. The receipt carries the row's id, when it was
 * received, which doors told the operator and whether the details went with it; the dialog draws
 * those, and draws nothing on a request that did not come back 201.
 */
import type { ConnectionCheckFacts } from "@shared/support/connection-check";
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
  diagnostics?: { id: string };
};

export type FeedbackReceipt = {
  id: string;
  receivedAt: string;
  /** Which doors told the operator. Empty is honest: the row is kept and nobody was paged. */
  told: string[];
  /** Whether the diagnostic details went with it, as the server says. */
  withDiagnostics: boolean;
};

/**
 * One event in the bundle: when, which record it came from, its name, and facts that are ids,
 * codes and numbers (`server/src/support/diagnostics.ts` decides which).
 */
export type DiagnosticEvent = {
  at: string;
  source: "log" | "run";
  event: string;
  [fact: string]: string | number | boolean;
};

/** The bundle as the server assembled it. Drawn, never built, by the browser. */
export type DiagnosticBundle = {
  assembledAt: string;
  version: { version: string; revision?: string; channel?: string };
  health: { status: "ok" | "degraded"; checks: Record<string, "ok" | "down"> };
  failureWindowDays: number;
  failures: Array<{ code: string; count: number; lastAt: string }>;
  events: DiagnosticEvent[];
  /** The last 연결 점검 this tab ran, as the server read it back. Absent when none was sent. */
  connectionCheck?: ConnectionCheckFacts;
};

export type DiagnosticsPreview = { id: string; diagnostics: DiagnosticBundle };

/**
 * The refusals the route can answer with, in the English `t()` reads as a key.
 *
 * `t()` on a variable is invisible to `i18n-coverage.test.ts`; `feedback.test.ts` walks this table.
 */
export const FEEDBACK_REFUSALS: Record<string, string> = {
  "laf:feedback_empty": "Write something first.",
  "laf:feedback_too_long":
    "That is longer than {limit} characters. Shorten it a little.",
  "laf:diagnostics_expired":
    "The diagnostic details have changed since they were shown. Look at them again, then send.",
};

/** The code a refused send answered with, for a caller that has to act on one of them. */
export class FeedbackRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FeedbackRefusedError";
    this.code = code;
  }
}

export function screenFactsFor(
  pathname: string,
  failure: RememberedFailure | null,
): ScreenFacts {
  return { route: pathname, ...(failure ? { failureCode: failure.code } : {}) };
}

export function feedbackBody(
  text: string,
  screen: ScreenFacts | null,
  diagnosticsId: string | null = null,
): FeedbackBody {
  return {
    text: text.trim(),
    ...(screen ? { screen } : {}),
    ...(diagnosticsId ? { diagnostics: { id: diagnosticsId } } : {}),
  };
}

export async function sendFeedback(
  text: string,
  screen: ScreenFacts | null,
  fetchImpl: typeof fetch = fetch,
  diagnosticsId: string | null = null,
): Promise<FeedbackReceipt> {
  const response = await fetchImpl("/api/support/feedback", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(feedbackBody(text, screen, diagnosticsId)),
  });
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    const code = typeof body?.error === "string" ? body.error : "";
    const known = FEEDBACK_REFUSALS[code];
    throw new FeedbackRefusedError(
      code,
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
    withDiagnostics: body.withDiagnostics === true,
  };
}

/**
 * The bundle the box would attach, assembled by the server and held there under the id it returns.
 *
 * WITH THE LAST 연결 점검, when this tab ran one: the one part only the window can know. It goes as
 * a query on the same read — a result of closed values (`shared/support/connection-check.ts`) that
 * the server reads through the same vocabulary and keeps only if every field is on it — so the
 * preview drawn from the answer is still exactly what would be stored.
 */
export async function fetchDiagnostics(
  fetchImpl: typeof fetch = fetch,
  connectionCheck: ConnectionCheckFacts | null = null,
): Promise<DiagnosticsPreview> {
  const query = connectionCheck
    ? `?connectionCheck=${encodeURIComponent(JSON.stringify(connectionCheck))}`
    : "";
  const response = await fetchImpl(`/api/support/diagnostics${query}`, {
    credentials: "include",
  });
  const body = (await response.json().catch(() => null)) as {
    id?: unknown;
    diagnostics?: unknown;
  } | null;
  if (
    !response.ok ||
    typeof body?.id !== "string" ||
    !body.diagnostics ||
    typeof body.diagnostics !== "object"
  ) {
    throw new Error(t("The diagnostic details could not be gathered."));
  }
  return { id: body.id, diagnostics: body.diagnostics as DiagnosticBundle };
}
