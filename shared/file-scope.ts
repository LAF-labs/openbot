/**
 * WHOSE FILES A CALL MAY TOUCH: the Bot's folder is one folder, and a project has a folder of its
 * own inside it (record §3, piece 4-2's second part, 2026-10-11).
 *
 * A project's conversation is deleted with everything it made, and a file is the one thing a
 * conversation makes that is not a row. So what a run in a project writes goes under
 * `projects/<channel id>/`, and no other conversation reads it: read from project B, A's file
 * becomes a tool result in B's transcript, and deleting A leaves that copy behind.
 *
 * THE RULE IS BY WHO IS ASKING, AND EVERY CALL SAYS WHO. Three scopes:
 *
 *   main       the Bot's main conversation, a routine, anything that is no project's. Reads and
 *              writes the folder, and nothing under `projects/`.
 *   project    a run in that project. Writes only under its own folder; reads its own folder and
 *              everything outside `projects/`.
 *   person     the person's own door — the file browser, a card's download. The whole folder.
 *
 * A CALL THAT DOES NOT SAY IS REFUSED, NEVER GUESSED (`agent-computer/src/file-routes.ts`). The
 * computer once fell back to a Bot called "shared" for a call that named none, and answered as
 * though it had worked. A file call with no scope would be a project's file written into the main
 * folder — where nothing deletes it — and looking exactly like success.
 *
 * TWO PLACES HOLD THE RULE, AND THEY DO DIFFERENT HALVES. The server PLACES a write
 * ({@link placedForWrite}) before the boundary judges it, so what a rule is asked about, what the
 * trail records and what the computer is sent are one spelling (`server/src/computer/gateway/
 * addresses.ts`: what is judged is what is acted on). The computer REFUSES what the scope may not
 * reach ({@link scopeRefusal}) and never rewrites: a path it is handed is the path it acts on.
 *
 * LITERAL PATHS, NO VIEW. A project's Bot sees `projects/<id>/report.csv` in the result of the
 * write that made it, and reads it by that name. An overlay — the project's folder shown as the
 * root, the root showing through — would have been two files answering to one name.
 */

/** The header every file call carries: `main`, `person`, or `project:<channel id>`. */
export const FILE_SCOPE_HEADER = "x-openbot-file-scope";

/** The folder the projects' folders are in. */
export const PROJECTS_DIRECTORY = "projects";

export type FileScope =
  | { kind: "main" }
  | { kind: "person" }
  | { kind: "project"; id: string };

export const MAIN_SCOPE: FileScope = { kind: "main" };
export const PERSON_SCOPE: FileScope = { kind: "person" };

/**
 * A project's id as a folder's name: a channel's id, which the server makes (`channel_<uuid>`).
 * Letters, digits, `_` and `-` only, so it can be neither `.`, `..`, nor more than one name.
 */
export function isProjectFolderId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

export function projectScope(id: string): FileScope {
  if (!isProjectFolderId(id)) {
    throw new Error("A project's folder is named by its channel's id.");
  }
  return { kind: "project", id };
}

/** The scope as the header says it. */
export function fileScopeHeader(scope: FileScope): string {
  return scope.kind === "project" ? `project:${scope.id}` : scope.kind;
}

/** The scope a header named, or null where it named none: absent, or nothing this reads. */
export function fileScopeOf(
  header: string | null | undefined,
): FileScope | null {
  const said = header?.trim();
  if (said === "main") return MAIN_SCOPE;
  if (said === "person") return PERSON_SCOPE;
  if (said?.startsWith("project:")) {
    const id = said.slice("project:".length);
    return isProjectFolderId(id) ? { kind: "project", id } : null;
  }
  return null;
}

/** A project's own folder, as a path in the Bot's folder. */
export function projectFolder(id: string): string {
  return `${PROJECTS_DIRECTORY}/${id}`;
}

/** The names in a path: what is left once `.` and empty segments are gone. */
function namesOf(path: string): string[] {
  return path
    .trim()
    .split("/")
    .filter((part) => part !== "" && part !== ".");
}

/**
 * Whether a path is in the projects' folder, or is it.
 *
 * WHATEVER THE LETTERS' CASE. This decides what is REFUSED, so reading more paths as "under
 * projects" is the safe direction: a laptop's disk does not tell `Projects` from `projects`, and a
 * path spelled the first way would otherwise be another project's file under a name this did not
 * recognise. (The folder a project OWNS is matched to the letter, below — that one exempts.)
 */
function isUnderProjects(names: readonly string[]): boolean {
  return names[0]?.toLowerCase() === PROJECTS_DIRECTORY;
}

/** Whether a path is in this project's own folder, or is it. To the letter. */
function isOwn(names: readonly string[], id: string): boolean {
  return names[0] === PROJECTS_DIRECTORY && names[1] === id;
}

/**
 * Why this scope may not reach this path, or null where it may. What the computer asks before it
 * touches a file, for every kind of touch: a read, a listing, a write, a file handed to a page.
 */
export function scopeRefusal(
  scope: FileScope,
  path: string,
  touch: "read" | "write",
): "laf:file_other_project" | "laf:file_outside_project" | null {
  if (scope.kind === "person") return null;
  const names = namesOf(path);
  if (scope.kind === "main") {
    return isUnderProjects(names) ? "laf:file_other_project" : null;
  }
  if (isOwn(names, scope.id)) return null;
  // The projects' folder itself is the way down to its own: looked into, and shown only that.
  if (
    touch === "read" &&
    names.length === 1 &&
    names[0] === PROJECTS_DIRECTORY
  ) {
    return null;
  }
  if (isUnderProjects(names)) return "laf:file_other_project";
  // Outside `projects/` altogether: the Bot's own folder, which a project reads and does not write.
  return touch === "write" ? "laf:file_outside_project" : null;
}

/**
 * Whether a scope is shown a path in a listing: what it may read — so a project sees `projects`,
 * its own folder in it, and no other project's.
 */
export function scopeLists(scope: FileScope, path: string): boolean {
  return scopeRefusal(scope, path, "read") === null;
}

/**
 * Where a write by this scope goes: the path as given, or — for a project — that path inside the
 * project's own folder. Null for a path the scope may not write at all (another project's).
 *
 * The server's half. A path already in the project's own folder is left alone, so a Bot that
 * writes to the name a result gave it does not land in `projects/<id>/projects/<id>/…`.
 */
export function placedForWrite(scope: FileScope, path: string): string | null {
  if (scope.kind !== "project") {
    return scopeRefusal(scope, path, "write") === null ? path : null;
  }
  const names = namesOf(path);
  if (isOwn(names, scope.id)) return path;
  if (isUnderProjects(names)) return null;
  return [projectFolder(scope.id), ...names].join("/");
}

/**
 * WHAT A PROJECT FILED BEFORE IT HAD A FOLDER (piece 4-2's third part, 2026-10-11).
 *
 * An attachment's readable copy was filed in the Bot's own `uploads/` until projects had folders,
 * and its row still says where. Those copies are NOT MOVED into the project's folder: the path is
 * in the words the conversation already holds — the attachment's text names it to the model — and
 * a moved file would make every one of them wrong. They are removed when the project is, by name:
 * the server reads the names from the project's own rows and the computer removes exactly those,
 * in `uploads/` and nowhere else.
 */
export const UPLOADS_DIRECTORY = "uploads";

/** How many names one removal carries: what the server sends at most and the computer takes. */
export const OLDER_COPIES_PER_CALL = 500;

/** A name that is one file in a folder: no separator, not `.` or `..`, nothing that ends a path. */
export function isBareFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

/**
 * The name of an older copy, from the path its row holds: `uploads/<one name>`, to the letter.
 * Null for anything else — a path already in a project's folder (it goes with the folder), a
 * path somewhere this does not remove from, a string that is no such path.
 */
export function olderCopyNameOf(workspacePath: string): string | null {
  const prefix = `${UPLOADS_DIRECTORY}/`;
  if (!workspacePath.startsWith(prefix)) return null;
  const name = workspacePath.slice(prefix.length);
  return isBareFileName(name) ? name : null;
}

/**
 * When projects began to have folders: the moment the code landed on main (#169, `2e288b8a`,
 * `git log -1 --format=%cI`). A project made before
 * it — a conversation that became a project by migration 0064, from an account that had several
 * before 2026-09-24 — holds files nobody can tell are its own: what it downloaded and wrote went
 * in the Bot's folder beside everything else. Deleting it leaves those, and the surface says so
 * before the person presses. No deployment could make a project between this moment and its own
 * upgrade: the screen that makes one ships with the folder.
 */
export const PROJECT_FOLDERS_SINCE = "2026-10-10T16:07:47.000Z";

/** Whether a project is older than its folder, from when its conversation was made. */
export function isOlderThanItsFolder(createdAt: string | Date): boolean {
  const made = new Date(createdAt).getTime();
  return Number.isFinite(made) && made < Date.parse(PROJECT_FOLDERS_SINCE);
}
