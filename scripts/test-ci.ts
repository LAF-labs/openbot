/**
 * The test run: in a database of its own, with a floor under each part of it.
 *
 * Two separate guarantees live here.
 *
 * **The run never touches the database the application is using.** The suite writes to a real
 * Postgres, and some of it deletes rows by identity rather than by what it created — the boundary
 * policy row (`policy-durability.integration.test.ts`), every Google Drive connector instance
 * (`connector-admin.integration.test.ts`). Pointed at a developer's own database those deletions
 * land on their work, and nothing says so. So `DATABASE_URL` as given is read for its server and
 * its credentials and then never handed to a test: the tests run in `<name>_test` on the same
 * server, created here if it is absent and migrated exactly the way CI migrates.
 * `LAF_TEST_DB_SUFFIX` names a second one, so two worktrees can run the gate at the same time
 * without sharing a database.
 *
 * **A group of tests cannot go missing quietly.** A test file that throws while it is being
 * imported never runs its tests and never reports them as failures; the file is simply absent from
 * the totals. One floor over the whole monorepo could not see that at any useful resolution: at
 * ~1,330 tests, a floor with enough slack to survive a legitimate consolidation also had enough
 * slack to hide a whole mid-size server file. A floor per workspace is the same check at the size
 * of the thing being lost.
 *
 * The floors are floors and not exact numbers. Tests are added constantly, and a check that has to
 * be edited for every new test is a check people learn to edit without thinking.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Glob, SQL } from "bun";

const projectRoot = resolve(import.meta.dir, "..");

/**
 * THE FILES ARE COUNTED, NOT ONLY THE TESTS.
 *
 * MEASURED 2026-09-10 (audit A6, finding 4): `standing-approvals.integration.test.ts` — forty-one
 * tests, the largest integration file — was moved out of the tree and the gate passed, `server
 * 1770 / floor 1725`. The floors are 3% under what the tree measures, and 3% of the server suite is
 * more than any one of 141 of its 142 files. A floor catches a suite shrinking; it cannot see one
 * file going.
 *
 * So the files are listed. `scripts/test-manifest.json` is the committed list of every test file
 * the gate runs, and the two directions of disagreement are treated as the different things they are:
 *
 *  - A file in the list and not in the tree REFUSES THE RUN, before a database is touched. It was
 *    deleted or moved without anybody saying so — a rebase dropping it, most likely, since this
 *    repository stacks branches. Removing its line from the manifest, in the commit that removes the
 *    file, is how somebody says so; that line in the diff is the whole point.
 *  - A file in the tree and not in the list is a new test, and is ADDED to the manifest by the run,
 *    with a line saying to commit it. Adding a test is the common case, and a check that fails on the
 *    common case teaches everybody the command that makes it pass — which would be the same command
 *    that forgets a vanished file. Under CI the addition cannot be committed, so there it refuses.
 *
 * `bun scripts/test-ci.ts --update-manifest` rewrites the list from the tree in both directions, for
 * a deliberate rename of many files at once; it is the one command that forgets files, and it says so.
 *
 * And each file is checked to have run at least one test, off bun's own JUnit report: a file whose
 * tests were all removed, or that threw before registering any, is gone in every way that matters
 * and still present in every way the list can see. (A skipped test still counts as run: whether a
 * machine has Docker is not whether the file exists.)
 */
const MANIFEST = resolve(projectRoot, "scripts/test-manifest.json");

/**
 * One floor per workspace, each about 3% under what that workspace measures today.
 *
 * RE-RAISED 2026-09-03, on the run that typechecked the test directories. The four had been left
 * at what they measured on 2026-09-02 while five waves landed on top of them — settle, the Korean
 * question, the browser, the surface, the data lifecycle — and by this run the smallest gap was
 * agent-computer's 88 against 132, a floor that would have let a third of that workspace vanish
 * without the run going red. A floor whose margin has grown to 50% is not a floor, it is a number
 * in a comment.
 *
 * RE-RAISED AGAIN 2026-09-04, with the two partner connectors. 알림톡 and 세금계산서 brought
 * thirty-nine tests to `server` and eleven to `app` — three new files against fake vendors on
 * ephemeral ports, plus the partner half of `config` — and the two floors they landed on had drifted
 * to 14% under. `agent-computer` and `root` are untouched: neither grew.
 *
 * RE-RAISED AGAIN 2026-09-05, with the connection layer. Whether a connection still works, the
 * shell's own return page and the reason a connect failed brought thirty-four tests to `server`
 * (two new files and four on the callback), nine to `app` and three to `root`. `agent-computer` is
 * untouched: it did not grow.
 *
 * Measured on this tree, consecutive green runs of the whole gate agreeing exactly:
 *
 *     server           1,407 tests across 98 files   → 1,364
 *     app                289 tests across 39 files   →   280
 *     agent-computer     132 tests across  8 files   →   128
 *     root                78 tests across 12 files   →    75
 *                      ─────                            ─────
 *                      1,906                            1,847
 *
 * Each floor is 3% under, rounded down, which is the same margin they were introduced with: enough
 * that consolidating a handful of cases does not fail the run, small enough that a file which threw
 * on import and took its tests with it does. `root` counts its seven skipped tests and
 * `agent-computer` its two todos, because bun counts them and a floor that disagreed with the
 * number on the screen would be argued with rather than read.
 *
 * RAISED AGAIN 2026-09-05, with the 연결 screen. The rewrite brought twenty-eight tests: eighteen
 * to `app` (the overview query, what each kind of switch starts, and the source-walking guards that
 * keep a scope string and the word 관리자 off an owner's screen) and twelve to `server` (the
 * overview composition and turning a site off). Only `app` moved far enough to matter — its floor
 * had drifted to 9% under — so only `app` is re-raised:
 *
 *     app                298 tests across 42 files   →   289
 *
 * MEASURED TOGETHER 2026-09-05, once the 연결 screen and the connection-health work were on the
 * same branch: server 1419 → 1376, app 308 → 298 (3% under, rounded down); agent-computer and
 * root unchanged.
 *
 * LOWERED 2026-09-05, by the twenty-six tests 세금계산서(팝빌) took with it when the connector was
 * deleted (`partner-tax` 23, one listing case, two config cases): server 1376 → 1350, which is the
 * old floor minus exactly what was removed rather than a fresh 3% — a floor lowered further than
 * the deletion would forgive a file that threw on import in the same change.
 *
 * RAISED AGAIN 2026-09-05, with the Settings polish. Forty-four tests to `app`: the frame Settings
 * and Admin share (which link is lit, the width, and what the rail becomes below `lg`), the rows
 * that could not be acted on (a Notifications heading with no control, a Delete button live on one
 * character, a download that gave no sign of the press), and `PersonAvatar` — the first three
 * suites in this workspace that render React rather than walking source, because a picture URL
 * that 404s and a permission the browser will not re-prompt for are events, not markup:
 *
 *     app                352 tests across 44 files   →   341
 *
 * RAISED AGAIN 2026-09-05, with the generated Bot avatars. The thirty-five drawn mascots became a
 * seed grammar and a component, and twenty-four tests came with them: the round trip through the
 * grammar, four pinned hashes that say every existing Bot keeps its face, the markup the component
 * emits at every state and size, and the geometry that lets a `rounded-full` wrapper clip a face
 * without taking a bite out of it. `app` had drifted to 10% under; the other three did not grow.
 *
 *     app                332 tests across 43 files   →   322
 *
 * RAISED AGAIN 2026-09-06, with the first-task chips on a new Bot's empty conversation. Thirty-six
 * tests to `app`: which four sentences are offered for which connection state and which role, when
 * they are withheld, what a press reports, and a rendered press of each chip inside a memory-history
 * router — the first suite here that mounts a TanStack `Link`. `app` had drifted to 12% under; the
 * other three did not grow.
 *
 *     app                637 tests across 76 files   →   617
 *
 * MEASURED TOGETHER 2026-09-05, once 세금계산서 was gone and the Settings, avatar and Bot-creation
 * branches were on one branch: server 1395 → 1353, app 402 → 389 (3% under, rounded down);
 * agent-computer and root unchanged.
 *
 * MEASURED 2026-09-06, with the two i18n walks grown three tests: the tables `/admin` and the
 * audit trail read through `t(variable)`, and the gallery's card names, which no walk could see
 * before because `GALLERY_COMPONENTS` is built by `import.meta.glob` and is empty under bun.
 *
 *     app                403 tests across 49 files   →   390
 *
 * MEASURED 2026-09-06, after the Bots pane, Routines and Skills production pass: a josa helper with
 * its own walk of 받침/vowel/Latin/digit endings, the confirm dialog's contract, the routine form's
 * field order and day chips, the Skills failed-read state, and the page header the three sibling
 * pages now share.
 *
 *     app                459 tests across 55 files   →   445
 *
 * MEASURED 2026-09-06, with the production pass on the admin and 연결 screens. Forty-two tests to
 * `app`: how the audit trail collapses nine identical boot rows into one without ever folding a
 * refusal into the allows around it, the two label tables walked against the server's own event
 * list and the tool catalogue, the marks on 연결 walked against both catalogues in both directions,
 * the admin toggle groups' accessible state, the data functions' words, and the walk over the JSX
 * itself for English nobody ever asked the dictionary about. The
 * other three did not grow — the server work here was one prose string becoming a fact code, in a
 * test that already existed.
 *
 * Every wave lands on the same branch, so the floor is 3% under what all of them measure together
 * rather than under any one of them: the number in `GROUPS` is that combined measurement.
 *
 * MEASURED 2026-09-06, after the chat, rooms, roster and screen-pane pass: the group avatar's
 * geometry, the codes a failed turn is said in and their Korean, the room's empty state, the one
 * recipient picker, the roster's rail and row layout, the channel-events socket, the screen pane's
 * alignment and its frame decoding, and the approval and Home centring.
 *
 *     app                539 tests across 65 files   →   522
 *
 * MEASURED 2026-09-06, with all of the above on one branch and the admin/연결 pass rebased on top
 * of the chat one:
 *
 *     app                575 tests across 68 files   →   557
 *
 * MEASURED 2026-09-06, after the tool bridge (`shared/tools/bridge.ts`): what is never deferred
 * walked against every catalogue by name, `tool_search` over the adapters' own Korean, the
 * agent-bot loop's rounds and rewrites, and the eval harness reading a call the Bot service
 * answered itself. Thirty-five tests, all under root — the bridge is shared code and agent-bot.
 *
 *     root               113 tests across 14 files   →   109
 *
 * MEASURED 2026-09-06, with the log discipline (3-D) on top of the 1-B merge. The four had drifted
 * to between 6% and 26% under what the tree measures — `root` most, because the tool bridge and
 * the logger both landed there — so all four are re-raised to 3% under this run:
 *
 *     server           1,687 tests across 100 files  → 1,636
 *     app                601 tests across 70 files   →   582
 *     agent-computer     136 tests across  8 files   →   131
 *     root               147 tests across 18 files   →   142
 *
 * REBASED 2026-09-06 onto the first-task chips and 3-B: each floor is the higher of what the two
 * branches had measured, so `app` keeps the chips' 617 above rather than this run's 582.
 *
 * RAISED AGAIN 2026-09-06, with the help page and the 문의·의견 box, rebased onto 3-D and 2-B.
 * Twenty-eight tests to `server` (what the route keeps and refuses, the alert-webhook door and its
 * body, the feedback row's cascade, and the outbox's two rules about support rows) and thirty-seven
 * to `app` (the guide's five sections and every bold name against the dictionary, the body that
 * leaves the browser, the last failure a tab remembers). Measured on the rebased tree; `server` and
 * `app` are re-raised to 3% under, and the other two keep 3-D's floors, which are within 3% still:
 *
 *     server           1,775 tests across 139 files  → 1,721
 *     app                674 tests across 77 files   →   653
 *
 * The rule, unchanged: re-raise when the suite outgrows this one by the same margin.
 *
 * RE-RAISED 2026-09-06 after the 2-B follow-up (a hung site, partner grants for later Bots,
 * arguments checked before the approval, the screen pane's codes, the composer's caret) — measured
 * server 1,779 / app 661 / agent-computer 147 / root 156, each floor 3% under.
 *
 * RE-RAISED 2026-09-10, with the build and dependency audit (A7): the version route and its walk
 * of the footer, the Dockerfile digest pins, the server image's shape, what Dependabot watches,
 * the two overrides and the shell's version files. Measured server 1,808 / app 694 /
 * agent-computer 147 / root 176; `root` had drifted to 14% under and `server` and `app` past 3%,
 * so those three are re-raised to 3% under, and `agent-computer`, which did not grow, keeps its floor.
 *
 * RE-RAISED 2026-09-13, with the browser's sandbox, the navigation guard and the label hold (W1-d):
 * the sandbox's static half (launch args, `chromiumSandbox`, the image user, the compose profile and
 * volume hand-over), the per-hop floor and the name rules without a browser, and a real Chromium
 * refusing hops before they are sent, holding hops at a new host, holding a click to its label and
 * resetting a profile for good. Measured agent-computer 176, re-raised to 3% under; the other three
 * carry more than this wave's tests and are left to the measurement that has all of them.
 *
 * RE-RAISED 2026-09-13, with the app audit's fixes (W1-i): the retry that asks again in place, the
 * session door, the polls, the first screen, the live screen, a Bot's name in Korean and the
 * connection lines — rendered through the real route tree — and ten source walks rendered instead.
 * Measured app 768, re-raised to 3% under; the other three are not this change's to move.
 *
 * `roots` is a partition of the repository rather than a filter: a test file under none of them
 * fails the run instead of going uncounted, which is the same silence this whole script exists to
 * break.
 */
const GROUPS = [
  { name: "server", floor: 1753, roots: ["server"] },
  { name: "app", floor: 744, roots: ["app"] },
  { name: "agent-computer", floor: 170, roots: ["agent-computer"] },
  { name: "root", floor: 170, roots: ["tests", "agent-bot"] },
] as const;

/** The file names Bun itself treats as tests, so discovery here and discovery there agree. */
const TEST_FILE_GLOBS = [
  "**/*.{test,spec}.{js,jsx,ts,tsx}",
  "**/*_{test,spec}.{js,jsx,ts,tsx}",
];

function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

/** Never print a connection string with the password still in it; CI logs are readable. */
function redacted(url: URL): string {
  const copy = new URL(url);
  copy.password = "";
  return copy.toString();
}

// --- which files are tests, and whether they are all still here --------------------------------

/** Every test file in the tree, by the same names bun would find them under. */
async function discoverTestFiles(): Promise<Set<string>> {
  const found = new Set<string>();
  for (const pattern of TEST_FILE_GLOBS) {
    for await (const path of new Glob(pattern).scan({
      cwd: projectRoot,
      onlyFiles: true,
    })) {
      // Agent worktrees under .claude/ are whole checkouts; their tests are counted in their own runs.
      const parts = path.split("/");
      if (!parts.includes("node_modules") && !parts.includes(".claude"))
        found.add(path);
    }
  }
  return found;
}

const discovered = await discoverTestFiles();

/** The manifest, written the way `biome format` would leave it, so the gate's own write is clean. */
function writeManifest(paths: Iterable<string>): void {
  writeFileSync(
    MANIFEST,
    `${JSON.stringify([...new Set(paths)].sort(), null, 2)}\n`,
  );
}

if (process.argv.includes("--update-manifest")) {
  writeManifest(discovered);
  console.error(
    `${discovered.size} test files written to scripts/test-manifest.json, from the tree.\n` +
      "Any file that was listed and is not in the tree has been forgotten: read the diff before committing it.",
  );
  process.exit(0);
}

/*
 * Before the database is touched: a file that has gone missing is known from the tree alone, and a
 * run that will refuse anyway has no business creating databases first.
 */
let listed: string[];
try {
  listed = JSON.parse(readFileSync(MANIFEST, "utf8")) as string[];
} catch (error) {
  fail(
    `scripts/test-manifest.json could not be read: ${error instanceof Error ? error.message : String(error)}\n\n` +
      "Write it with `bun scripts/test-ci.ts --update-manifest`.",
  );
}
const listedSet = new Set(listed);
const vanished = listed.filter((path) => !discovered.has(path)).sort();
const unlisted = [...discovered].filter((path) => !listedSet.has(path)).sort();
if (vanished.length > 0) {
  fail(
    `${vanished.length} test file(s) are in scripts/test-manifest.json and not in the tree:\n` +
      `${vanished.map((path) => `  ${path}`).join("\n")}\n\n` +
      "A test file that disappears takes its tests with it, and the count floors cannot see one file\n" +
      "go. If it was deleted or renamed on purpose, remove its line from scripts/test-manifest.json in\n" +
      "the same commit. If it was not, it is missing: a rebase or a move dropped it.",
  );
}
if (unlisted.length > 0) {
  const listing = unlisted.map((path) => `  ${path}`).join("\n");
  if (process.env.CI) {
    fail(
      `${unlisted.length} test file(s) are in the tree and not in scripts/test-manifest.json:\n${listing}\n\n` +
        "A local run of the gate adds them; commit the manifest with the tests. A file the manifest\n" +
        "does not list is a file it cannot protect.",
    );
  }
  writeManifest([...listed, ...unlisted]);
  console.error(
    `\nAdded to scripts/test-manifest.json — commit it with the tests:\n${listing}\n`,
  );
}

// --- where the tests are allowed to write ------------------------------------------------------

const configuredDatabaseUrl = process.env.DATABASE_URL;
if (!configuredDatabaseUrl) {
  fail(
    "DATABASE_URL is not set. It is read for the server and the credentials only — the tests run in\n" +
      "a database derived from it, never in it. Set it to the database you develop against.",
  );
}
if (!URL.canParse(configuredDatabaseUrl)) {
  fail(
    "DATABASE_URL is not a URL, so no test database can be derived from it.",
  );
}

const sourceUrl = new URL(configuredDatabaseUrl);
const sourceDatabase = decodeURIComponent(sourceUrl.pathname.slice(1));
if (!sourceDatabase) {
  fail(
    "DATABASE_URL names no database, so no test database can be derived from it.",
  );
}

/*
 * The suffix reaches `CREATE DATABASE` as an identifier, so it is checked rather than trusted, and
 * held to the characters that need no thought about quoting.
 */
const suffix = process.env.LAF_TEST_DB_SUFFIX?.trim();
if (suffix && !/^[A-Za-z0-9_]+$/.test(suffix)) {
  fail(
    `LAF_TEST_DB_SUFFIX is "${suffix}". It becomes part of a database name, so it may only contain\n` +
      "letters, digits and underscores.",
  );
}

const testDatabase = `${sourceDatabase}_test${suffix ? `_${suffix}` : ""}`;
/*
 * PostgreSQL truncates an identifier at 63 bytes without complaining. Two worktrees whose suffixes
 * differ only past that point would silently share one database, which is the one thing the suffix
 * exists to prevent, so the truncation is refused instead of absorbed.
 */
if (new TextEncoder().encode(testDatabase).length > 63) {
  fail(
    `The test database would be named "${testDatabase}", which PostgreSQL would truncate to 63\n` +
      "bytes. Shorten LAF_TEST_DB_SUFFIX.",
  );
}

const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${encodeURIComponent(testDatabase)}`;

/** `postgres` is the database that is always there, and the only one another can be made from. */
const maintenanceUrl = new URL(sourceUrl);
maintenanceUrl.pathname = "/postgres";

const admin = new SQL(maintenanceUrl.toString(), { max: 1 });
try {
  const existing =
    await admin`select 1 from pg_database where datname = ${testDatabase}`;
  if (existing.length === 0) {
    // Quoted so a name with a hyphen or a capital works, and the quotes doubled because the name
    // comes out of DATABASE_URL rather than out of this file.
    await admin.unsafe(
      `create database "${testDatabase.replaceAll('"', '""')}"`,
    );
    console.error(`Created ${testDatabase}.`);
  }
  await admin.close();
} catch (error) {
  fail(
    `Could not reach ${redacted(maintenanceUrl)} to prepare the test database.\n` +
      `${error instanceof Error ? error.message : String(error)}\n\n` +
      "The gate needs a running PostgreSQL: `docker compose up -d postgres`.",
  );
}

/*
 * The same command CI runs, in the same directory, for the same reason it runs that one: the
 * `db:migrate` script loads ../.env, which does not exist in CI, and drizzle.config.ts already
 * reads DATABASE_URL.
 */
const migration = Bun.spawn(
  ["bunx", "drizzle-kit", "migrate", "--config=drizzle.config.ts"],
  {
    cwd: resolve(projectRoot, "server"),
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
    stdout: "inherit",
    stderr: "inherit",
  },
);
if ((await migration.exited) !== 0) {
  fail(`Migrating ${testDatabase} failed, so no tests were run.`);
}

// --- which tests belong under which floor ------------------------------------------------------

const owns = (roots: readonly string[], path: string) =>
  roots.some((root) => path.startsWith(`${root}/`));

const unclaimed = [...discovered]
  .filter((path) => !GROUPS.some((group) => owns(group.roots, path)))
  .sort();
if (unclaimed.length > 0) {
  fail(
    `${unclaimed.length} test file(s) belong to no group, so no floor is watching them:\n` +
      `${unclaimed.map((path) => `  ${path}`).join("\n")}\n\n` +
      "Add the directory to a group's `roots` in scripts/test-ci.ts.",
  );
}

// --- the runs ----------------------------------------------------------------------------------

type Outcome = {
  name: string;
  floor: number;
  count: number | null;
  status: number;
  /** The files in this group that the JUnit report says ran no test at all. */
  emptyFiles: string[];
};

const outcomes: Outcome[] = [];

/** Where bun writes each group's JUnit report; read once, then left for the OS to sweep. */
const reports = mkdtempSync(join(tmpdir(), "laf-test-ci-"));

/**
 * How many tests each file ran, off bun's JUnit report.
 *
 * The report nests a `<testsuite>` per `describe` inside the one per file, all carrying the file's
 * path; the outermost is the whole file's count, so the largest count seen for a path is the
 * file's. A file that threw on import is absent from the report altogether, which reads as zero.
 */
function testsPerFile(report: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of report.matchAll(
    /<testsuite\b[^>]*\bfile="([^"]+)"[^>]*\btests="(\d+)"/g,
  )) {
    const file = match[1] as string;
    const tests = Number.parseInt(match[2] as string, 10);
    counts.set(file, Math.max(counts.get(file) ?? 0, tests));
  }
  return counts;
}

/*
 * One group at a time. The groups share the one test database, and the deletions described at the
 * top of this file are exactly as destructive between two parallel groups as they were against a
 * developer's own database.
 *
 * Absolute paths, because Bun matches a positional argument as a substring of the file path and
 * `tests/workspace.test.ts` is a substring of `agent-computer/tests/workspace.test.ts`. Anchoring
 * at the repository root is what makes a group's file list mean only that group's files.
 */
for (const group of GROUPS) {
  /*
   * The group's files, decided ONCE and used for both the run and the check of what it ran.
   *
   * Measured, and not understood: computed a second time after the group's run, the same filter over
   * the same set answered with the previous group's files — `root` "owned" the 92 app files, all of
   * which then read as having run nothing — though `roots` printed correctly beside it and the same
   * code in isolation does not do it. One list, taken before anything is awaited, leaves nothing to
   * disagree.
   */
  const owned = [...discovered]
    .filter((path) => owns(group.roots, path))
    .sort();
  const files = owned.map((path) => resolve(projectRoot, path));

  console.error(`\n=== ${group.name} (${files.length} files) ===`);

  // `bun run test` rather than `bun test`, so the pretest hook fires and the generated application
  // config exists before route imports need it. `--silent` keeps a file list this long out of the
  // log without hiding anything bun itself reports. The JUnit report is written beside the console
  // output, not instead of it: bun keeps printing its summary, which is what the floors read.
  const report = join(reports, `${group.name}.xml`);
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "--silent",
      "test",
      "--reporter=junit",
      `--reporter-outfile=${report}`,
      ...files,
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: testUrl.toString() },
      stdout: "inherit",
      stderr: "pipe",
    },
  );

  // Bun writes its summary to stderr, so it is captured and echoed rather than inherited.
  const stderr = await new Response(proc.stderr).text();
  process.stderr.write(stderr);

  const status = await proc.exited;
  const ran = stderr.match(/Ran (\d+) tests? across/);

  let perFile = new Map<string, number>();
  try {
    perFile = testsPerFile(readFileSync(report, "utf8"));
  } catch {
    // No report at all is the same verdict for every file in the group, made below.
  }
  const emptyFiles = owned.filter((path) => (perFile.get(path) ?? 0) === 0);

  outcomes.push({
    name: group.name,
    floor: group.floor,
    count: ran ? Number.parseInt(ran[1] as string, 10) : null,
    status,
    emptyFiles,
  });
}

// --- the verdict -------------------------------------------------------------------------------

const problems: string[] = [];
for (const outcome of outcomes) {
  if (outcome.status !== 0) {
    problems.push(`${outcome.name}: tests failed (exit ${outcome.status}).`);
    continue;
  }
  if (outcome.count === null) {
    problems.push(
      `${outcome.name}: could not read how many tests ran from bun's output. Refusing to report a\n` +
        "  pass on a run that cannot be counted.",
    );
    continue;
  }
  if (outcome.count < outcome.floor) {
    problems.push(
      `${outcome.name}: ${outcome.count} tests ran, and at least ${outcome.floor} were expected.`,
    );
  }
  if (outcome.emptyFiles.length > 0) {
    problems.push(
      `${outcome.name}: ${outcome.emptyFiles.length} test file(s) ran no test at all:\n` +
        `${outcome.emptyFiles.map((path) => `    ${path}`).join("\n")}\n` +
        "  A file with nothing in it is gone in every way that matters. Give it a test or delete it\n" +
        "  and update the manifest.",
    );
  }
}

const table = outcomes
  .map(
    (outcome) =>
      `  ${outcome.name.padEnd(16)}${String(outcome.count ?? "?").padStart(5)} / floor ${outcome.floor}`,
  )
  .join("\n");

if (problems.length > 0) {
  console.error(
    `\n${problems.map((problem) => `- ${problem}`).join("\n")}\n\n${table}\n\n` +
      "A group under its floor with every test passing is not a failing test, it is a suite that got\n" +
      "smaller. The usual cause is a file that threw while being imported, which takes its tests with\n" +
      "it and reports nothing. Run `bun test` over that workspace and look for an unhandled error\n" +
      "between the file groups.\n\n" +
      "If tests were deliberately removed, lower that group's floor in scripts/test-ci.ts and say why.",
  );
  process.exit(1);
}

const total = outcomes.reduce((sum, outcome) => sum + (outcome.count ?? 0), 0);
console.error(`\n${total} tests ran in ${testDatabase}.\n${table}`);
