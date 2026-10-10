import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAIN_SCOPE,
  PERSON_SCOPE,
  projectScope,
} from "../../shared/file-scope";
import { createWorkspace } from "../src/workspace";

/**
 * A PROJECT'S FOLDER, ON A REAL DISK (record §3, piece 4-2's second part).
 *
 * The rule's table is `tests/file-scope.test.ts`. This is the folder holding to it at every way
 * in — a read, a listing, a write, a put, a file handed to a page, a download landing — and at
 * the one way round a rule about names: a link.
 */

const A = projectScope("channel_a");
const B = projectScope("channel_b");

let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "laf-workspace-scope-"));
  root = join(base, "workspace");
  await mkdir(join(root, "projects", "channel_a"), { recursive: true });
  await mkdir(join(root, "projects", "channel_b"), { recursive: true });
  await writeFile(join(root, "notes.md"), "the Bot's own");
  await writeFile(join(root, "projects", "channel_a", "plan.md"), "A's plan");
  await writeFile(join(root, "projects", "channel_b", "plan.md"), "B's plan");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const refused = (work: () => Promise<unknown>) =>
  work().then(
    () => "came back",
    (error: { code?: string }) => error.code ?? "threw something else",
  );

async function* bytesOf(text: string) {
  yield new TextEncoder().encode(text);
}

/** Every way a file is reached without being written, as one list a scope is walked down. */
const READS = (
  ws: ReturnType<typeof createWorkspace>,
  path: string,
): [string, () => Promise<unknown>][] => [
  ["read", () => ws.read(path)],
  ["stat", () => ws.stat(path)],
  ["download", () => ws.download(path)],
  ["whole", () => ws.whole(path)],
  ["a file for a page", () => ws.resolvePath(path, false)],
];

describe("the main conversation", () => {
  test.each(["read", "stat", "download", "whole", "a file for a page"])(
    "does not reach a project's file by %s",
    async (name) => {
      const ws = createWorkspace(root).within(MAIN_SCOPE);
      const [, work] =
        READS(ws, "projects/channel_a/plan.md").find(([way]) => way === name) ??
        [];
      expect(await refused(work as () => Promise<unknown>)).toBe(
        "laf:file_path_refused",
      );
    },
  );

  test("writes and puts nothing into a project's folder, and what is there is as it was", async () => {
    const ws = createWorkspace(root).within(MAIN_SCOPE);
    expect(
      await refused(() => ws.write("projects/channel_a/plan.md", "main's")),
    ).toBe("laf:file_path_refused");
    expect(
      await refused(() => ws.put("projects/channel_a/new.bin", bytesOf("x"))),
    ).toBe("laf:file_path_refused");
    expect(await readdir(join(root, "projects", "channel_a"))).toEqual([
      "plan.md",
    ]);
    expect(
      await readFile(join(root, "projects", "channel_a", "plan.md"), "utf8"),
    ).toBe("A's plan");
  });

  test("is shown its own folder with no projects in it, and may not list theirs", async () => {
    const ws = createWorkspace(root).within(MAIN_SCOPE);
    const listed = await ws.list();
    expect(listed.entries.map((entry) => entry.path)).toEqual(["notes.md"]);
    expect(await refused(() => ws.list("projects"))).toBe(
      "laf:file_path_refused",
    );
    expect(await refused(() => ws.list("projects/channel_a"))).toBe(
      "laf:file_path_refused",
    );
  });

  test("does not reach a project's file through a link in its own folder", async () => {
    await symlink(
      join(root, "projects", "channel_a", "plan.md"),
      join(root, "innocent.md"),
    );
    await symlink(join(root, "projects", "channel_a"), join(root, "shortcut"));
    const ws = createWorkspace(root).within(MAIN_SCOPE);
    for (const path of ["innocent.md", "shortcut/plan.md"]) {
      for (const [way, work] of READS(ws, path)) {
        expect(`${path} · ${way} · ${await refused(work)}`).toBe(
          `${path} · ${way} · laf:file_path_refused`,
        );
      }
    }
    expect(await refused(() => ws.write("shortcut/new.md", "main's"))).toBe(
      "laf:file_path_refused",
    );
    expect(await readdir(join(root, "projects", "channel_a"))).toEqual([
      "plan.md",
    ]);
  });

  test("still reads and writes everything that is its own", async () => {
    const ws = createWorkspace(root).within(MAIN_SCOPE);
    expect((await ws.read("notes.md")).text).toBe("the Bot's own");
    await ws.write("보고서/9월.md", "매출");
    expect(await readFile(join(root, "보고서", "9월.md"), "utf8")).toBe("매출");
  });
});

describe("a project", () => {
  test("reads and writes its own folder", async () => {
    const ws = createWorkspace(root).within(A);
    expect((await ws.read("projects/channel_a/plan.md")).text).toBe("A's plan");
    await ws.write("projects/channel_a/out/report.md", "done");
    await ws.put("projects/channel_a/out/data.bin", bytesOf("bytes"));
    expect(
      (await readdir(join(root, "projects", "channel_a", "out"))).sort(),
    ).toEqual(["data.bin", "report.md"]);
  });

  test("reads the Bot's own folder and writes nothing there", async () => {
    const ws = createWorkspace(root).within(A);
    expect((await ws.read("notes.md")).text).toBe("the Bot's own");
    expect(await refused(() => ws.write("notes.md", "A's"))).toBe(
      "laf:file_path_refused",
    );
    expect(await refused(() => ws.write("new.md", "A's"))).toBe(
      "laf:file_path_refused",
    );
    expect(await refused(() => ws.put("new.bin", bytesOf("x")))).toBe(
      "laf:file_path_refused",
    );
    expect(await readFile(join(root, "notes.md"), "utf8")).toBe(
      "the Bot's own",
    );
    expect((await readdir(root)).sort()).toEqual(["notes.md", "projects"]);
  });

  test.each(["read", "stat", "download", "whole", "a file for a page"])(
    "does not reach another project's file by %s",
    async (name) => {
      const ws = createWorkspace(root).within(A);
      const [, work] =
        READS(ws, "projects/channel_b/plan.md").find(([way]) => way === name) ??
        [];
      expect(await refused(work as () => Promise<unknown>)).toBe(
        "laf:file_path_refused",
      );
    },
  );

  test("writes nothing into another project's folder", async () => {
    const ws = createWorkspace(root).within(A);
    expect(
      await refused(() => ws.write("projects/channel_b/plan.md", "A's")),
    ).toBe("laf:file_path_refused");
    expect(
      await readFile(join(root, "projects", "channel_b", "plan.md"), "utf8"),
    ).toBe("B's plan");
  });

  test("is shown the Bot's folder and its own, and no other project's name", async () => {
    const ws = createWorkspace(root).within(A);
    const listed = await ws.list();
    const paths = listed.entries.map((entry) => entry.path).sort();
    expect(paths).toContain("notes.md");
    expect(paths).toContain("projects/channel_a/plan.md");
    expect(JSON.stringify(listed)).not.toContain("channel_b");
    const inside = await ws.list("projects");
    expect(JSON.stringify(inside)).not.toContain("channel_b");
    expect(await refused(() => ws.list("projects/channel_b"))).toBe(
      "laf:file_path_refused",
    );
  });

  test("does not reach another project's file through a link in its own folder", async () => {
    await symlink(
      join(root, "projects", "channel_b"),
      join(root, "projects", "channel_a", "neighbour"),
    );
    const ws = createWorkspace(root).within(A);
    for (const [way, work] of READS(
      ws,
      "projects/channel_a/neighbour/plan.md",
    )) {
      expect(`${way} · ${await refused(work)}`).toBe(
        `${way} · laf:file_path_refused`,
      );
    }
    expect(
      await refused(() =>
        ws.write("projects/channel_a/neighbour/new.md", "A's"),
      ),
    ).toBe("laf:file_path_refused");
    expect(await readdir(join(root, "projects", "channel_b"))).toEqual([
      "plan.md",
    ]);
  });
});

describe("a download", () => {
  test("lands in the folder of the scope that was asking, two at once each in its own", async () => {
    const landedA = join(base, "landed-a");
    const landedB = join(base, "landed-b");
    const landedMain = join(base, "landed-main");
    await writeFile(landedA, "for A");
    await writeFile(landedB, "for B");
    await writeFile(landedMain, "for main");
    const ws = createWorkspace(root);

    // One queue lands them in turn (`oneAtATime`): whose each is must survive the wait.
    const saved = await Promise.all([
      ws.within(A).saveDownload("정산.csv", landedA),
      ws.within(B).saveDownload("정산.csv", landedB),
      ws.within(MAIN_SCOPE).saveDownload("정산.csv", landedMain),
    ]);

    expect(saved.map((file) => file.path)).toEqual([
      "projects/channel_a/downloads/정산.csv",
      "projects/channel_b/downloads/정산.csv",
      "downloads/정산.csv",
    ]);
    expect(
      await readFile(
        join(root, "projects", "channel_a", "downloads", "정산.csv"),
        "utf8",
      ),
    ).toBe("for A");
    expect(
      await readFile(
        join(root, "projects", "channel_b", "downloads", "정산.csv"),
        "utf8",
      ),
    ).toBe("for B");
    expect(await readFile(join(root, "downloads", "정산.csv"), "utf8")).toBe(
      "for main",
    );
  });
});

describe("the person", () => {
  test("reads every project's file and is shown them all", async () => {
    const ws = createWorkspace(root).within(PERSON_SCOPE);
    expect((await ws.read("projects/channel_b/plan.md")).text).toBe("B's plan");
    const listed = await ws.list();
    const paths = listed.entries.map((entry) => entry.path);
    expect(paths).toContain("projects/channel_a/plan.md");
    expect(paths).toContain("projects/channel_b/plan.md");
  });
});

describe("a project's folder, removed", () => {
  test("goes with everything in it, and nothing beside it does", async () => {
    const ws = createWorkspace(root);
    await ws.within(A).write("projects/channel_a/out/deep/report.md", "done");

    expect(await ws.removeProject("channel_a")).toBe(true);

    expect(await readdir(join(root, "projects"))).toEqual(["channel_b"]);
    expect(await readFile(join(root, "notes.md"), "utf8")).toBe(
      "the Bot's own",
    );
    // Asked again — the clock's second attempt — there is nothing, and that is an answer.
    expect(await ws.removeProject("channel_a")).toBe(false);
  });

  test.each(["..", ".", "channel_a/..", "a/b", ""])(
    "is named by an id and nothing else: %j",
    async (id) => {
      const ws = createWorkspace(root);
      expect(await refused(() => ws.removeProject(id))).toBe(
        "laf:file_path_refused",
      );
      expect((await readdir(join(root, "projects"))).sort()).toEqual([
        "channel_a",
        "channel_b",
      ]);
      expect(await readFile(join(root, "notes.md"), "utf8")).toBe(
        "the Bot's own",
      );
    },
  );

  test("a link standing where the folder would be is removed, and what it led to is not", async () => {
    await rm(join(root, "projects", "channel_a"), { recursive: true });
    await symlink(
      join(root, "projects", "channel_b"),
      join(root, "projects", "channel_a"),
    );

    await createWorkspace(root).removeProject("channel_a");

    expect(await readdir(join(root, "projects"))).toEqual(["channel_b"]);
    expect(await readdir(join(root, "projects", "channel_b"))).toEqual([
      "plan.md",
    ]);
  });
});
