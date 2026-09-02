/**
 * The Bot's files, and the boundary they must not escape.
 *
 * The computer has a `/workspace` volume so that anything a Bot should still have next week
 * survives the container. A Bot can read and write in it, which turns a durable directory into an
 * attack surface: the process runs as root inside its container, so `write_file("../../etc/passwd")`
 * is the obvious first thing to try and `read_file("../../root/.ssh/id_rsa")` the second.
 *
 * Path confinement is enforced in three layers:
 *
 *  1. Absolute paths are refused outright. A Bot names a file relative to its own workspace; there is
 *     no legitimate request that begins with `/`.
 *  2. The resolved path must be inside the root lexically. This catches `..` traversal.
 *  3. The resolved path must still be inside the root after symlinks are followed. This is the layer
 *     people miss: a symlink placed inside the workspace (by an earlier write, or by a page the Bot
 *     downloaded something from) passes the lexical check and then points anywhere on the filesystem.
 *     For a write, the file may not exist yet, so it is the deepest existing ancestor that gets
 *     resolved, which is the directory the write will actually land in.
 *
 * A factory taking its root as an argument rather than reading the environment, so the confinement
 * can be tested against a temporary directory instead of being taken on trust.
 */
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export class WorkspaceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}

export type WorkspaceLimits = {
  /**
   * Most bytes a read hands back.
   *
   * Bounded for the same reason page text is: the contents go into a model's context, and one large
   * file would push the rest of the conversation out of it.
   */
  readBytes: number;
  /** Most bytes a single write accepts, so a loop cannot fill the volume. */
  writeBytes: number;
  /** Most entries a listing describes, so a Bot cannot paste a whole disk into its own context. */
  listEntries: number;
};

/**
 * One thing in the workspace. Folders included so a Bot can see the shape, not just the leaves.
 *
 * Mirrors `WorkspaceEntry` in the server's published contract (`server/src/computer/schema.ts`), the
 * same way `SnapshotElement` does. Duplicated rather than shared because this process is a separate
 * deployable with no code in common with the server; the two must be changed together, and a field
 * added here and not there is invisible until a Bot asks for it.
 */
export type WorkspaceEntry = {
  /** Relative to the workspace root, which is the only form a request may use. */
  path: string;
  kind: "file" | "folder";
  bytes?: number;
};

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  readBytes: 64_000,
  writeBytes: 1_000_000,
  listEntries: 500,
};

/** Where a file a page handed the browser lands, so a Bot can find it with `computer_list_files`. */
export const DOWNLOADS_DIRECTORY = "downloads";

/**
 * A name a page chose, made safe to put on this filesystem.
 *
 * The name comes from the site — `Content-Disposition` or the anchor's `download` attribute — which
 * makes it the one string in this module that an attacker picks outright. Everything that could make
 * it mean a path rather than a file is removed here, and `resolvePath` still refuses what is left if
 * it somehow escapes: the two are layers, not alternatives.
 *
 * A name that survives as nothing becomes `download`, because a file that exists and is called
 * something ordinary is more use to somebody than a refusal they cannot act on.
 */
export function safeDownloadName(suggested: string): string {
  const base = (suggested ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // Control characters, including the NUL that truncates a path in a C library.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f]/g, "")
    // A leading dot makes a dotfile; a name that is only dots is `.` or `..`.
    .replace(/^\.+/, "")
    .trim();
  if (!cleaned) return "download";
  // Long enough for any real filename, short enough for every filesystem's limit with the ` (2)`
  // a collision adds.
  return cleaned.slice(0, 120);
}

export function createWorkspace(
  rootPath: string,
  limits: WorkspaceLimits = DEFAULT_WORKSPACE_LIMITS,
) {
  /**
   * Turn a Bot's requested path into a real one inside the workspace, or refuse.
   *
   * `forWrite` changes only which part of the path must already exist: a read resolves the file
   * itself, a write resolves the directory it would be created in.
   */
  async function resolvePath(
    requested: string,
    forWrite: boolean,
  ): Promise<string> {
    if (typeof requested !== "string" || !requested.trim()) {
      throw new WorkspacePathError("A file path is required.");
    }
    const wanted = requested.trim();

    if (isAbsolute(wanted)) {
      throw new WorkspacePathError(
        "Use a path relative to your workspace, not an absolute one.",
      );
    }
    // Refused explicitly rather than left to the containment check, so the Bot is told what it did
    // wrong and can correct it, instead of receiving a generic denial it may retry verbatim.
    if (wanted.split(/[\\/]/).includes("..")) {
      throw new WorkspacePathError(
        "A file path may not contain '..'. You can only reach files inside your own workspace.",
      );
    }

    const root = await realpath(rootPath);
    const target = resolve(root, wanted);
    assertInside(root, target);

    // Layer three. Resolve what exists on disk and check again, because everything above
    // reasons about the path as text and a symlink makes the text a lie.
    const anchor = forWrite ? dirname(target) : target;
    let realAnchor: string;
    try {
      realAnchor = await realpath(anchor);
    } catch {
      if (!forWrite) {
        throw new WorkspaceFileError(`There is no file at ${wanted}.`);
      }
      // The parent directory does not exist yet. Walk up to the nearest one that does and verify it,
      // so a write into a new subdirectory is allowed but cannot be aimed through a symlink.
      realAnchor = await nearestExistingAncestor(root, anchor);
    }
    assertInside(root, realAnchor, wanted);

    // For a write, return the full lexical target. It is already proven contained lexically, and the
    // deepest existing directory is proven contained after symlinks, so `mkdir -p` can only create the
    // rest inside the workspace.
    return forWrite ? target : realAnchor;
  }

  return {
    resolvePath,

    /**
     * What is in the workspace.
     *
     * Recursive, because a Bot that saved `reports/august/summary.csv` needs to find it again, and a
     * listing that stops at the first level would show a `reports` directory and no way in. Bounded by
     * entry count for the same reason everything else here is bounded.
     */
    async list(requested = "."): Promise<{
      path: string;
      entries: WorkspaceEntry[];
      truncated: boolean;
    }> {
      const root = await realpath(rootPath);
      // "." and "" both mean the workspace itself, which `resolvePath` would reject as a bare relative
      // path with nothing in it. Anything else goes through the same confinement as a read.
      const start =
        requested === "." || requested.trim() === ""
          ? root
          : await resolvePath(requested, false);

      const info = await stat(start).catch(() => null);
      if (!info) {
        throw new WorkspaceFileError(`There is no folder at ${requested}.`);
      }
      if (!info.isDirectory()) {
        throw new WorkspaceFileError(`${requested} is a file, not a folder.`);
      }

      const entries: WorkspaceEntry[] = [];
      let truncated = false;

      const walk = async (dir: string): Promise<void> => {
        if (truncated) return;
        const found = await readdir(dir, { withFileTypes: true });
        for (const item of found) {
          if (entries.length >= limits.listEntries) {
            truncated = true;
            return;
          }
          const full = `${dir}/${item.name}`;
          // Relative to the workspace root, because that is the only form a Bot may name in a request.
          const shown = full.slice(root.length + 1);
          if (item.isDirectory()) {
            entries.push({ path: shown, kind: "folder" });
            await walk(full);
            continue;
          }
          if (!item.isFile()) continue;
          const size = await stat(full).catch(() => null);
          entries.push({
            path: shown,
            kind: "file",
            ...(size ? { bytes: size.size } : {}),
          });
        }
      };

      await walk(start);
      return { path: requested, entries, truncated };
    },

    /** Read a text file. Bounded, and it says when it gave you less than the whole thing. */
    async read(requested: string): Promise<{
      path: string;
      text: string;
      truncated: boolean;
      bytes: number;
    }> {
      const full = await resolvePath(requested, false);
      const info = await stat(full).catch(() => null);
      if (!info) {
        throw new WorkspaceFileError(`There is no file at ${requested}.`);
      }
      if (info.isDirectory()) {
        throw new WorkspaceFileError(
          `${requested} is a directory, not a file.`,
        );
      }

      const buffer = await readFile(full);
      const slice = buffer.subarray(0, limits.readBytes);
      return {
        path: requested,
        // Decoded as UTF-8. A binary file therefore comes back as replacement characters rather
        // than as a base64 blob nothing can read: this tool is for the notes, CSVs and JSON a Bot
        // actually works with, and pretending otherwise would invite it to try images.
        text: slice.toString("utf8"),
        truncated: buffer.byteLength > slice.byteLength,
        bytes: buffer.byteLength,
      };
    },

    /** Write a text file, creating parent directories inside the workspace as needed. */
    async write(
      requested: string,
      contents: string,
      options: { append?: boolean } = {},
    ): Promise<{ path: string; bytes: number; appended: boolean }> {
      if (typeof contents !== "string") {
        throw new WorkspaceFileError("The contents to write must be text.");
      }
      const bytes = Buffer.byteLength(contents, "utf8");
      if (bytes > limits.writeBytes) {
        throw new WorkspaceFileError(
          `That is ${bytes} bytes and the limit is ${limits.writeBytes}.`,
        );
      }

      const full = await resolvePath(requested, true);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents, {
        encoding: "utf8",
        flag: options.append ? "a" : "w",
      });
      return { path: requested, bytes, appended: options.append === true };
    },

    /**
     * Put a file the browser downloaded into the workspace.
     *
     * `save` is Playwright's `download.saveAs`, handed the path this decides on: the file exists in
     * Chromium's own temporary directory until then, and is deleted when the browser closes, so a
     * download that is not moved here is a download the Bot cannot ever open.
     *
     * THE SAME LIMIT AS A WRITE. A Bot writing a megabyte of text is refused, and a Bot clicking a
     * link to a 4GB file must be too, or the bound on what one Bot can put on the volume is decided
     * by whatever it happened to click. The size is only knowable after the file has landed, so an
     * oversized one is written and then removed — the refusal is real either way, and the disk holds
     * it for the moment in between rather than for ever.
     *
     * A name already taken is suffixed rather than overwritten. Downloading 정산내역.xlsx twice is
     * two months' figures, and the second silently replacing the first is a lost month.
     */
    async saveDownload(
      suggested: string,
      save: (to: string) => Promise<void>,
    ): Promise<{ path: string; bytes: number }> {
      const name = safeDownloadName(suggested);
      const directory = resolve(await realpath(rootPath), DOWNLOADS_DIRECTORY);
      await mkdir(directory, { recursive: true });

      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const extension = dot > 0 ? name.slice(dot) : "";
      let chosen = name;
      for (let attempt = 2; attempt < 100; attempt += 1) {
        const taken = await stat(resolve(directory, chosen)).catch(() => null);
        if (!taken) break;
        chosen = `${stem} (${attempt})${extension}`;
      }

      // Through the same confinement as everything else. The name is already safe; this is the layer
      // that stays true if it ever is not.
      const relativePath = `${DOWNLOADS_DIRECTORY}/${chosen}`;
      const full = await resolvePath(relativePath, true);
      await save(full);

      const written = await stat(full).catch(() => null);
      if (!written) {
        throw new WorkspaceFileError("The download did not arrive.");
      }
      if (written.size > limits.writeBytes) {
        await rm(full, { force: true }).catch(() => undefined);
        throw new WorkspaceFileError(
          `That download is ${written.size} bytes and the limit is ${limits.writeBytes}.`,
        );
      }
      return { path: relativePath, bytes: written.size };
    },
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;

/** Containment, as a path comparison that cannot be fooled by a shared prefix. */
function assertInside(root: string, candidate: string, shown?: string): void {
  const rel = relative(root, candidate);
  // `relative` returns "" for the root itself, which is inside. It returns something starting with
  // ".." for anything outside, and an absolute path when the two are on different roots. Comparing
  // with startsWith on the raw strings instead would let "/workspace-evil" pass as "/workspace".
  const outside =
    rel !== "" &&
    (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
  if (outside) {
    throw new WorkspacePathError(
      `${shown ?? candidate} is outside your workspace, so it cannot be reached.`,
    );
  }
}

/** The closest ancestor of `target` that exists, never above `root`. */
async function nearestExistingAncestor(
  root: string,
  target: string,
): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // Ran out of path without finding anything. Only reachable if the root itself vanished.
        throw new WorkspacePathError("The workspace directory is missing.");
      }
      assertInside(root, parent);
      current = parent;
    }
  }
}
