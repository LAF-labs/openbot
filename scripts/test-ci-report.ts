/**
 * Bun's JUnit report, read for the gate: how many tests each file ran, and which files ran none.
 *
 * A module of its own for two reasons. It can be tested without running the gate, which does its
 * whole job the moment `test-ci.ts` is imported. And the gate's loop reaches its verdict by calling
 * a function with values, never by making a function that reads the loop's own variables — why
 * that matters is written above the loop.
 */

/**
 * How many tests each file ran, keyed by the path bun writes: relative to the directory bun ran in.
 *
 * The report nests a `<testsuite>` per `describe` inside the one per file, all carrying the file's
 * path; the outermost is the whole file's count, so the largest count seen for a path is the
 * file's. A file that threw on import, or registered nothing, is absent from the report altogether.
 * Bun escapes `<`, `>`, `"` and `&` inside attribute values, so no test name can close a tag early
 * or bring a `file` or a `tests` of its own.
 */
export function testsPerFile(report: string): Map<string, number> {
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

export type FileVerdict = {
  /** The files, of those asked about, that the report says ran no test at all. */
  ranNothing: string[];
  /**
   * How many tests the report puts against the files asked about. Read whole and keyed the way the
   * files were named, it is the same number bun prints as `Ran N tests`, skipped ones included.
   */
  accounted: number;
};

/** What the report says about each of `files`. No report at all (`null`) says that nothing ran. */
export function fileVerdict(
  files: readonly string[],
  report: string | null,
): FileVerdict {
  const perFile =
    report === null ? new Map<string, number>() : testsPerFile(report);
  const ranNothing: string[] = [];
  let accounted = 0;
  for (const file of files) {
    const tests = perFile.get(file) ?? 0;
    accounted += tests;
    if (tests === 0) ranNothing.push(file);
  }
  return { ranNothing, accounted };
}

/**
 * How long each file's tests took, in seconds, keyed as `testsPerFile` keys them.
 *
 * The sum of its test cases' own times: what the file costs a worker once its modules are loaded.
 * Read for `scripts/test-durations.json`, which spreads the files over the workers; nothing judges
 * a run by it.
 */
export function secondsPerFile(report: string): Map<string, number> {
  const seconds = new Map<string, number>();
  for (const match of report.matchAll(/<testcase\b([^>]*)>/g)) {
    const attributes = match[1] as string;
    const file = /\bfile="([^"]+)"/.exec(attributes)?.[1];
    const time = Number.parseFloat(
      /\btime="([0-9.eE+-]+)"/.exec(attributes)?.[1] ?? "",
    );
    if (!file || !Number.isFinite(time)) continue;
    seconds.set(file, (seconds.get(file) ?? 0) + time);
  }
  return seconds;
}

/**
 * The files spread over `bins` lists whose times are as even as the files allow.
 *
 * Longest first, each into the list that is shortest so far — what a scheduler calls LPT, never
 * more than a third over the best spread there is. A file with no time of its own is given the
 * middle one of the times there are: a new file is an ordinary file until it has been measured.
 * Lists that would be empty are not made, and each list keeps its files in path order, which is
 * the order bun would have run them in.
 */
export function spread(
  files: readonly string[],
  seconds: ReadonlyMap<string, number>,
  bins: number,
): string[][] {
  const known = [...seconds.values()].sort((a, b) => a - b);
  const typical = known.length > 0 ? (known[known.length >> 1] as number) : 1;
  const weighed = files
    .map((file) => ({ file, weight: seconds.get(file) ?? typical }))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
  const lists = Array.from(
    { length: Math.max(1, Math.min(bins, files.length)) },
    () => ({
      files: [] as string[],
      total: 0,
    }),
  );
  for (const { file, weight } of weighed) {
    let shortest = lists[0] as (typeof lists)[number];
    for (const list of lists) if (list.total < shortest.total) shortest = list;
    shortest.files.push(file);
    shortest.total += weight;
  }
  return lists
    .filter((list) => list.files.length > 0)
    .map((list) => list.files.sort());
}
