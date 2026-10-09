/**
 * THE FOLDER, THE SPELLINGS AND THE RULES that the path a rule judges is held by — moved here from
 * `gateway-file-paths.test.ts`, word for word, so that a second caller of `govern` with paths of
 * its own to read (a script's run, `workbench-gateway.test.ts`) is held by the very same list
 * and not by a copy that the next spelling somebody thinks of is added to one of.
 *
 * Nothing here is a test. A spelling, a rule or a file added here is added to every test that
 * walks them.
 */
import { join } from "node:path";

/** What each file in the folder holds, so that what was read says WHICH file was read. */
export const PAYROLL = "[the payroll]";
export const IN_A_SPACED_FOLDER =
  "[pay.csv, in a folder whose name begins with a space]";
export const A_SPACED_NAME =
  "[a file whose name ends with a space, in private/]";
export const SECRET = "[the secret]";
export const NOTE = "[a note]";
/** Every file the folder starts with, by where it is. */
export const FILES = [
  [join("private", "pay.csv"), PAYROLL],
  [join(" private", "pay.csv"), IN_A_SPACED_FOLDER],
  [join("private", "pay.csv "), A_SPACED_NAME],
  [".env", SECRET],
  [join("notes", "a.md"), NOTE],
] as const;

/** Every way a model, a slip or a page that wants a rule walked past might write one path. */
export function spellingsOf(core: string): string[] {
  const before = [
    "",
    " ",
    "\t",
    "\n",
    "\u00a0",
    "./",
    "./ ",
    "./\n",
    "./\u3000",
    " ./",
    ".//",
    "./ ./ ",
    "\\",
    ".\\",
  ];
  const after = [
    "",
    " ",
    "\n",
    "\u3000",
    "/",
    "/.",
    "/./",
    " /",
    " /.",
    "\n/.",
    "/ ",
    "/. ",
    "\\",
    "\\.",
  ];
  return before.flatMap((head) => after.map((tail) => `${head}${core}${tail}`));
}

export const CORES = [
  "private/pay.csv",
  "private//pay.csv",
  "private/./pay.csv",
  "private\\pay.csv",
  "private\\.\\pay.csv",
  " private/pay.csv",
  "private/pay.csv ",
  "private / pay.csv",
  ".env",
  "notes/a.md",
  "private",
  " private",
  ".",
] as const;
export const EVERY_SPELLING = CORES.flatMap(spellingsOf);

/**
 * The time a test that walks every spelling is given.
 *
 * Each walk is thousands of real calls — through the gateway's policy, onto a folder on disk, into a
 * fake computer — about a second and a half alone. The gate runs four files at once on four cores
 * (`scripts/test-ci.ts`), and there one rule's walk took the default five seconds to the
 * millisecond while three other workers wrote to their databases (measured 2026-10-09). The work is
 * real and the loop has no wait in it to remove, so the walks are split one rule to a test and given
 * this, rather than the five seconds meant for a test that does one thing.
 */
export const SPELLING_WALK_MS = 30_000;

/** None of these is a path in the folder: each is something the computer refuses as one. */
export const NOT_A_PATH = [
  "/etc/passwd",
  "..",
  "a/../b",
  "private/../../etc/passwd",
  "a\0b",
] as const;

/** The four ways a rule about the payroll gets written. */
export const RULES = [
  'matches(file.path, "^private/")',
  'file.path == "private/pay.csv"',
  'file.name == "pay.csv"',
  'file.extension == "csv"',
] as const;
