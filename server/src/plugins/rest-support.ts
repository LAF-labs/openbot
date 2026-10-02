import {
  MAX_RESULT_CHARS,
  type McpCallResult,
  shapeResult,
  trimDetail,
  withoutCredential,
} from "./mcp";
import { TIMEOUT_MS } from "./timeouts";
import { cutAtCodeUnits } from "../../../shared/sound-text";

/**
 * What every REST adapter in this directory does the same way: one request, one result, one refusal.
 *
 * WHY IT IS SHARED. `google-drive-rest.ts` was the first adapter and every one of these helpers grew
 * there. The second, third and fourth would each have carried a copy — and the copies would drift on
 * exactly the details that are easy to get wrong twice: an empty result read by a model as "nothing
 * to say" and filled in from memory, a 200 that is a CDN's HTML rather than a vendor's JSON, a size
 * cap applied in one adapter and not the next.
 *
 * AND THE FIRST ONE DRIFTED. Measured 2026-09-10 (audit A9, F6): Drive still held its private copies
 * from before this file existed — following redirects with somebody's token on the request, and
 * throwing a `SyntaxError` out of a tool call when Google's maintenance page answered 200 with HTML —
 * while the five adapters written after it did neither. Drive reads from here now, and nothing in
 * this directory may hold a second copy of any of these.
 *
 * These are the parts with no vendor in them. Which URL, which fields, and what a result reads like
 * belong to each adapter, because those are the parts a reviewer has to check against the vendor's
 * documentation.
 */

export type RestConnection = { url: string; token?: string };

/**
 * What a result ends with when only the opening of its body is in it. See {@link asResult}.
 *
 * It states no length, and nothing about what was read: whether the rest was a megabyte nobody
 * downloaded or forty characters that arrived in the last piece, this is all that is true of both.
 */
const MORE_THAN_SHOWN =
  "\n\n[truncated: only the opening is shown, and there is more after it]";

/**
 * Text as a tool result, through the one function that decides what a model is told.
 *
 * The empty case and the size cap are {@link shapeResult}'s, shared with the MCP transport, so
 * which door a result came through cannot change what the model reads.
 *
 * `more` is for a body {@link readOpening} stopped reading, and it is its own branch for two
 * reasons. Nobody knows how long that body is, so `shapeResult`'s note — "the tool returned N
 * characters" — would state a length that was never measured. And the note has to fit INSIDE the
 * cap: a result over it is filed on the Bot's computer and shown by its first 20,000 characters
 * (`shared/spillover.ts`), which is exactly where a note appended after the cap is not. So the
 * text is cut short enough to carry it, and between characters (`shared/sound-text.ts`).
 */
export function asResult(text: string, more = false): McpCallResult {
  const joined = text.trim();
  if (!more) return { ...shapeResult(joined), isError: false };

  const opening = cutAtCodeUnits(
    joined,
    MAX_RESULT_CHARS - MORE_THAN_SHOWN.length,
  );
  return {
    text: `${opening}${MORE_THAN_SHOWN}`,
    isError: false,
    truncated: true,
  };
}

/**
 * A failure as a result rather than a throw, with the status behind it when there is one.
 *
 * The status is a separate field and not only a number in the sentence, because one reader acts on
 * it: the call path judges a connection's health off a 401 (`connection-health.ts`).
 */
export const failure = (message: string, status?: number): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
  ...(status === undefined ? {} : { status }),
});

/**
 * A tool name that reached an adapter and is not one it implements.
 *
 * It means the stored tool list and this code have diverged, which is a bug to surface rather than
 * to absorb. One sentence for the six adapters, because six copies of it were measured and a
 * seventh would have been written the next time one was added.
 */
export const unknownTool = (toolName: string): McpCallResult =>
  failure(
    `${toolName} is not a tool this connector implements. The stored tool list is out of date; refresh it on the Plugins page.`,
  );

/** An argument the model sent, if it sent a usable one. */
export function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A whole number the model sent, clamped, or the fallback. Never NaN, never negative. */
export function countArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const value = Number(args[key]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

/**
 * One request to a vendor, with the caller's own token.
 *
 * `token` is never optional in practice — every entry these adapters serve is `user-oauth`, so the
 * store has already refused a call with nobody's credential — but the shared connection shape types
 * it optional, so a missing one is named rather than sent as `Bearer undefined`.
 *
 * The vendor's own sentence is kept when it sends one. For a 403 that is where Google names the API
 * that is not enabled and gives the console URL, which is the difference between a fix and a guess.
 *
 * `signal` is the caller's bound on the WHOLE tool call, laid over this request's own. An adapter
 * that fans one call out into many requests (Gmail's search) hands the same signal to each, so the
 * person waits for one deadline rather than for the sum of fifty.
 */
export async function vendorRequest(
  vendor: string,
  connection: RestConnection,
  input: {
    /** Absolute. Each adapter builds it, because each vendor's path shape is its own. */
    url: string;
    method?: "GET" | "POST" | "PUT" | "PATCH";
    query?: Record<string, string | undefined>;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<
  | { ok: true; response: Response }
  | { ok: false; message: string; status?: number }
> {
  if (!connection.token) {
    return { ok: false, message: "No credential was available for this call." };
  }

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return {
      ok: false,
      message: `${vendor} could not be reached: bad address.`,
    };
  }
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }

  const own = AbortSignal.timeout(TIMEOUT_MS.rest);
  let response: Response;
  try {
    response = await fetch(url, {
      method: input.method ?? "GET",
      headers: {
        authorization: `Bearer ${connection.token}`,
        ...(input.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(input.headers ?? {}),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      /*
       * A redirect is not a detour to be followed: this request carries somebody's access token, and
       * following a 302 would hand it to whatever address the answer named. The same rule the token
       * endpoints in `oauth.ts` state.
       */
      redirect: "manual",
      signal: input.signal ? AbortSignal.any([input.signal, own]) : own,
    });
  } catch (error) {
    // Both a request that outlived its own bound and one cut short by the call's deadline arrive
    // as an abort; the difference is not the vendor's, and one sentence covers both.
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      ok: false,
      message: timedOut
        ? `${vendor} did not answer in time.`
        : `${vendor} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let detail = "";
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: unknown } | string;
        message?: unknown;
      };
      if (typeof parsed.error === "object" && parsed.error !== null) {
        if (typeof parsed.error.message === "string") {
          detail = parsed.error.message;
        }
      } else if (typeof parsed.message === "string") {
        detail = parsed.message;
      }
    } catch {
      // Not JSON. The status alone is still worth saying.
    }
    /*
     * The token this request carried, cut out of the vendor's sentence before it is trimmed: the
     * sentence is what the model reads as the tool's result, and a vendor that quotes the credential
     * it refused would otherwise hand the model a live one (`withoutCredential` in `./mcp`).
     */
    const said = withoutCredential(detail, connection.token);
    return {
      ok: false,
      status: response.status,
      message: said
        ? `${vendor} refused this request (${response.status}): ${trimDetail(said)}`
        : `${vendor} refused this request (${response.status}).`,
    };
  }

  return { ok: true, response };
}

/**
 * The JSON body, or nothing.
 *
 * A 200 is not a promise of JSON — a captive portal or a maintenance page answers 200 with HTML —
 * and an unguarded parse would throw out of a tool call that has a perfectly good way to say the
 * vendor answered with something unusable.
 */
export async function readJson<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

/**
 * The opening of a body as text — enough to fill one result — and whether there was more.
 *
 * `response.text()` holds the whole download as one string before all but its opening is dropped.
 * Measured 2026-10-02 against a file that never ended, 64 KB every 25 ms: the call came back when
 * the 30-second signal fired, with 70 MB taken in, and — the old `.catch(() => "")` — as a file
 * with nothing in it. This process is the one API server a deployment has, and upstream measured
 * 600 MB for one 200 MB log (OpenBot #595, MIT). So reading stops once there is more than a result
 * can carry, and the request is ended rather than left to finish.
 *
 * `abandon` IS WHAT ENDS IT, and it is not optional. Upstream cancels the body's reader and calls
 * the download cancelled; measured here on Bun 1.3.11, a cancelled reader only throws the bytes
 * away — the server went on sending, 14 MB in six seconds, until the request's own signal fired —
 * while aborting the request stopped it within 80 ms. So the caller hands {@link vendorRequest} a
 * signal of its own and hands this the function that aborts it.
 *
 * DECODED AS A STREAM, the way `response.text()` decodes: UTF-8, a byte order mark dropped,
 * anything malformed replaced. A piece off the wire ends wherever it likes and 한글 is three bytes
 * a character, so the decoder holds a character's first bytes until the rest arrive; where reading
 * stops early that held tail is never flushed, which drops it instead of turning it into U+FFFD.
 *
 * What comes back may be longer than `maxChars`: the piece that crossed the line is kept whole.
 * {@link asResult} makes the cut, because it is the one that knows what else has to fit.
 *
 * A body that breaks before it is read reads as empty, as it did under `text().catch(() => "")`.
 */
export async function readOpening(
  response: Response,
  maxChars: number,
  abandon: () => void,
): Promise<{ text: string; more: boolean }> {
  if (!response.body) return { text: "", more: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length <= maxChars) {
      const { done, value } = await reader.read();
      if (done) return { text: text + decoder.decode(), more: false };
      text += decoder.decode(value, { stream: true });
    }
    return { text, more: true };
  } catch {
    return { text: "", more: false };
  } finally {
    // Both, on every way out: a request already answered in full has nothing left to abort, and
    // the cancel is what drops any bytes that arrive before the abort lands.
    abandon();
    await reader.cancel().catch(() => {});
  }
}
