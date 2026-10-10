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
import { AsyncLocalStorage } from "node:async_hooks";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ATTACHMENT_MAX_BYTES } from "../../shared/attachments";
import {
  type FileScope,
  isProjectFolderId,
  projectFolder,
  scopeLists,
  scopeRefusal,
} from "../../shared/file-scope";
import { HANDOFF_MAX_BYTES } from "../../shared/workspace-files";
import { sliceOnCharacters } from "../../shared/sound-text";

/**
 * A path that is not the Bot's to name. The message is for this process's own tests and logs; what
 * leaves the process is `code` (`failures.ts`), because the surface owns the words.
 */
export class WorkspacePathError extends Error {
  readonly code = "laf:file_path_refused" as const;
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

/**
 * Why a file request did not fit what is on disk, as a code — and the numbers that go with it.
 *
 * Answers only (codes.ts). A download that never arrived is `laf:file_not_found` here, and becomes
 * the note `laf:download_failed` where the download is watched (page-watch.ts): the workspace says
 * what is on disk, and the page's watcher says what that means for the click that started it.
 */
/** The most bytes one name of a path may be, on every filesystem this runs on. */
const NAME_MAX_BYTES = 255;

export type WorkspaceFileCode =
  | "laf:file_not_found"
  | "laf:file_wrong_kind"
  | "laf:file_too_large"
  /** Something is already at the path a `put` named. A put never replaces. */
  | "laf:file_exists"
  | "laf:request_invalid";

export class WorkspaceFileError extends Error {
  constructor(
    message: string,
    readonly code: WorkspaceFileCode = "laf:file_not_found",
    readonly facts: Record<string, unknown> = {},
  ) {
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
  /**
   * Most bytes one download hands the person the Bot works for.
   *
   * Left out, it is the bound the server and the surface read too (`shared/workspace-files.ts`):
   * a card that draws a button under a file this then refuses is a control that does nothing, so
   * the three of them take one number. Optional because the three limits above bound what a BOT
   * may do, and a caller that sets those is saying nothing about a person's download.
   */
  downloadBytes?: number;
  /**
   * Most bytes one file hands the SERVER, whole (`whole`).
   *
   * Left out, it is the most a person may attach (`shared/attachments.ts`): whatever somebody could
   * hand their Bot can be taken back out in one piece. Not the download's five megabytes, which is
   * a bound on what a card offers a person, and not `readBytes`, which is what a model's context
   * can take of a text.
   */
  wholeBytes?: number;
  /**
   * Most bytes one `put` takes.
   *
   * Left out, it is what one download hands over, for the reason `downloadBytes` gives: a file put
   * here that no card could then hand to anybody is a file nobody can reach. NOT `writeBytes` — that
   * megabyte bounds what a Bot may write by its own tool, in one call of a loop; a put is the
   * server's, of bytes it already holds, and a workbook is routinely over a megabyte.
   */
  putBytes?: number;
  /**
   * Most bytes one file a PAGE hands the browser may be (`saveDownload`).
   *
   * NOT `writeBytes`. That megabyte bounds what a Bot writes by its own tool, in one call of a
   * loop; until 2026-10-09 it bounded this too, and a statement or a catalogue a site offers — an
   * ordinary workbook, a PDF of a few megabytes — was written, measured and deleted, and the person
   * told to fetch it themselves (owner, 2026-10-08: a download over 1 MB works; the disk decides).
   * Left out, it is {@link LANDED_MAX_BYTES}.
   */
  landedBytes?: number;
  /**
   * What must still be free on the folder's volume with a download on it. Left out, it is
   * {@link SPARE_BYTES}. The disk is the deployment's one disk — the database, the browser's
   * profile and the images are on it too — so the bound on a download is what it leaves them.
   */
  spareBytes?: number;
  /** What is free on the folder's volume, in bytes. Left out, the volume is asked (`statfs`). */
  freeBytes?: () => Promise<number>;
  /** How a file that landed is put in the folder. Left out, the disk's own copy (`copyFile`). */
  copyLanded?: (from: string, to: string) => Promise<void>;
};

/**
 * The most one downloaded file may be, whatever the disk has: a gigabyte. A ceiling so that one
 * click cannot take most of a disk that happens to be empty today; the disk's own room
 * ({@link SPARE_BYTES}) is the bound that is usually met first on a deployment that has been used.
 */
export const LANDED_MAX_BYTES = 1_000_000_000;

/**
 * What a download must leave free on the volume: two gigabytes, for everything else that lives
 * there. Held at every step and not only at the end: while a download lands the watch stops it at
 * this line (to within what arrives between two looks), and one that has landed is copied only if
 * the line still holds with the copy counted as new bytes (`saveDownload`).
 */
export const SPARE_BYTES = 2_000_000_000;

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

/**
 * Most characters one ranged read hands back (`offset`/`limit`).
 *
 * A result over 20,000 characters is cut where the server first sees it, and the whole is filed in
 * `.results/` (`shared/spillover.ts`). Reading that file back was cut at the same place, every time:
 * there was no way past the first 20,000 characters (harness phase 2, 2026-09-25). A range continues
 * from where the cut stopped, and it stays under the cut once the result wrapping it — JSON, whose
 * escapes lengthen what is quoted — is counted, so reading on does not spill a second file.
 *
 * CHARACTERS, NOT LINES as Claude Code's Read counts them, because the cut and the line that names
 * the file (`[앞 20,000자만 보인다 …]`) count characters, and a spilled result is one JSON line.
 */
export const RANGE_CHARS = 15_000;

/** A part of a file, in characters: where to start and how many. Either may be left out. */
export type ReadRange = { offset?: number; limit?: number };

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
  /*
   * WHOSE CALL THIS IS (`shared/file-scope.ts`): the main conversation's, a project's, the
   * person's. Carried beside the call rather than as an argument of every function below, so that
   * the one place a path is decided (`resolvePath`) reads it and nothing between has to remember
   * to pass it on. `within(scope)` is how a caller says it; the doors do, for every request
   * (`file-routes.ts`), and refuse a request that names none. Called with none — this object used
   * directly, as the tests of its limits do — a path is confined to the folder and nothing more,
   * as it always was.
   */
  const asking = new AsyncLocalStorage<FileScope>();
  const refusedFor = (path: string, touch: "read" | "write"): void => {
    const scope = asking.getStore();
    if (!scope || scopeRefusal(scope, path, touch) === null) return;
    throw new WorkspacePathError(
      scope.kind === "project" && touch === "write"
        ? `A project's files are written in its own folder, ${projectFolder(scope.id)}/.`
        : "That file is another project's. Each project's files are its own.",
    );
  };

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

    /*
     * A NAME THAT CANNOT BE A FILE'S IS REFUSED HERE, BY NAME. The runtime refuses a NUL in a path
     * as a bad argument and the filesystem refuses a name over 255 bytes as an errno, and neither
     * is a failing disk: until 2026-10-06 both came back from `put` as `laf:file_failed` — "try
     * once more" — for a request that can never work (the independent read).
     */
    if (wanted.includes("\0")) {
      throw new WorkspacePathError("A file path may not contain a NUL.");
    }
    /*
     * A BACKSLASH IS REFUSED, BECAUSE THIS FILE READ IT TWO WAYS. A write resolves the path as
     * text and a backslash is a letter of a name; a read goes on to `realpath`, and Bun's reads a
     * backslash as a separator. Measured here, Bun 1.3.14, 2026-10-07: with a file at
     * `private/pay.csv`, a read of `private\pay.csv` returned it, a listing of `\` listed the
     * whole folder, and a write to `a\b.txt` made one file called that. Whoever decides which
     * files a Bot may read is deciding about a string, and this one named two files. No name
     * anybody means has one (`safeDownloadName` takes them out of a download's).
     */
    if (wanted.includes("\\")) {
      throw new WorkspacePathError("A file path may not contain a backslash.");
    }
    if (
      wanted
        .split(/[\\/]/)
        .some((segment) => Buffer.byteLength(segment) > NAME_MAX_BYTES)
    ) {
      throw new WorkspacePathError(
        `A name in a file path may be at most ${NAME_MAX_BYTES} bytes.`,
      );
    }

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

    // By the path as it was asked for: the spelling the server placed and the boundary judged.
    refusedFor(wanted, forWrite ? "write" : "read");

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
    /*
     * AND BY WHERE IT REALLY IS. A link in the folder — a script in the workbench can make one —
     * that points into another project's folder is that project's file under a name of this one's.
     * As a read whichever it is: what is asked of the place a link leads is only whether it is
     * somebody else's. (A project's first write has its anchor at `projects/` or the root, which
     * a project may read and not write, so asking "write" here would refuse every first write.)
     *
     * WHAT THAT LEAVES: a link in a project's folder to the Bot's own folder lets that project
     * write there. Nothing a Bot is offered makes a link — only the workbench could, and it is
     * offered to nobody — so this is closed when the workbench is: a write whose real anchor is
     * neither its own folder, `projects/`, nor the root is then refused as a write.
     */
    refusedFor(relative(root, realAnchor).split(sep).join("/"), "read");

    // For a write, return the full lexical target. It is already proven contained lexically, and the
    // deepest existing directory is proven contained after symlinks, so `mkdir -p` can only create the
    // rest inside the workspace.
    return forWrite ? target : realAnchor;
  }

  const downloadBytes = limits.downloadBytes ?? HANDOFF_MAX_BYTES;
  const wholeBytes = limits.wholeBytes ?? ATTACHMENT_MAX_BYTES;
  const putBytes = limits.putBytes ?? HANDOFF_MAX_BYTES;
  const landedBytes = limits.landedBytes ?? LANDED_MAX_BYTES;
  const spareBytes = limits.spareBytes ?? SPARE_BYTES;
  const freeBytes =
    limits.freeBytes ??
    (async () => {
      const volume = await statfs(rootPath);
      return volume.bavail * volume.bsize;
    });
  const copyLanded =
    limits.copyLanded ?? ((from: string, to: string) => copyFile(from, to));

  /*
   * ONE DOWNLOAD IS PUT IN THE FOLDER AT A TIME. Asking the volume for its room and copying the
   * file are two steps, and two downloads that finished together each asked before either had
   * copied: with 3.1 GB free and 2 GB to keep, two files of 600 MB were both let in, and the disk
   * was left with 1.9 (Codex's second read of this change). So the asking and the copying of one
   * are finished before the next one asks, and the second is asked of the disk the first left.
   * In this process, which is the only one that writes this folder (`deployment-model.md`): a
   * queue, not a lock on the disk. A landing that fails does not stop the ones behind it.
   */
  let landing: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const mine = landing.then(work, work);
    landing = mine.catch(() => undefined);
    return mine;
  };

  /**
   * A path that has to be a file: where it really is, and what the disk says about it.
   *
   * A FILE, NOT MERELY NOT A FOLDER. A download reads to the end of whatever is there, and the end
   * of a pipe or a device is whenever its other side says so — so anything that is not an ordinary
   * file is the wrong kind, the same answer a folder gets.
   */
  async function fileAt(requested: string) {
    const full = await resolvePath(requested, false);
    const info = await stat(full).catch(() => null);
    if (!info) {
      throw new WorkspaceFileError(`There is no file at ${requested}.`);
    }
    if (!info.isFile()) {
      throw new WorkspaceFileError(
        `${requested} is not a file.`,
        "laf:file_wrong_kind",
      );
    }
    return { full, info };
  }

  /**
   * A file's bytes exactly as they are on disk, and never more than `most` of them.
   *
   * BOUNDED WHILE IT IS READ, not only before. The size is asked first, so an oversized file is
   * refused without touching it; but a page's download lands here whole before it is measured
   * (`saveDownload`), and a file that was small when asked can be large by the time it is read.
   * The read stops one byte past the bound and is refused there.
   */
  async function bytesOf(
    requested: string,
    most: number,
  ): Promise<{ path: string; bytes: Buffer<ArrayBuffer> }> {
    const { full, info } = await fileAt(requested);
    const tooLarge = (bytes: number) =>
      new WorkspaceFileError(
        `That is ${bytes} bytes and at most ${most} are handed over.`,
        "laf:file_too_large",
        { bytes, limit: most },
      );
    if (info.size > most) throw tooLarge(info.size);

    const chunks: Buffer[] = [];
    let total = 0;
    // `end` is the last byte read, inclusive: the bound and one more, which is how "over" is seen.
    const stream: AsyncIterable<Buffer> = createReadStream(full, {
      end: most,
    });
    for await (const chunk of stream) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    if (total > most) {
      // What the disk says now, where it can; the file is at least this much either way.
      const grown = await stat(full).catch(() => null);
      throw tooLarge(Math.max(grown?.size ?? 0, total));
    }
    return { path: requested, bytes: Buffer.concat(chunks, total) };
  }

  /** One landed file into `downloads/`: judged, named, copied. `saveDownload` is this, in turn. */
  async function putLanded(
    suggested: string,
    landed: string,
  ): Promise<{ path: string; bytes: number }> {
    const source = await stat(landed).catch(() => null);
    if (!source?.isFile()) {
      throw new WorkspaceFileError(
        "The download did not arrive.",
        "laf:file_not_found",
      );
    }
    if (source.size > landedBytes) {
      throw new WorkspaceFileError(
        `That download is ${source.size} bytes and the limit is ${landedBytes}.`,
        "laf:file_too_large",
        { bytes: source.size, limit: landedBytes },
      );
    }
    // A volume that cannot be asked is not a reason to refuse somebody's file: the ceiling held.
    const free = await freeBytes().catch(() => null);
    if (free !== null && free - source.size < spareBytes) {
      throw new WorkspaceFileError(
        `That download is ${source.size} bytes, ${free} are free and ${spareBytes} must stay free.`,
        "laf:file_too_large",
        // The most this one could have been and still been kept: the room above the spare.
        { bytes: source.size, limit: Math.max(0, free - spareBytes) },
      );
    }

    const name = safeDownloadName(suggested);
    // A project's downloads are its own: in its folder, and gone with it.
    const scope = asking.getStore();
    const downloads =
      scope?.kind === "project"
        ? `${projectFolder(scope.id)}/${DOWNLOADS_DIRECTORY}`
        : DOWNLOADS_DIRECTORY;
    const directory = resolve(await realpath(rootPath), downloads);
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
    const relativePath = `${downloads}/${chosen}`;
    const full = await resolvePath(relativePath, true);
    try {
      await copyLanded(landed, full);
    } catch (error) {
      await rm(full, { force: true }).catch(() => undefined);
      throw error;
    }
    return { path: relativePath, bytes: source.size };
  }

  const direct = {
    resolvePath,

    /**
     * One file's facts — that it is there, and how big — and nothing it holds.
     *
     * Asked about a path a listing would also answer for, and not asked of a listing, because a
     * listing is bounded by entries: `.results/` gains a file for every long tool result and nothing
     * empties it, so in a folder that has been worked in for a month the walk spends its five
     * hundred there and reports `truncated` before it reaches `요약.md`. "Not in the listing" is not
     * "not there", and a card that says a file is gone has to be told the second.
     */
    async stat(
      requested: string,
    ): Promise<{ path: string; kind: "file"; bytes: number }> {
      const { info } = await fileAt(requested);
      return { path: requested, kind: "file", bytes: info.size };
    },

    /**
     * A file's bytes exactly as they are on disk, for the person the Bot works for to keep.
     *
     * NOT `read`. That one is a Bot's: UTF-8 text, cut to what a model's context can take, a
     * picture arriving as replacement characters on purpose. This hands over the file itself, so a
     * sheet a page gave the browser and a note a Bot wrote both leave as what they are — and no
     * more of it than a download may be (`bytesOf`).
     */
    download(
      requested: string,
    ): Promise<{ path: string; bytes: Buffer<ArrayBuffer> }> {
      return bytesOf(requested, downloadBytes);
    },

    /**
     * A file's bytes exactly as they are on disk, for the server itself.
     *
     * NOT `download`, though it is the same reading. That one is a person taking a file out, bound
     * by what a card offers them and written down by the server as a file leaving. This is the
     * server holding a file whole because something has to be done with all of it — a workbook
     * cannot be summed from the first 64,000 bytes of it as text — and its bound is the largest
     * file a person may attach, so that nothing they could hand their Bot is too big to take up
     * again. Who may read which path is not asked here, as it is not for any route of this file:
     * the gateway in front of this process decides that.
     */
    whole(
      requested: string,
    ): Promise<{ path: string; bytes: Buffer<ArrayBuffer> }> {
      return bytesOf(requested, wholeBytes);
    },

    /**
     * Bytes, to a path nothing is at.
     *
     * NEVER OVER ANYTHING. `write` replaces what is there, which is what a Bot keeping notes wants
     * and exactly what must not happen to a file a person attached or a file an earlier task made.
     * So this creates and does nothing else: the file is opened to be created (`wx`), and a path
     * that already names something — a file, a folder, a link, wherever the link points — is
     * refused as `laf:file_exists` with what is there untouched. The caller composes a path that is
     * new; this is what stays true if it ever is not.
     *
     * BYTES, WHERE `write` TAKES TEXT. A workbook or a picture is neither a string nor under a
     * megabyte, so the body is taken as it is and bounded by `putBytes`.
     *
     * BOUNDED BEFORE IT IS HELD. The path is judged first, so a path that may not be named costs
     * nobody a body. Then what the caller declared is refused unread when it is over, and a body
     * that said nothing, or less than it sent, is read no further than one piece past the bound.
     *
     * ALL OR NOTHING. The body is held whole before the file is opened, and a write that fails
     * after the file was created takes the file away again — otherwise the next attempt would be
     * refused by the half of a file the last one left.
     */
    async put(
      requested: string,
      body: AsyncIterable<Uint8Array>,
      declared?: number,
    ): Promise<{ path: string; kind: "file"; bytes: number }> {
      const full = await resolvePath(requested, true);
      const tooLarge = (bytes: number) =>
        new WorkspaceFileError(
          `That is ${bytes} bytes and a put is at most ${putBytes}.`,
          "laf:file_too_large",
          { bytes, limit: putBytes },
        );
      if (declared !== undefined && declared > putBytes) {
        throw tooLarge(declared);
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of body) {
        total += chunk.byteLength;
        // Leaving the loop by a throw lets go of the body: nothing more of it is read.
        if (total > putBytes) throw tooLarge(total);
        chunks.push(chunk);
      }

      try {
        await mkdir(dirname(full), { recursive: true });
      } catch (error) {
        // A file where a folder of the path has to be: the request's mistake, not the disk's.
        if (errnoOf(error) === "EEXIST" || errnoOf(error) === "ENOTDIR") {
          throw new WorkspaceFileError(
            `${requested} is under something that is not a folder.`,
            "laf:file_wrong_kind",
          );
        }
        throw error;
      }
      let created = false;
      try {
        // Created or refused in one step: `x` fails on anything already there, a link included,
        // without following it.
        const file = await open(full, "wx");
        created = true;
        try {
          await file.writeFile(Buffer.concat(chunks, total));
        } finally {
          await file.close();
        }
      } catch (error) {
        // Only ever what THIS call created: a path that was taken is somebody else's file.
        if (created) {
          await rm(full, { force: true }).catch(() => undefined);
        } else if (errnoOf(error) === "EEXIST") {
          throw new WorkspaceFileError(
            `Something is already at ${requested}.`,
            "laf:file_exists",
          );
        } else if (["ENAMETOOLONG", "ELOOP"].includes(errnoOf(error) ?? "")) {
          // The whole path too long, or links that lead round: the request's, like a name too long.
          throw new WorkspacePathError("That file path cannot be a file's.");
        }
        throw error;
      }
      return { path: requested, kind: "file", bytes: total };
    },

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
      const scope = asking.getStore();

      const info = await stat(start).catch(() => null);
      if (!info) {
        throw new WorkspaceFileError(`There is no folder at ${requested}.`);
      }
      if (!info.isDirectory()) {
        throw new WorkspaceFileError(
          `${requested} is a file, not a folder.`,
          "laf:file_wrong_kind",
        );
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
          // Not listed, and not walked into: another project's folder is not this call's to see.
          if (scope && !scopeLists(scope, shown)) continue;
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

    /**
     * Read a text file. Bounded, and it says when it gave you less than the whole thing.
     *
     * With a range, the characters from `offset`, at most `limit` and never more than `RANGE_CHARS`;
     * `truncated` then says whether anything follows them.
     */
    async read(
      requested: string,
      range: ReadRange = {},
    ): Promise<{
      path: string;
      text: string;
      truncated: boolean;
      bytes: number;
      offset?: number;
    }> {
      const full = await resolvePath(requested, false);
      const info = await stat(full).catch(() => null);
      if (!info) {
        throw new WorkspaceFileError(`There is no file at ${requested}.`);
      }
      if (info.isDirectory()) {
        throw new WorkspaceFileError(
          `${requested} is a directory, not a file.`,
          "laf:file_wrong_kind",
        );
      }

      const buffer = await readFile(full);
      if (range.offset !== undefined || range.limit !== undefined) {
        const offset = range.offset ?? 0;
        const end =
          offset +
          Math.min(range.limit ?? RANGE_CHARS, RANGE_CHARS, limits.readBytes);
        // A UTF-16 unit is at most three bytes of UTF-8, so this prefix holds every unit up to AND
        // INCLUDING the one at `end`: an emoji lying across the edge has to be whole to be seen as
        // one, or its first bytes decode to a mark that is then handed back as text.
        const prefix = buffer.subarray(0, (end + 1) * 3);
        const decoded = prefix.toString("utf8");
        return {
          path: requested,
          // On characters at both edges, so parts read one after another hold each one once.
          text: sliceOnCharacters(decoded, offset, end),
          truncated:
            decoded.length > end || prefix.byteLength < buffer.byteLength,
          bytes: buffer.byteLength,
          offset,
        };
      }
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
        throw new WorkspaceFileError(
          "The contents to write must be text.",
          "laf:request_invalid",
          { field: "contents" },
        );
      }
      const bytes = Buffer.byteLength(contents, "utf8");
      if (bytes > limits.writeBytes) {
        throw new WorkspaceFileError(
          `That is ${bytes} bytes and the limit is ${limits.writeBytes}.`,
          "laf:file_too_large",
          { bytes, limit: limits.writeBytes },
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
     * Empty the workspace: everything in it, not the folder itself, which is a mounted volume.
     *
     * Only `/computers/reset` calls this — the account leaving. Nothing a Bot can ask for reaches it.
     * Returns how many top-level entries were removed, for the caller's record.
     */
    async clear(): Promise<number> {
      const root = await realpath(rootPath);
      const entries = await readdir(root);
      await Promise.all(
        entries.map((entry) =>
          rm(resolve(root, entry), { recursive: true, force: true }),
        ),
      );
      return entries.length;
    },

    /**
     * Put a file the browser downloaded into the workspace.
     *
     * `landed` is where Chromium left the finished file (Playwright's `download.path()`): in its
     * own temporary directory, deleted when the browser closes, so a download that is not put here
     * is a download the Bot cannot ever open.
     *
     * BOUNDED BY THE DISK, NOT BY WHAT A BOT MAY WRITE (owner, 2026-10-08). It was the write's
     * megabyte, which refused an ordinary workbook. Two bounds now, and a download is kept only
     * inside both: a ceiling on one file (`landedBytes`), and room left on the volume with it there
     * (`spareBytes`) — a Bot clicking a link to a 40 GB file must still be refused, or what one
     * click puts on the deployment's only disk is decided by whatever it happened to click.
     *
     * DECIDED BEFORE A BYTE IS COPIED. The file has landed, so its size is known, and both bounds
     * are asked of that number. It used to be copied first and measured afterwards, through a copy
     * nothing could stop: a file too large for the disk was copied until the disk said so, and the
     * part that had arrived stayed (Codex's read of this change). WHILE it is landing its size is
     * not known, and `hasRoom` is what the caller watches (`page-watch.ts`).
     *
     * THE ROOM IS ASKED AS IF THE COPY WERE ALL NEW BYTES. For the moment of the copy there are two
     * of the file — the browser's and this one — and whether the browser's is on the same disk
     * cannot be told from here (in a deployment it is: the container's own layer and the folder's
     * volume are one host disk under two mounts). Asked this way the disk keeps its spare through
     * that moment whichever it is; the cost is that on one disk a file is refused while there is
     * still its own size of room above the spare, at most the ceiling. The browser's copy is
     * deleted by the caller as soon as this returns, kept or not.
     *
     * A COPY THAT FAILS LEAVES NOTHING. Whatever part arrived is removed before the failure is
     * passed on — a disk that filled from something else half-way, a source that went.
     *
     * A name already taken is suffixed rather than overwritten. Downloading 정산내역.xlsx twice is
     * two months' figures, and the second silently replacing the first is a lost month.
     */
    saveDownload(
      suggested: string,
      landed: string,
    ): Promise<{ path: string; bytes: number }> {
      return oneAtATime(() => putLanded(suggested, landed));
    },

    /**
     * Whether the volume still has the room a download must leave. Asked while one is landing
     * (`page-watch.ts`): its size is not known until it has, and by then a large enough file has
     * already filled the disk under the database. True where the volume cannot be asked — the
     * ceiling is still asked once it has landed.
     */
    async hasRoom(): Promise<boolean> {
      const free = await freeBytes().catch(() => null);
      return free === null || free >= spareBytes;
    },

    /**
     * Remove a project's folder and everything in it. What deleting the project does
     * (`server/src/channels/deleting.ts`), and the only removal there is but `clear`: BY THE
     * PROJECT'S ID, NEVER BY A PATH, so nothing that can name a file can aim this at one.
     * Answers whether there was a folder.
     */
    async removeProject(id: string): Promise<boolean> {
      if (!isProjectFolderId(id)) {
        throw new WorkspacePathError("That is not a project's id.");
      }
      const folder = resolve(await realpath(rootPath), projectFolder(id));
      const was = await stat(folder).catch(() => null);
      await rm(folder, { recursive: true, force: true });
      return was !== null;
    },
  };

  type Scoped = typeof direct & { within: (scope: FileScope) => Scoped };
  /** The same folder, asked as `scope`: every path below is that scope's to reach or is refused. */
  const within = (scope: FileScope): Scoped => {
    const scoped = { within } as Record<string, unknown>;
    for (const [name, member] of Object.entries(direct)) {
      scoped[name] =
        typeof member === "function"
          ? (...given: unknown[]) =>
              asking.run(scope, () =>
                (member as (...all: unknown[]) => unknown)(...given),
              )
          : member;
    }
    return scoped as Scoped;
  };

  return { ...direct, within };
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

/** The system's own name for why a file call failed (`EEXIST`, `ENOTDIR`), where it gave one. */
function errnoOf(error: unknown): string | undefined {
  return error instanceof Error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}
