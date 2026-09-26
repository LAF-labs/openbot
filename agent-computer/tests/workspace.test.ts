import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspace,
  RANGE_CHARS,
  WorkspaceFileError,
  WorkspacePathError,
} from "../src/workspace";

/**
 * The confinement, exercised against a real filesystem.
 *
 * Uses a real temporary directory rather than a mocked fs: two of the three layers of protection here
 * only mean anything against real inodes. A symlink test with a fake filesystem tests the fake.
 *
 * The escape attempts below are the ones an actual attempt would use, in the order it would use them,
 * and each one has to be tried with the guard in its shipping configuration. A deny-list test that
 * never runs with the escape hatch on proves nothing about the configuration people actually use.
 */

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "laf-workspace-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "a private key", "utf8");
});

afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

function workspace() {
  return createWorkspace(root);
}

describe("reading and writing inside the workspace", () => {
  test("writes a file and reads it back", async () => {
    const ws = workspace();
    const written = await ws.write("notes.md", "# Findings\nAll good.");
    expect(written).toMatchObject({ path: "notes.md", appended: false });

    const read = await ws.read("notes.md");
    expect(read.text).toBe("# Findings\nAll good.");
    expect(read.truncated).toBe(false);
  });

  test("creates parent directories inside the workspace", async () => {
    const ws = workspace();
    await ws.write("reports/august/summary.csv", "a,b\n1,2\n");
    expect((await ws.read("reports/august/summary.csv")).text).toBe(
      "a,b\n1,2\n",
    );
  });

  test("appends when asked, and overwrites when not", async () => {
    const ws = workspace();
    await ws.write("log.txt", "one\n");
    await ws.write("log.txt", "two\n", { append: true });
    expect((await ws.read("log.txt")).text).toBe("one\ntwo\n");

    await ws.write("log.txt", "fresh\n");
    expect((await ws.read("log.txt")).text).toBe("fresh\n");
  });

  test("a read is bounded and says so", async () => {
    const ws = createWorkspace(root, {
      readBytes: 10,
      writeBytes: 1000,
      listEntries: 500,
    });
    await ws.write("long.txt", "0123456789ABCDEF");
    const read = await ws.read("long.txt");
    expect(read.text).toBe("0123456789");
    expect(read.truncated).toBe(true);
    // The true size is reported even though the contents were cut, so the Bot can say so rather
    // than believing it has the whole file.
    expect(read.bytes).toBe(16);
  });

  /*
   * PAST THE CUT. A result over 20,000 characters is shown cut and filed whole in `.results/`, and a
   * plain read of that file is cut at the same place again: until 2026-09-25 nothing past the first
   * 20,000 characters of a filed result could be read at all. A range reads on from where it stopped.
   */
  test("a range reads on past the cut, in characters, and says whether more follows", async () => {
    const ws = workspace();
    // Korean is three bytes a character: a byte offset would land mid-letter.
    const filed = `${"가".repeat(20_000)}${"나".repeat(20_000)}끝`;
    await ws.write(".results/call_1.txt", filed);

    const head = await ws.read(".results/call_1.txt");
    expect(head.text.length).toBeLessThan(filed.length);
    expect(head.truncated).toBe(true);

    const next = await ws.read(".results/call_1.txt", { offset: 20_000 });
    expect(next.offset).toBe(20_000);
    expect(next.text).toBe("나".repeat(RANGE_CHARS));
    expect(next.truncated).toBe(true);

    const last = await ws.read(".results/call_1.txt", {
      offset: 40_000,
      limit: 5,
    });
    expect(last.text).toBe("끝");
    expect(last.truncated).toBe(false);

    const some = await ws.read(".results/call_1.txt", {
      offset: 19_998,
      limit: 4,
    });
    expect(some.text).toBe("가가나나");
    expect(some.truncated).toBe(true);
    expect(some.bytes).toBe(Buffer.byteLength(filed));
  });

  test("a range never hands back more than one step's worth", async () => {
    const ws = workspace();
    await ws.write("big.txt", "a".repeat(RANGE_CHARS * 3));
    const read = await ws.read("big.txt", {
      offset: 0,
      limit: RANGE_CHARS * 3,
    });
    expect(read.text.length).toBe(RANGE_CHARS);
    expect(read.truncated).toBe(true);
  });

  test("a write that exceeds the limit is refused before it touches the disk", async () => {
    const ws = createWorkspace(root, {
      readBytes: 1000,
      writeBytes: 8,
      listEntries: 500,
    });
    await expect(ws.write("big.txt", "far too long")).rejects.toThrow(
      WorkspaceFileError,
    );
    await expect(ws.read("big.txt")).rejects.toThrow();
  });

  test("reading something that is not there says so plainly", async () => {
    await expect(workspace().read("nope.txt")).rejects.toThrow(
      WorkspaceFileError,
    );
  });

  test("reading a directory is refused rather than returning nonsense", async () => {
    const ws = workspace();
    await ws.write("folder/file.txt", "x");
    await expect(ws.read("folder")).rejects.toThrow(WorkspaceFileError);
  });
});

describe("listing the workspace", () => {
  test("lists files and folders, recursively, relative to the root", async () => {
    const ws = workspace();
    await ws.write("notes.md", "top level");
    await ws.write("reports/august/summary.csv", "nested");

    const listing = await ws.list();
    const paths = listing.entries.map((e) => e.path).sort();
    // Folders included, so a Bot can see the shape rather than only the leaves.
    expect(paths).toEqual([
      "notes.md",
      "reports",
      "reports/august",
      "reports/august/summary.csv",
    ]);
    expect(listing.truncated).toBe(false);
  });

  test("reports sizes for files and marks folders", async () => {
    const ws = workspace();
    await ws.write("a/b.txt", "12345");
    const byPath = new Map((await ws.list()).entries.map((e) => [e.path, e]));
    expect(byPath.get("a")).toMatchObject({ kind: "folder" });
    expect(byPath.get("a/b.txt")).toMatchObject({ kind: "file", bytes: 5 });
  });

  test("an empty workspace lists nothing, rather than failing", async () => {
    // The behaviour that matters: a Bot must be able to tell "no files" from "I could not look".
    const listing = await workspace().list();
    expect(listing.entries).toEqual([]);
  });

  test("can list a subfolder", async () => {
    const ws = workspace();
    await ws.write("reports/one.txt", "1");
    await ws.write("elsewhere/two.txt", "2");
    const paths = (await ws.list("reports")).entries.map((e) => e.path);
    expect(paths).toEqual(["reports/one.txt"]);
  });

  test("listing is bounded and says when it was cut", async () => {
    const ws = createWorkspace(root, {
      readBytes: 1000,
      writeBytes: 1000,
      listEntries: 3,
    });
    for (const n of [1, 2, 3, 4, 5]) await ws.write(`f${n}.txt`, "x");
    const listing = await ws.list();
    expect(listing.entries).toHaveLength(3);
    expect(listing.truncated).toBe(true);
  });

  test("listing cannot escape the workspace either", async () => {
    await expect(workspace().list("../outside")).rejects.toThrow(
      WorkspacePathError,
    );
    await expect(workspace().list("/etc")).rejects.toThrow(WorkspacePathError);
  });

  test("listing a file rather than a folder says so", async () => {
    const ws = workspace();
    await ws.write("notes.md", "x");
    await expect(ws.list("notes.md")).rejects.toThrow(WorkspaceFileError);
  });
});

describe("escaping the workspace", () => {
  test.each([
    ["parent traversal", "../outside/secret.txt"],
    ["deep traversal", "../../../../etc/passwd"],
    ["traversal in the middle", "reports/../../outside/secret.txt"],
    ["absolute path", "/etc/passwd"],
    ["absolute path into the sibling", "/tmp"],
    ["backslash traversal", "..\\outside\\secret.txt"],
    ["bare parent", ".."],
  ])("refuses %s", async (_label, path) => {
    await expect(workspace().read(path)).rejects.toThrow(WorkspacePathError);
    await expect(workspace().write(path, "owned")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  test("refuses to read THROUGH a symlink that points outside", async () => {
    // The layer people miss. This path contains no "..", is not absolute, and resolves inside the
    // workspace lexically. Only following the link reveals where it goes.
    await symlink(join(outside, "secret.txt"), join(root, "innocent.txt"));
    await expect(workspace().read("innocent.txt")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  test("refuses to write THROUGH a symlinked directory that points outside", async () => {
    await symlink(outside, join(root, "escape"));
    await expect(workspace().write("escape/owned.txt", "x")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  test("refuses to write THROUGH a symlinked FILE that points outside, appending or not", async () => {
    // The name itself is the link: its folder is the workspace, so the folder check passes, and
    // `writeFile` followed the link out. Measured 2026-09-26: the file outside was overwritten.
    await symlink(join(outside, "secret.txt"), join(root, "innocent.txt"));
    const ws = workspace();
    await expect(ws.write("innocent.txt", "owned")).rejects.toThrow(
      WorkspacePathError,
    );
    await expect(
      ws.write("innocent.txt", "owned", { append: true }),
    ).rejects.toThrow(WorkspacePathError);
    expect(await Bun.file(join(outside, "secret.txt")).text()).toBe(
      "a private key",
    );
  });

  test("refuses a write through a link that points nowhere yet, which would create the file outside", async () => {
    await symlink(join(outside, "planted.txt"), join(root, "later.txt"));
    await expect(workspace().write("later.txt", "owned")).rejects.toThrow(
      WorkspacePathError,
    );
    expect(await Bun.file(join(outside, "planted.txt")).exists()).toBe(false);
  });

  test("a download is never saved through a link at the name it would take", async () => {
    // A dangling link where the download's name would go read as a free name (`stat` follows it), and
    // `saveAs` would have written through it to wherever it pointed.
    await mkdir(join(root, "downloads"), { recursive: true });
    await symlink(
      join(outside, "download-landed.pdf"),
      join(root, "downloads", "invoice.pdf"),
    );
    const saved = await workspace().saveDownload("invoice.pdf", async (to) => {
      await writeFile(to, "%PDF", "utf8");
    });
    expect(saved.path).toBe("downloads/invoice (2).pdf");
    expect(await Bun.file(join(outside, "download-landed.pdf")).exists()).toBe(
      false,
    );
  });

  test("a planted link is still removed as a link, never reaching what it points at", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "innocent.txt"));
    expect(await workspace().remove("innocent.txt")).toEqual({
      path: "innocent.txt",
      removed: true,
    });
    expect(await Bun.file(join(outside, "secret.txt")).text()).toBe(
      "a private key",
    );
  });

  test("a symlink pointing back INSIDE the workspace still works", async () => {
    // The guard must confine, not merely forbid symlinks: refusing every link would be easier and
    // would break legitimate use.
    const ws = workspace();
    await ws.write("real/data.txt", "inside");
    await symlink(join(root, "real"), join(root, "alias"));
    expect((await ws.read("alias/data.txt")).text).toBe("inside");
  });

  test("a sibling directory sharing the root's name prefix is still outside", async () => {
    // `/tmp/x/workspace-evil` shares a string prefix with `/tmp/x/workspace`, so a containment check
    // written with startsWith would let it through.
    const evil = `${root}-evil`;
    await mkdir(evil, { recursive: true });
    await writeFile(join(evil, "loot.txt"), "nope", "utf8");
    await expect(
      workspace().read("../workspace-evil/loot.txt"),
    ).rejects.toThrow(WorkspacePathError);
  });

  test("an empty or blank path is refused", async () => {
    await expect(workspace().read("")).rejects.toThrow(WorkspacePathError);
    await expect(workspace().write("   ", "x")).rejects.toThrow(
      WorkspacePathError,
    );
  });
});

describe("emptying the workspace when the account leaves", () => {
  test("removes every file and folder, keeps the folder, and never follows a link out", async () => {
    const ws = workspace();
    await ws.write("uploads/2026-09-26-1a2b3c4d-영수증.csv", "합계,12000\n");
    await ws.write(".results/call-1.txt", "a long result");
    await ws.write("notes.md", "memo");
    await symlink(outside, join(root, "escape"));

    expect(await ws.clear()).toBe(4);

    expect((await ws.list()).entries).toEqual([]);
    // The link went; what it pointed at, outside the workspace, did not.
    expect(await Bun.file(join(outside, "secret.txt")).text()).toBe(
      "a private key",
    );
  });
});

describe("removing one file a deleted Bot's attachment left", () => {
  test("removes the file and says so, and a second time says it was already gone", async () => {
    const ws = workspace();
    const path = "uploads/2026-09-26-1a2b3c4d-8월 매출.csv";
    await ws.write(path, "메뉴,수량\n아메리카노,42\n");
    await ws.write("uploads/2026-09-26-5e6f7a8b-다른 파일.csv", "a,b\n");

    expect(await ws.remove(path)).toEqual({ path, removed: true });
    expect(await Bun.file(join(root, path)).exists()).toBe(false);
    // Already gone is an answer, not a failure — the delete it belongs to has happened.
    expect(await ws.remove(path)).toEqual({ path, removed: false });
    expect(await ws.remove("uploads/never-was/x.csv")).toEqual({
      path: "uploads/never-was/x.csv",
      removed: false,
    });
    // Only that file: its neighbour in the same folder is somebody else's.
    expect(
      (await ws.list("uploads")).entries.map((entry) => entry.path),
    ).toEqual(["uploads/2026-09-26-5e6f7a8b-다른 파일.csv"]);
  });

  test("refuses a folder rather than emptying it", async () => {
    const ws = workspace();
    await ws.write("uploads/a.csv", "a\n");
    await expect(ws.remove("uploads")).rejects.toMatchObject({
      code: "laf:file_wrong_kind",
    });
    expect((await ws.read("uploads/a.csv")).text).toBe("a\n");
  });

  test("never reaches outside, by a path or through a link", async () => {
    const ws = workspace();
    for (const path of ["../outside/secret.txt", "/etc/passwd", ".."]) {
      await expect(ws.remove(path)).rejects.toThrow(WorkspacePathError);
    }
    await symlink(outside, join(root, "escape"));
    await expect(ws.remove("escape/secret.txt")).rejects.toThrow(
      WorkspacePathError,
    );
    // A link inside the workspace is removed as a link: what it pointed at stays.
    await symlink(join(outside, "secret.txt"), join(root, "innocent.txt"));
    expect(await ws.remove("innocent.txt")).toEqual({
      path: "innocent.txt",
      removed: true,
    });
    expect(await Bun.file(join(outside, "secret.txt")).text()).toBe(
      "a private key",
    );
  });
});
