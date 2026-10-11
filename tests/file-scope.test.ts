import { describe, expect, test } from "bun:test";
import {
  type FileScope,
  fileScopeHeader,
  fileScopeOf,
  isBareFileName,
  isOlderThanItsFolder,
  isProjectFolderId,
  MAIN_SCOPE,
  olderCopyNameOf,
  PERSON_SCOPE,
  PROJECT_FOLDERS_SINCE,
  placedForWrite,
  projectScope,
  scopeLists,
  scopeRefusal,
} from "../shared/file-scope";

/**
 * WHOSE FILES A CALL MAY TOUCH, as a table (record §3, piece 4-2's second part).
 *
 * One case per row, because both halves read this one rule — the server to place a write, the
 * computer to refuse — and a row that changes is a project's file read from somewhere it should
 * not be, with every other test still green.
 */

const A = projectScope("channel_a");
const OWN = "projects/channel_a";
const OTHER = "projects/channel_b";

const REACH: readonly [
  string,
  FileScope,
  string,
  "read" | "write",
  string | null,
][] = [
  ["main reads its own file", MAIN_SCOPE, "notes.md", "read", null],
  ["main writes its own file", MAIN_SCOPE, "a/b/notes.md", "write", null],
  [
    "main reads no project's file",
    MAIN_SCOPE,
    `${OWN}/notes.md`,
    "read",
    "laf:file_other_project",
  ],
  [
    "main writes into no project",
    MAIN_SCOPE,
    `${OWN}/notes.md`,
    "write",
    "laf:file_other_project",
  ],
  [
    "main does not list the projects' folder",
    MAIN_SCOPE,
    "projects",
    "read",
    "laf:file_other_project",
  ],
  [
    "main is refused whatever the letters' case",
    MAIN_SCOPE,
    "Projects/channel_a/notes.md",
    "read",
    "laf:file_other_project",
  ],
  [
    "main is refused through a dot and a doubled slash",
    MAIN_SCOPE,
    "./projects//channel_a/notes.md",
    "read",
    "laf:file_other_project",
  ],
  ["a project reads its own file", A, `${OWN}/notes.md`, "read", null],
  ["a project writes its own file", A, `${OWN}/a/notes.md`, "write", null],
  ["a project reads the Bot's own folder", A, "attachments/x.md", "read", null],
  [
    "a project does not write the Bot's own folder",
    A,
    "attachments/x.md",
    "write",
    "laf:file_outside_project",
  ],
  [
    "a project reads no other project's file",
    A,
    `${OTHER}/notes.md`,
    "read",
    "laf:file_other_project",
  ],
  [
    "a project writes into no other project",
    A,
    `${OTHER}/notes.md`,
    "write",
    "laf:file_other_project",
  ],
  [
    "a project looks into the projects' folder for its own",
    A,
    "projects",
    "read",
    null,
  ],
  [
    "and writes nothing there",
    A,
    "projects",
    "write",
    "laf:file_other_project",
  ],
  [
    "a project's own folder is its own to the letter",
    A,
    "Projects/channel_a/notes.md",
    "read",
    "laf:file_other_project",
  ],
  [
    "a project whose id another's begins with is not that one",
    A,
    "projects/channel_ab/notes.md",
    "read",
    "laf:file_other_project",
  ],
  [
    "the person reads a project's file",
    PERSON_SCOPE,
    `${OWN}/n.md`,
    "read",
    null,
  ],
  ["the person writes anywhere", PERSON_SCOPE, `${OTHER}/n.md`, "write", null],
];

describe("what a scope may reach", () => {
  test.each(REACH)("%s", (_name, scope, path, touch, refusal) => {
    expect(scopeRefusal(scope, path, touch)).toBe(
      refusal as ReturnType<typeof scopeRefusal>,
    );
  });
});

const PLACED: readonly [string, FileScope, string, string | null][] = [
  [
    "main's write stays where it was named",
    MAIN_SCOPE,
    "a/notes.md",
    "a/notes.md",
  ],
  ["main's write into a project has no place", MAIN_SCOPE, `${OWN}/n.md`, null],
  ["a project's write goes in its folder", A, "notes.md", `${OWN}/notes.md`],
  ["with its folders", A, "보고서/9월.csv", `${OWN}/보고서/9월.csv`],
  ["less the dots and doubled slashes", A, "./a//b.md", `${OWN}/a/b.md`],
  ["one already there is left alone", A, `${OWN}/n.md`, `${OWN}/n.md`],
  ["another project's has no place", A, `${OTHER}/n.md`, null],
  ["nor one in the projects' folder itself", A, "projects", null],
  ["nor one spelled in other letters", A, "PROJECTS/channel_a/n.md", null],
  [
    "the person's write stays where it was named",
    PERSON_SCOPE,
    `${OTHER}/n.md`,
    `${OTHER}/n.md`,
  ],
];

describe("where a write goes", () => {
  test.each(PLACED)("%s", (_name, scope, path, placed) => {
    expect(placedForWrite(scope, path)).toBe(placed);
  });

  test("a placed write is one its scope may make", () => {
    for (const [, scope, path] of PLACED) {
      const placed = placedForWrite(scope, path);
      if (placed !== null)
        expect(scopeRefusal(scope, placed, "write")).toBe(null);
    }
  });
});

const LISTED: readonly [string, FileScope, string, boolean][] = [
  ["main is shown its own", MAIN_SCOPE, "notes.md", true],
  ["main is not shown the projects' folder", MAIN_SCOPE, "projects", false],
  ["a project is shown the way down to its own", A, "projects", true],
  ["and its own folder", A, OWN, true],
  ["and not another's", A, OTHER, false],
  ["the person is shown every project's", PERSON_SCOPE, OTHER, true],
];

describe("what a listing shows", () => {
  test.each(LISTED)("%s", (_name, scope, path, shown) => {
    expect(scopeLists(scope, path)).toBe(shown);
  });
});

const HEADERS: readonly [
  string,
  string | null | undefined,
  FileScope | null,
][] = [
  ["main", "main", MAIN_SCOPE],
  ["person", "person", PERSON_SCOPE],
  ["a project", "project:channel_a", A],
  ["with spaces round it", "  main ", MAIN_SCOPE],
  ["absent", undefined, null],
  ["null", null, null],
  ["empty", "", null],
  ["another word", "shared", null],
  ["other letters", "Main", null],
  ["a project with no id", "project:", null],
  ["a project whose id is a path", "project:../x", null],
  ["a project whose id has a slash", "project:a/b", null],
  ["a project whose id is two dots", "project:..", null],
];

describe("what a header names", () => {
  test.each(HEADERS)("%s", (_name, header, scope) => {
    expect(fileScopeOf(header)).toEqual(scope);
  });

  test.each([MAIN_SCOPE, PERSON_SCOPE, A])(
    "a scope survives the header: %j",
    (scope) => {
      expect(fileScopeOf(fileScopeHeader(scope))).toEqual(scope);
    },
  );
});

describe("a project's id as a folder's name", () => {
  test.each([
    ["channel_3f2c-9a", true],
    ["", false],
    [".", false],
    ["..", false],
    ["a/b", false],
    ["a b", false],
    ["가", false],
    ["x".repeat(81), false],
    [7, false],
    [undefined, false],
  ])("%j", (id, is) => {
    expect(isProjectFolderId(id)).toBe(is);
  });

  test("a scope is not made of anything else", () => {
    expect(() => projectScope("../x")).toThrow();
  });
});

describe("what a project filed before it had a folder", () => {
  test.each([
    ["uploads/2026-09-26-1a2b3c4d-매출.csv", "2026-09-26-1a2b3c4d-매출.csv"],
    ["uploads/a b (2).txt", "a b (2).txt"],
    // Filed since: in the project's folder, and gone with it.
    ["projects/channel_a/uploads/2026-10-11-1a2b3c4d-매출.csv", null],
    // One name in that one folder, and nothing else.
    ["uploads/deeper/x.csv", null],
    ["uploads/", null],
    ["uploads/..", null],
    ["uploads/.", null],
    ["Uploads/x.csv", null],
    ["./uploads/x.csv", null],
    ["notes.md", null],
    ["uploads/a\\b.csv", null],
    ["", null],
  ])("the name of %j is %j", (path, name) => {
    expect(olderCopyNameOf(path)).toBe(name);
  });

  test.each([
    ["x.csv", true],
    ["9월 정산 (2).csv", true],
    ["", false],
    [".", false],
    ["..", false],
    ["a/b", false],
    ["a\\b", false],
    ["a\0b", false],
    ["x".repeat(256), false],
    [7, false],
    [null, false],
  ])("%j is one file's name: %j", (name, is) => {
    expect(isBareFileName(name)).toBe(is);
  });
});

describe("a project older than its folder", () => {
  test.each([
    ["2026-09-01T00:00:00Z", true],
    [new Date("2026-10-10T16:07:46Z"), true],
    [PROJECT_FOLDERS_SINCE, false],
    ["2026-10-12T00:00:00Z", false],
    // Nothing to read is not "older": the sentence that says files stay is said of a known date.
    ["not a date", false],
  ])("made %j: %j", (madeAt, older) => {
    expect(isOlderThanItsFolder(madeAt)).toBe(older);
  });
});
