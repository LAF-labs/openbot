/**
 * How an answer leaves this process.
 *
 * Every route writes its body through here, and the types are what keep a failure honest: `json`
 * answers 200 and nothing else, so a refusal or a failure can only be written by `fact`, which
 * cannot be handed a sentence — or a code `codes.ts` does not list.
 */
import { type AnswerCode, isAnswerCode, statusOf } from "./codes";

function write(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** An answer that worked. Anything else is a {@link fact}. */
export function json(body: unknown): Response {
  return write(body, 200);
}

/**
 * The same answer, its JSON body passed through `change`: the same status, the same code. For a
 * filter every answer passes on its way out (`withoutTypedAddresses`), which must not become a second
 * place an answer is written.
 */
export async function rewritten(
  answer: Response,
  change: (body: unknown) => unknown,
): Promise<Response> {
  if (!answer.headers.get("content-type")?.startsWith("application/json")) {
    return answer;
  }
  const text = await answer.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Nothing here writes a body that does not parse; if one ever does, it goes out as it came.
    return new Response(text, {
      status: answer.status,
      headers: answer.headers,
    });
  }
  return write(change(body), answer.status);
}

/** A request's JSON body, or null for one that has none or cannot be read. */
export async function bodyOf<T>(request: Request): Promise<T | null> {
  return (await request.json().catch(() => null)) as T | null;
}

/**
 * A refusal or a failure, as the fact it is and the facts beside it — never a sentence.
 *
 * THE CODE IN `error` AS WELL AS IN `code`, AND THE STATUS FROM THE LIST. `error` is what every reader
 * of this contract read before `code` existed, and it is how this container's English — "A url is
 * required.", "The action failed." — and Playwright's own messages used to arrive on a Korean surface.
 * A Playwright message is worse than English: it carries the call log, and the call log of a `fill`
 * carries the value being typed (measured 2026-09-14: `fill: Error: Element is not an <input> … -
 * fill("PERSON-TYPED-SECRET-7788")`, in the body `/human/secret` answered with).
 *
 * No exception. A page that never loaded kept Playwright's first line in `error` until 2026-09-14,
 * because the server's client told a slow site from a broken computer by matching it; the client
 * reads `code` now, so nothing here is written for a reader to match.
 */
export function fact(
  code: AnswerCode,
  facts: Record<string, unknown> = {},
): Response {
  return write({ ...facts, error: code, code }, statusOf(code));
}

/**
 * The code an error already is, when this process threw it as one (`laf:navigation_guard_unavailable`).
 * Only a listed answer: a message that merely looks like a code is still a message.
 */
export function codeOf(error: unknown): AnswerCode | undefined {
  return error instanceof Error && isAnswerCode(error.message)
    ? error.message
    : undefined;
}

export const REQUEST_INVALID = "laf:request_invalid";

/**
 * A request this process cannot act on as it was sent: which part was missing or unusable.
 *
 * A class so a check deep inside an action answers the same 400 as a check at the door, instead of
 * reaching the route's catch as a failure of the browser.
 */
export class RequestInvalidError extends Error {
  constructor(readonly field: string) {
    super(REQUEST_INVALID);
    this.name = "RequestInvalidError";
  }
}

/** The answer to a {@link RequestInvalidError}, or to the same check made at the door. */
export function invalid(field: string): Response {
  return fact(REQUEST_INVALID, { field });
}

/**
 * The browser did not do what it was asked, for a reason that is not a refusal: a page that went
 * away under the call, a tab that closed, a browser that would not start.
 *
 * Playwright's message is not passed on (see `fact`). Where the failure was this process's own code
 * — the guard that could not be installed — that code is the answer, with its own status.
 */
export function browserFailed(error: unknown): Response {
  return fact(codeOf(error) ?? "laf:browser_failed");
}
