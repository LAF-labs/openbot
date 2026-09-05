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

import { resolve } from "node:path";
import { Glob, SQL } from "bun";

const projectRoot = resolve(import.meta.dir, "..");

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
 * The rule, unchanged: re-raise when the suite outgrows this one by the same margin.
 *
 * `roots` is a partition of the repository rather than a filter: a test file under none of them
 * fails the run instead of going uncounted, which is the same silence this whole script exists to
 * break.
 */
const GROUPS = [
  { name: "server", floor: 1353, roots: ["server"] },
  { name: "app", floor: 522, roots: ["app"] },
  { name: "agent-computer", floor: 128, roots: ["agent-computer"] },
  { name: "root", floor: 75, roots: ["tests", "agent-bot"] },
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

const discovered = new Set<string>();
for (const pattern of TEST_FILE_GLOBS) {
  for await (const path of new Glob(pattern).scan({
    cwd: projectRoot,
    onlyFiles: true,
  })) {
    // Agent worktrees under .claude/ are whole checkouts; their tests are counted in their own runs.
    const parts = path.split("/");
    if (!parts.includes("node_modules") && !parts.includes(".claude"))
      discovered.add(path);
  }
}

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
};

const outcomes: Outcome[] = [];

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
  const files = [...discovered]
    .filter((path) => owns(group.roots, path))
    .sort()
    .map((path) => resolve(projectRoot, path));

  console.error(`\n=== ${group.name} (${files.length} files) ===`);

  // `bun run test` rather than `bun test`, so the pretest hook fires and the generated application
  // config exists before route imports need it. `--silent` keeps a file list this long out of the
  // log without hiding anything bun itself reports.
  const proc = Bun.spawn(["bun", "run", "--silent", "test", ...files], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
    stdout: "inherit",
    stderr: "pipe",
  });

  // Bun writes its summary to stderr, so it is captured and echoed rather than inherited.
  const stderr = await new Response(proc.stderr).text();
  process.stderr.write(stderr);

  const status = await proc.exited;
  const ran = stderr.match(/Ran (\d+) tests? across/);
  outcomes.push({
    name: group.name,
    floor: group.floor,
    count: ran ? Number.parseInt(ran[1] as string, 10) : null,
    status,
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
