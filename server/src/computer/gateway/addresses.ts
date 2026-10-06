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
 * A path in the Bot's folder in its ONE spelling, or null when it is not a path there at all.
 *
 * WHAT A RULE JUDGES HAS TO BE WHAT THE COMPUTER ACTS ON. The computer does not act on the string
 * it is sent: it trims it and resolves it (`agent-computer/src/workspace.ts`, `resolvePath`), so
 * `"private/pay.csv "`, `"./private/pay.csv"`, `"private//pay.csv"` and `"private/pay.csv/."` are
 * one file there. Here they were four strings, and a rule was asked about whichever one a model
 * wrote: `matches(file.path, "^private/")` did not see `./private/…`, `file.name == ".env"` did not
 * see `.env/`, `file.extension == "exe"` did not see `tool.exe/.` or `tool.exe ` — and the row said
 * "allowed" under a path that is not the one that was read. The chat's door trimmed; a routine's
 * did not even do that (found by an independent read of the script act, 2026-10-07, in the reads a
 * script names, and then here in the Bot's own). The shipped policy has no rule about a file's
 * path, so nothing shipped was walked past; a deployment that wrote one was.
 *
 * So `govern` reads every path this way before anything is decided, and the policy, the question,
 * an allowance's scope, the count of "the same call again" and the row all get the computer's own
 * reading: the ends trimmed, `.` and empty segments and a trailing slash gone. It is that reading
 * and nothing stricter — a name with a space or a backslash inside it is a name there, and here.
 *
 * NULL IS EXACTLY WHAT THE COMPUTER REFUSES AS A PATH: blank, a NUL, an absolute path, a `..`
 * segment. Such a string has no file behind it whatever a rule says of it, so it is left as it was
 * written — judged as written, refused by the computer (`laf:file_path_refused`), and on the trail
 * as an act that was allowed and did not happen, which is what it was before.
 */
export function workspacePathOf(requested: string): string | null {
  const wanted = requested.trim();
  if (wanted === "" || wanted.includes("\0") || wanted.startsWith("/")) {
    return null;
  }
  const segments = wanted
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return null;
  // Nothing left is the folder itself, which is how a listing of the whole of it is asked for.
  return segments.length === 0 ? "." : segments.join("/");
}

/**
 * Split a path into the parts a rule wants to match on.
 *
 * Handed a path in its one spelling ({@link workspacePathOf}) by `govern`, whoever named the file.
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
