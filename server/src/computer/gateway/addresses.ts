/**
 * Addresses and paths, spelled the one way every reader of them agrees on.
 *
 * Pure functions, and the ones a boundary is most easily evaded through: a host spelled with a port
 * or a trailing dot walked past a money rule, and a query string is where a credential rides into an
 * append-only trail. Kept apart from everything that acts so they can be read — and tested — as the
 * spellings they are.
 */
import { normalizeHostname } from "../../net/host-verdict";

/**
 * The host a rule is matched against, spelled one way.
 *
 * `URL.host` keeps a non-default port and a trailing dot, and the shipped money-host pattern is
 * anchored on `$` — so `kbstar.com.` and `kbstar.com:8443` walked past a rule written for
 * `kbstar.com` (measured). `normalizeHostname` is the same spelling every other host comparison in
 * this server uses.
 *
 * Empty means "no page", which is the accurate answer before a Bot has snapshotted anything, and it is
 * the only case that occurs in practice: the URL comes from Playwright's own `page.url()` by way of the
 * snapshot cache. Worth stating explicitly because a `page.host == "..."` deny rule would not match an
 * empty host, so a boundary that must not be evadable should also key on the tool, the element or the
 * file rather than on the host alone.
 */
export function hostOf(url: string): string {
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return "";
  }
}

/** Where a ref was typed into, as far as a restarted browser could be told apart from it. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * The page, as the trail may keep it: the address without its query or fragment.
 *
 * A URL is routinely a credential carrier — `?code=…&state=…` on an OAuth return, a password-reset
 * link, a pre-signed file — and the trail is append-only for a year. The path is what a reader
 * needs; the query is where the secrets are.
 */
export function pageForTrail(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.slice(0, 200);
  }
}

/**
 * The path, for a card that would otherwise say only which site.
 *
 * The query string is deliberately dropped. It is where an order number, an email address and a
 * session token live, and this string is rendered on a screen and written into an audit payload —
 * the same reasoning that keeps typed text out of both.
 */
export function pathOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path === "/" ? "" : path;
  } catch {
    return "";
  }
}

/**
 * Split a path into the parts a rule wants to match on.
 *
 * Lower-cased, because a rule forbidding `.env` must also catch `.ENV`; the
 * operator should have anticipated. Same reasoning as the case-insensitive `contains` in policy.ts.
 */
export function describeFile(path: string): {
  path: string;
  name: string;
  extension: string;
} {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    // A leading dot is the whole name of a dotfile, not an extension: `.env` has no extension, and the
    // rule for it is written against `name`.
    extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
  };
}
