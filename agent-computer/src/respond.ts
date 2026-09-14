/**
 * How an answer leaves this process.
 *
 * Every route writes its body through here, and the types are what keep a failure honest: `json`
 * answers 200 and nothing else, so a refusal or a failure can only be written by `fact`, which
 * cannot be handed a sentence.
 */

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

/** A request's JSON body, or null for one that has none or cannot be read. */
export async function bodyOf<T>(request: Request): Promise<T | null> {
  return (await request.json().catch(() => null)) as T | null;
}

/** A fact this process answers a failure with: `laf:` and a name. */
export type FactCode = `laf:${string}`;

/**
 * A refusal or a failure, as the fact it is and the facts beside it — never a sentence.
 *
 * THE CODE IN `error` AS WELL AS IN `code`. `error` is what every reader of this contract already
 * reads: the server's client puts it into the error it throws, and from there it reaches the audit
 * trail, the model and the person. That is how this container's English — "A url is required.",
 * "The action failed." — and Playwright's own messages used to arrive on a Korean surface, and a
 * Playwright message is worse than English: it carries the call log, and the call log of a `fill`
 * carries the value being typed (measured 2026-09-14: `fill: Error: Element is not an <input> … -
 * fill("PERSON-TYPED-SECRET-7788")`, in the body `/human/secret` answered with). The words for every
 * code live in `shared/prompt/tool-results.ko.ts`; the facts ride beside it here.
 */
export function fact(
  code: FactCode,
  status: number,
  facts: Record<string, unknown> = {},
): Response {
  return write({ ...facts, error: code, code }, status);
}

/**
 * The page that never loaded: the one failure whose `error` is not its code.
 *
 * The server tells a page that never loaded from a computer that is down by Playwright's first line
 * (`server/src/computer/client.ts`, `/goto: Timeout .* exceeded/`, answered as 504 `laf:page_timeout`);
 * handed the code alone it answers 503, "the computer is not responding", about a site that is slow.
 * So the first line stays in `error` until that client reads `code` — the first line only, because
 * the call log under it names the address and is nobody's business here.
 */
export function pageTimeout(
  playwrightMessage: string,
  facts: Record<string, unknown>,
): Response {
  return write(
    {
      ...facts,
      error: playwrightMessage.split("\n", 1)[0],
      code: "laf:page_timeout",
    },
    504,
  );
}

/** The code an error already is, when this process threw it as one (`laf:navigation_guard_unavailable`). */
export function codeOf(error: unknown): FactCode | undefined {
  return error instanceof Error && /^laf:[a-z_]+$/.test(error.message)
    ? (error.message as FactCode)
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
  return fact(REQUEST_INVALID, 400, { field });
}

/**
 * The browser did not do what it was asked, for a reason that is not a refusal: a page that went
 * away under the call, a tab that closed, a browser that would not start.
 *
 * Playwright's message is not passed on (see `fact`). Where the failure was this process's own code
 * — the guard that could not be installed — that code is the answer.
 */
export function browserFailed(error: unknown): Response {
  return fact(codeOf(error) ?? "laf:browser_failed", 502);
}
