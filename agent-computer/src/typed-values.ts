/**
 * What a person typed, known by a keyed digest — so an address carrying it can be blanked after the
 * box it was typed into has left the page.
 *
 * A FORM SENT BY GET PUTS ITS BOXES IN THE ADDRESS. Measured 2026-09-16 (audit R3-03): a person's
 * value went into a box through the masked prompt, the Bot pressed Enter, and `/key` answered
 * `…/landed?pin=SEC-GETFORM-7788` — as did the next snapshot's `url` and `tabs`, and `/read`. A look
 * keeps a box's value out by asking the box (`secret-fields.ts`), and by the time the address carries
 * the value the box is gone: the page it was on went with the submission, and a question to a page
 * that is leaving is not answered until it has left (`page-arrival.ts`).
 *
 * So what outlives the box is a digest, taken while the box could still be read — HMAC-SHA256 under a
 * key this process draws when it starts and never writes anywhere. Never the value. A digest of a
 * four-digit PIN is guessable by whoever holds the key, which is whoever holds this process, which
 * holds the browser the PIN was typed into.
 *
 * No Playwright in here, so the address rules can be tested without a browser.
 */
import { createHmac, randomBytes } from "node:crypto";
import { comparableValue } from "./aria-snapshot";
import { rewritten } from "./respond";
import type { BotSession } from "./sessions";

const KEY = randomBytes(32);

/**
 * How long a value has to be before it is worth blanking. One character is `page=1`, and blanking
 * every `1` because somebody once typed one would take the Bot's addresses apart for nothing; two is
 * the first two digits of a card's password, which Korean checkouts ask for on their own.
 */
const SHORTEST_VALUE = 2;

/**
 * How long a block of typed text has to be before it is kept on its own.
 *
 * A block is a paste, or a finished Korean word — which the live screen sends one syllable at a time
 * (`handleCompositionEnd`), so a shorter floor would fill the list below with syllables. A pasted
 * one-time code is six.
 */
const SHORTEST_BLOCK = 4;

/** How many digests a session keeps of each kind. Newest kept; a box's own is on the box. */
const DIGEST_LIMIT = 32;

/** The digest of a value, as a look compares values (`comparableValue`), or none for a short one. */
export function digestOf(value: string): string | undefined {
  const comparable = comparableValue(value);
  if (comparable.length < SHORTEST_VALUE) return undefined;
  return createHmac("sha256", KEY).update(comparable).digest("base64url");
}

/** The digest of a block of text a person sent at once, when it is long enough to be one. */
export function digestOfBlock(text: string): string | undefined {
  return comparableValue(text).length >= SHORTEST_BLOCK
    ? digestOf(text)
    : undefined;
}

function kept(list: string[], digest: string | undefined): string[] {
  if (!digest) return list;
  return [...list.filter((each) => each !== digest), digest].slice(
    -DIGEST_LIMIT,
  );
}

/** Keep the digest of something a person typed whose box is gone, or that came as one block. */
export function keepTyped(session: BotSession, digest: string | undefined) {
  session.typedDigests = kept(session.typedDigests, digest);
}

/** Keep the digest of something the Bot itself put into a box. */
export function keepOwn(session: BotSession, digest: string | undefined) {
  session.ownDigests = kept(session.ownDigests, digest);
}

/** Keep every value in an address the Bot itself asked for. See `ownDigests`. */
export function keepOwnAddress(session: BotSession, address: string): void {
  for (const value of addressValues(address)) {
    keepOwn(session, digestOf(value));
  }
}

/**
 * Whether a value is one a person typed and the Bot did not, or null when this session knows of
 * nothing a person typed — the answer for nearly every call, and the one that costs nothing.
 */
export function typedValueTest(
  session: BotSession,
): ((value: string) => boolean) | null {
  const typed = new Set(session.typedDigests);
  for (const field of session.secretFields) {
    if (field.digest) typed.add(field.digest);
  }
  if (typed.size === 0) return null;
  const own = new Set(session.ownDigests);
  return (value) => {
    const digest = digestOf(value);
    return digest !== undefined && typed.has(digest) && !own.has(digest);
  };
}

/** A web address with a query or a fragment: the only strings anything here is done to. */
const WEB_ADDRESS_WITH_REST = /^https?:\/\/[^?#\s]*[?#]/i;

/** The ways a value is written into an address: form encoding, where `+` is a space, and plain. */
function readingsOf(raw: string): string[] {
  const readings = new Set<string>();
  for (const spelled of [raw.replaceAll("+", " "), raw]) {
    try {
      readings.add(decodeURIComponent(spelled));
    } catch {
      readings.add(spelled);
    }
  }
  return [...readings];
}

/** One `a=b&c=d` part, with the values that are typed blanked and everything else as it was. */
function blankedPairs(part: string, isTyped: (value: string) => boolean) {
  return part
    .split("&")
    .map((pair) => {
      const equals = pair.indexOf("=");
      const raw = equals === -1 ? pair : pair.slice(equals + 1);
      if (!raw || !readingsOf(raw).some(isTyped)) return pair;
      // The name stays: `pin=` says a parameter was there, and nothing about what it held.
      return equals === -1 ? "" : pair.slice(0, equals + 1);
    })
    .join("&");
}

/** An address split where its values are: before the query, the query, and the fragment. */
function partsOf(address: string) {
  const hashAt = address.indexOf("#");
  const beforeHash = hashAt === -1 ? address : address.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  return {
    head: queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt),
    query: queryAt === -1 ? null : beforeHash.slice(queryAt + 1),
    fragment: hashAt === -1 ? null : address.slice(hashAt + 1),
  };
}

/** Every value in an address's query and fragment, as it would be read back. */
function addressValues(address: string): string[] {
  if (!WEB_ADDRESS_WITH_REST.test(address)) return [];
  const { query, fragment } = partsOf(address);
  return [query, fragment]
    .filter((part): part is string => part !== null)
    .flatMap((part) => part.split("&"))
    .flatMap((pair) => {
      const equals = pair.indexOf("=");
      return readingsOf(equals === -1 ? pair : pair.slice(equals + 1));
    })
    .filter(Boolean);
}

/**
 * An address with every query and fragment value a person typed blanked, and nothing else changed.
 *
 * WRITTEN BACK AS IT WAS, not re-serialised: `URL` and `URLSearchParams` respell what they read
 * (`%20` becomes `+`, a bare key gains an `=`), and an address the Bot is handed back altered where
 * nobody typed anything would stop matching the one it asked for. Values are compared the way a form
 * writes them. The path is left alone: a GET form writes its boxes into the query, and a path segment
 * that happens to equal a PIN is somebody's order number more often than not.
 */
export function withoutTyped(
  address: string,
  isTyped: (value: string) => boolean,
): string {
  if (!WEB_ADDRESS_WITH_REST.test(address)) return address;
  const { head, query, fragment } = partsOf(address);
  return [
    head,
    query === null ? "" : `?${blankedPairs(query, isTyped)}`,
    fragment === null ? "" : `#${blankedPairs(fragment, isTyped)}`,
  ].join("");
}

/** Every address anywhere in a body, blanked. Only a whole string that is an address is touched. */
function withoutTypedIn(
  value: unknown,
  isTyped: (value: string) => boolean,
): unknown {
  if (typeof value === "string") return withoutTyped(value, isTyped);
  if (Array.isArray(value)) {
    return value.map((each) => withoutTypedIn(each, isTyped));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [
        key,
        withoutTypedIn(each, isTyped),
      ]),
    );
  }
  return value;
}

/**
 * An answer, with every address in it blanked of what a person typed — before it leaves this process.
 *
 * AT THE DOOR, NOT AT EACH ADDRESS. An address leaves on a dozen answers — every action's `url`, a
 * look's `url` and `tabs`, a read's `url` and `frames`, a switch's `tabs`, the `redirect` a held
 * navigation hands back — and one written next month would be one more. Every answer to a Bot's
 * route passes `computerFetch`, so that is where this is applied; an answer from a session that
 * knows of nothing a person typed goes out untouched and unread.
 *
 * A held hop's `redirect.to` is blanked with the rest, and the gateway asks for it again as it was
 * handed back: a site that forwards a person's value to another host gets it blank. That is a sign-in
 * that fails and says so, which is the side to fail on — the other side is the value in the server's
 * hands, one step from a model's.
 */
export async function withoutTypedAddresses(
  session: BotSession,
  answer: Response,
): Promise<Response> {
  const isTyped = typedValueTest(session);
  if (!isTyped) return answer;
  return rewritten(answer, (body) => withoutTypedIn(body, isTyped));
}
