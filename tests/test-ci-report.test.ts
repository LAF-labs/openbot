import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileVerdict,
  secondsPerFile,
  spread,
  testsPerFile,
} from "../scripts/test-ci-report";

/**
 * How the gate reads bun's JUnit report, against a report bun writes here and now.
 *
 * Not a saved fixture: if what bun writes changes, this file should fail, rather than every group
 * of the gate at once under a message about files that ran nothing. The files are run the way the
 * gate runs a group — by absolute path, from the directory the report's paths are relative to.
 */

/** Names that would close a tag, or bring a `file` and a `tests` of their own, were they not escaped. */
const NAMES = `import { describe, expect, test } from "bun:test";

describe('closes > opens < quotes " and &', () => {
  test('</testsuite><testsuite file="forged.test.ts" tests="99">', () => {
    expect(1).toBe(1);
  });
  describe("nested > again", () => {
    test.skip("skipped", () => {});
    test.todo("to do");
  });
});

test("한국어 이름", () => {});
`;

/** What a file whose tests were all removed looks like to bun: it registers nothing. */
const NOTHING = `import { describe } from "bun:test";

describe("holds no test", () => {});
`;

let dir = "";
let report = "";
let ran = -1;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "laf-junit-"));
  writeFileSync(join(dir, "names.test.ts"), NAMES);
  writeFileSync(join(dir, "nothing.test.ts"), NOTHING);
  const outfile = join(dir, "report.xml");
  const proc = Bun.spawn(
    [
      "bun",
      "test",
      "--reporter=junit",
      `--reporter-outfile=${outfile}`,
      join(dir, "names.test.ts"),
      join(dir, "nothing.test.ts"),
    ],
    { cwd: dir, stdout: "ignore", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`bun test failed:\n${stderr}`);
  ran = Number(stderr.match(/Ran (\d+) tests? across/)?.[1] ?? -1);
  report = readFileSync(outfile, "utf8");
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the gate's reading of bun's JUnit report", () => {
  test("a file's count is its outermost suite, skipped and to-do tests included, and no name forges a file", () => {
    expect(testsPerFile(report)).toEqual(new Map([["names.test.ts", 4]]));
  });

  test("a file that registered nothing is named, and the report accounts for exactly what bun counted", () => {
    expect(fileVerdict(["names.test.ts", "nothing.test.ts"], report)).toEqual({
      ranNothing: ["nothing.test.ts"],
      accounted: 4,
    });
    expect(ran).toBe(4);
  });

  test("no report at all names every file, and accounts for none of bun's count", () => {
    expect(fileVerdict(["names.test.ts", "nothing.test.ts"], null)).toEqual({
      ranNothing: ["names.test.ts", "nothing.test.ts"],
      accounted: 0,
    });
  });

  test("paths named otherwise than bun wrote them account for nothing, so the count exposes them", () => {
    expect(fileVerdict([join(dir, "names.test.ts")], report)).toEqual({
      ranNothing: [join(dir, "names.test.ts")],
      accounted: 0,
    });
  });
});

describe("the time each file takes, and the files spread over the workers by it", () => {
  test("a file's time is the sum of its tests' own, and a name forges no file", () => {
    const seconds = secondsPerFile(report);
    expect([...seconds.keys()]).toEqual(["names.test.ts"]);
    expect(seconds.get("names.test.ts")).toBeGreaterThanOrEqual(0);
    expect(
      secondsPerFile(
        '<testcase name="a" time="1.5" file="x.test.ts" /><testcase name="b" file="x.test.ts" time="0.25" />',
      ),
    ).toEqual(new Map([["x.test.ts", 1.75]]));
  });

  test("the longest go first, each to the shortest list, and no list is left over-full", () => {
    const seconds = new Map([
      ["a.test.ts", 40],
      ["b.test.ts", 30],
      ["c.test.ts", 20],
      ["d.test.ts", 10],
      ["e.test.ts", 10],
    ]);
    // 40 | 30+10 | 20+10, each list in path order: nobody waits on a list a later file could have evened.
    expect(
      spread(
        ["e.test.ts", "d.test.ts", "c.test.ts", "b.test.ts", "a.test.ts"],
        seconds,
        3,
      ),
    ).toEqual([
      ["a.test.ts"],
      ["b.test.ts", "e.test.ts"],
      ["c.test.ts", "d.test.ts"],
    ]);
  });

  test("a file never measured counts as the middle time, and no list is made empty", () => {
    const seconds = new Map([
      ["slow.test.ts", 9],
      ["mid.test.ts", 5],
      ["quick.test.ts", 1],
    ]);
    // `new` weighs 5, the middle time: it joins `mid`, and `quick` evens `slow`. 10 and 10.
    expect(
      spread(
        ["slow.test.ts", "new.test.ts", "mid.test.ts", "quick.test.ts"],
        seconds,
        2,
      ),
    ).toEqual([
      ["quick.test.ts", "slow.test.ts"],
      ["mid.test.ts", "new.test.ts"],
    ]);
    expect(spread(["only.test.ts"], seconds, 4)).toEqual([["only.test.ts"]]);
    expect(spread(["x.test.ts", "y.test.ts"], new Map(), 4)).toEqual([
      ["x.test.ts"],
      ["y.test.ts"],
    ]);
  });
});
