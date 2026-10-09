/**
 * WHERE A SAVED LOGIN MAY BE PUT: an origin, written one way, and HTTPS.
 *
 * A person saves a login for a site, and the Bot's browser fills it in for them
 * (`docs/laf/redesign-2026-10.md` §6). What keeps a page from talking the Bot into putting that
 * password somewhere else is the same thing a password manager uses: the value goes only where it
 * was saved for. That comparison is only as good as the two things compared, so the origin is
 * normalised ONCE, here — when a login is saved, and again when a field is about to be filled —
 * and never compared as two strings somebody wrote.
 *
 * AN ORIGIN, NOT A HOST. Compared by host, a login saved for `https://shop.example` also matches
 * `http://shop.example`, and a redirect somebody intercepted is handed the password in the clear.
 * The scheme and the port are part of what was saved.
 *
 * HTTPS ONLY. The one exception is a developer's own machine, where the page under test is served
 * on a loopback address without a certificate; it is asked for by name and is never the default.
 */

/** The longest a host name can be (RFC 1035), and the longest thing a person can type for one. */
const HOST_NAME_MAX = 253;
const LOGIN_ADDRESS_MAX = 2048;

/** A host that is this machine and nothing else. */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * The origin a saved login is for — `https://host` or `https://host:port`, lower-cased, without the
 * port its scheme implies — or `null` where what was written is not one.
 *
 * Takes what a person types: `naver.com`, `https://nid.naver.com/nidlogin.login?mode=form`. The
 * path and the query are dropped — a login is for a site, and a page's address is not a place a
 * password is saved for. Refused: anything that is not HTTPS, an address that carries a name and
 * a password of its own (`https://user:pw@host`), and anything that does not parse.
 */
export function loginOriginOf(
  written: string,
  options: { allowLoopbackHttp?: boolean } = {},
): string | null {
  const text = written.trim();
  if (!text || /\s/.test(text)) return null;
  // Longer than an address is: not read at all, however much of a megabyte it fills.
  if (text.length > LOGIN_ADDRESS_MAX) return null;
  // A bare host is the site's HTTPS address: nobody types the scheme, and no other is taken.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    ? text
    : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  /*
   * A NAME NO LONGER THAN A NAME CAN BE. The parser takes a host of any length, so one address
   * could be most of a megabyte — saved in the row, written into the trail, which is never
   * deleted, and sent back in every list (Codex's fifth read of the change that saves these). A
   * host name is at most 253 characters; what is longer is not one.
   */
  if (url.hostname.length > HOST_NAME_MAX) return null;
  if (url.protocol === "https:") return url.origin;
  if (
    url.protocol === "http:" &&
    options.allowLoopbackHttp === true &&
    isLoopback(url.hostname)
  ) {
    return url.origin;
  }
  return null;
}

/**
 * Whether a frame at `address` is one of the origins a login was saved for. Both sides go through
 * {@link loginOriginOf}, so what is compared is never two spellings of one origin.
 */
export function isSavedOrigin(
  saved: readonly string[],
  address: string,
  options: { allowLoopbackHttp?: boolean } = {},
): boolean {
  const origin = loginOriginOf(address, options);
  if (!origin) return false;
  return saved.some((one) => loginOriginOf(one, options) === origin);
}
