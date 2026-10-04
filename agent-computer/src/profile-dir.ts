/**
 * The profiles root on disk: which directory the deployment's browser opens, where a Bot's own
 * state goes, and the locks a browser that died leaves behind.
 */
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isBotId } from "./authorisation";
import { log } from "./log";

/**
 * Files Chromium uses to refuse a second instance on one profile.
 *
 * Swept on the way in rather than the way out, because the way out is the case that does not happen:
 * a container that is killed does not get to run cleanup. If this process is starting, no browser of
 * ours is running, so any lock here is by definition from a life that has already ended.
 */
const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

export const sweepLocks = async (dir: string): Promise<void> => {
  await Promise.all(
    SINGLETON_FILES.map((name) =>
      rm(join(dir, name), { force: true }).catch(() => undefined),
    ),
  );
};

/**
 * The file that records which directory under the profiles root the deployment's browser opens.
 *
 * A pointer rather than a fixed path, because an upgrade adopts a directory that already exists and
 * already holds somebody's logins. Written once, read every boot after: two boots must not disagree
 * about where the cookies are.
 */
const POINTER_FILE = "profile.json";

/**
 * The directory the shared profile gets when there is no per-Bot profile to take over.
 *
 * A dot in the name, deliberately: `isBotId` refuses any id with a dot in it, so no Bot anybody
 * creates can ever be called this and no per-Bot directory can ever collide with it. `bot.state`
 * below is dot-named for the same reason.
 */
export const DEFAULT_PROFILE_DIR = "shared.profile";

/** Where per-Bot state that is NOT the cookie jar lives: who has the wheel (`sessions.ts`). */
export const STATE_DIR = "bot.state";

/**
 * What a Chromium user-data directory has in it.
 *
 * Asked so that a directory holding nothing but `control.json` — a Bot that was driven before its
 * browser ever started — is not adopted as somebody's profile and reported as their logins.
 */
const PROFILE_MARKERS = ["Default", "Local State"];

/** Which directory the deployment's browser opens, and what taking it over cost. */
export type ProfileAdoption = {
  /** The directory the shared profile lives in, by name under the profiles root. */
  directory: string;
  /** The per-Bot profile it was taken over from, or null when a fresh one was made. */
  adoptedFrom: string | null;
  /** How many other per-Bot profiles were left exactly where they are. */
  kept: number;
};

const isAdoption = (value: unknown): value is ProfileAdoption =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ProfileAdoption).directory === "string" &&
  (value as ProfileAdoption).directory.length > 0;

/**
 * When a profile was last used, as well as the filesystem can say.
 *
 * The cookie database first: it is rewritten whenever a login changes, which is the closest thing on
 * disk to "this is the profile the person was actually using". The directory's own mtime is the
 * fallback, and it moves for any write at all — enough to order two profiles, not enough to be
 * trusted on its own.
 */
async function profileUsedAt(dir: string): Promise<number> {
  const candidates = [
    join(dir, "Default", "Cookies"),
    join(dir, "Default"),
    join(dir, "Local State"),
    dir,
  ];
  let newest = 0;
  for (const path of candidates) {
    const info = await stat(path).catch(() => null);
    if (info) newest = Math.max(newest, info.mtimeMs);
  }
  return newest;
}

async function looksLikeProfile(dir: string): Promise<boolean> {
  for (const marker of PROFILE_MARKERS) {
    if (await stat(join(dir, marker)).catch(() => null)) return true;
  }
  return false;
}

/**
 * Which directory the deployment's browser opens — TAKING OVER A PERSON'S LOGINS RATHER THAN
 * THROWING THEM AWAY.
 *
 * A machine upgrading into this change has a directory per Bot, each with cookies in it, and the
 * cheap thing to do would be to start a clean shared profile and let the person sign into their
 * bank, 홈택스 and 스마트스토어 again on the strength of a version bump. So instead: the profile that
 * was used most recently BECOMES the shared one, in place, and the rest are left exactly where they
 * are — untouched, not merged and not deleted, because merging two Chromium profiles is not a thing
 * that can be done safely and deleting them is the person's call, not an upgrade's. The choice is
 * written to the pointer file so every later boot agrees with this one, and `laf:profile_adopted`
 * puts it in front of the Bot that caused the first launch.
 *
 * `kept` counts what was left behind, so "why is 배민 still asking me to log in" has an answer: it is
 * signed in in one of those, and the way to move it is to sign in once on the shared browser.
 */
export async function resolveProfile(root: string): Promise<ProfileAdoption> {
  const pointed = await readFile(join(root, POINTER_FILE), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  if (isAdoption(pointed)) {
    // Field by field rather than handed back whole: the file also carries `at`, and a caller that
    // compared two resolutions would be comparing timestamps.
    return {
      directory: pointed.directory,
      adoptedFrom: pointed.adoptedFrom ?? null,
      kept: typeof pointed.kept === "number" ? pointed.kept : 0,
    };
  }

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates: { name: string; usedAt: number }[] = [];
  for (const entry of entries) {
    // Only a directory a Bot could have been called: `bot.state` and `shared.profile` carry a dot
    // and so can never be one, and neither can a stray file.
    if (!entry.isDirectory() || !isBotId(entry.name)) continue;
    const dir = join(root, entry.name);
    if (!(await looksLikeProfile(dir))) continue;
    candidates.push({ name: entry.name, usedAt: await profileUsedAt(dir) });
  }
  // Newest first, and by name when two are the same age, so an upgrade run twice on one machine
  // picks the same directory both times.
  candidates.sort(
    (a, b) => b.usedAt - a.usedAt || a.name.localeCompare(b.name),
  );

  const [newest] = candidates;
  const adoption: ProfileAdoption = newest
    ? {
        directory: newest.name,
        adoptedFrom: newest.name,
        kept: candidates.length - 1,
      }
    : { directory: DEFAULT_PROFILE_DIR, adoptedFrom: null, kept: 0 };
  await writePointer(root, adoption);
  return adoption;
}

/**
 * The decision, written down.
 *
 * Best effort: a root that cannot be written to is a broken deployment already, and refusing to give
 * anybody a browser over it would turn "the pointer did not save" into "nothing works". The
 * resolution above is deterministic anyway, so the next boot reaches the same answer by itself.
 */
export async function writePointer(
  root: string,
  adoption: ProfileAdoption,
): Promise<void> {
  await writeFile(
    join(root, POINTER_FILE),
    JSON.stringify({ ...adoption, at: new Date().toISOString() }),
    "utf8",
  ).catch((error: unknown) => {
    log.error("profile_pointer_not_saved", { reason: error });
  });
}
