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
 * A path in the Bot's folder in its ONE spelling, or null where it has none.
 *
 * WHAT A RULE JUDGES HAS TO BE WHAT THE COMPUTER ACTS ON. The computer does not act on the string
 * it is sent: it trims it and resolves it (`agent-computer/src/workspace.ts`, `resolvePath`), so
 * `"private/pay.csv "`, `"./private/pay.csv"`, `"private//pay.csv"` and `"private/pay.csv/."` are
 * one file there. Here they were four strings, and a rule was asked about whichever one a model
 * wrote: `matches(file.path, "^private/")` did not see `./private/…`, `file.name == ".env"` did not
 * see `.env/`, `file.extension == "exe"` did not see `tool.exe/.` or `tool.exe ` — and the row said
 * "allowed" under a path that is not the one that was read. The chat's door trimmed; a routine's
 * did not even do that (found by an independent read of the script act, 2026-10-07, in the reads a
 * script names, and then here in the Bot's own). Pressed on v0.5.17 in front of the real computer
 * with `deny: file.name == "pay.csv"`: three spellings read the file and one wrote over it.
 *
 * So `govern` reads every path this way, ONCE, before anything is decided, and hands the act the
 * same string to send: the policy, the question, an allowance's scope, the count of "the same
 * call again", the row and the computer all get one reading — the ends trimmed, `.` and empty
 * segments and a trailing slash gone.
 *
 * NULL IS ONE OF TWO THINGS, AND `govern` TELLS THEM APART.
 *
 * What the computer refuses as a path — blank, a NUL, an absolute path, a `..` segment. It has no
 * file behind it whatever a rule says, so it goes on exactly as it was written: judged as
 * written, sent as written, refused there (`laf:file_path_refused`), and on the trail as an act
 * that was allowed and did not happen, which is what it always was.
 *
 * And what the computer does NOT read one way ({@link hasNoOneReading}). That is refused here.
 */
export function workspacePathOf(requested: string): string | null {
  if (hasNoOneReading(requested)) return null;
  const wanted = requested.trim();
  if (wanted === "" || wanted.includes("\0") || wanted.startsWith("/")) {
    return null;
  }
  const segments = partsOf(wanted);
  if (segments.includes("..")) return null;
  // Nothing left is the folder itself, which is how a listing of the whole of it is asked for.
  return segments.length === 0 ? "." : segments.join("/");
}

/** The parts of a path that are names: what is left once `.` and empty segments are gone. */
function partsOf(trimmed: string): string[] {
  return trimmed.split("/").filter((part) => part !== "" && part !== ".");
}

/**
 * Whether a path is one the computer does not read one way — which no rule can be asked about,
 * so the gateway refuses it itself, with a row, before anything is sent (`govern`, beside the
 * floor for a page it has not seen: a rule that cannot be evaluated is not a rule that did not
 * fire).
 *
 * A BACKSLASH. The computer writes it as a letter of a name and READS it as a separator: its
 * read resolves the path with `realpath`, and Bun's reads `\` as `/`. Measured on the real
 * computer (Bun 1.3.14, 2026-10-07): with the payroll at `private/pay.csv`, `private\pay.csv`,
 * `\private/pay.csv` and `private/pay.csv\` each read it, a listing of `\` listed the whole
 * folder, and a write to `a\b.txt` made one file called that. A deny on `^private/` was walked
 * past by the first three on main and by every version of this change that read a backslash
 * either way (the third independent read). There is no reading of such a string that is the
 * computer's, because the computer has two. No name the product makes has one: an attachment's
 * and a download's are stripped of them (`safeAttachmentName`, `safeDownloadName`). A person can
 * mean one — on a Korean Windows keyboard the ₩ key types this character, so `견적_\10000.txt`
 * is a name somebody may ask for (the third independent read) — and it is refused all the same:
 * the model is told the character, and names the file another way. The computer refuses one
 * itself from the release this shipped in. Nothing readable is lost by that: a file
 * written as `a\b.txt` was never read back under that name (measured the same day: file not
 * found for a read and for a person's download — and once `a/b.txt` existed, the same string
 * read THAT file).
 *
 * WHITE SPACE AT THE EDGE OF A PATH'S FIRST OR LAST NAME. `"./ private/pay.csv"` is, to the
 * computer, a file in a folder called `" private"`; with the `./` gone it is a string the
 * computer trims into the payroll's own path. The first pushed version of this change spelled
 * it that way and read the guarded file; one that never left the laptop left it as written and
 * was walked past by `" private/pay.csv /"`; the second pushed version kept a `./` or a `/.` as
 * a mark and then had to trim names for a rule, which stopped a rule about a name with a space
 * in it from matching. A name like that can only be written to the computer behind a mark, so a
 * Bot does not name it at all. A person's own door hands such a string on as it was written,
 * as it always did (`person-files.ts`) — which reaches such a file only behind a mark, and no
 * screen writes one: true before this change too.
 */
export function hasNoOneReading(requested: string): boolean {
  if (requested.includes("\\")) return true;
  const parts = partsOf(requested.trim());
  const [first] = parts;
  const last = parts.at(-1);
  return (
    first !== undefined &&
    last !== undefined &&
    (first !== first.trimStart() || last !== last.trimEnd())
  );
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
