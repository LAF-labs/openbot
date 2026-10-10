/**
 * The Bot's files, over HTTP: `/files/read`, `/files/list` and `/files/write` for the Bot,
 * `/files/stat` and `/files/download` for handing one to the person it works for, and
 * `/files/bytes` and `/files/put` for the server itself — a file taken whole, and bytes put where
 * nothing is.
 *
 * They reach the durable workspace volume, confined to it by workspace.ts. Reading and writing are
 * the two operations a Bot needs to keep notes between turns. Nothing here decides whether a Bot
 * MAY touch a path: the gateway in front of this process does that.
 */
import {
  FILE_SCOPE_HEADER,
  fileScopeOf,
  isProjectFolderId,
} from "../../shared/file-scope";
import { FILE_PATH_HEADER } from "../../shared/workspace-files";
import type { BotRoute } from "./computer";
import { fileFailure } from "./failures";
import { bodyOf, bytes, invalid, json } from "./respond";

/** A whole number at or above zero, `undefined` when not given, `false` when unusable. */
function countOf(value: unknown): number | undefined | false {
  if (value === undefined || value === null) return undefined;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : false;
}

export const readFile: BotRoute = async ({ request }, { workspace }) => {
  const body = await bodyOf<{
    path?: unknown;
    offset?: unknown;
    limit?: unknown;
  }>(request);
  const offset = countOf(body?.offset);
  const limit = countOf(body?.limit);
  if (offset === false) return invalid("offset");
  if (limit === false || limit === 0) return invalid("limit");
  try {
    return json(
      await workspace.read(String(body?.path ?? ""), {
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
      }),
    );
  } catch (error) {
    return fileFailure(error);
  }
};

export const listFiles: BotRoute = async ({ request }, { workspace }) => {
  const body = await bodyOf<{ path?: unknown }>(request);
  try {
    return json(
      await workspace.list(
        typeof body?.path === "string" ? body.path : undefined,
      ),
    );
  } catch (error) {
    return fileFailure(error);
  }
};

export const writeFile: BotRoute = async ({ request }, { workspace }) => {
  const body = await bodyOf<{
    path?: unknown;
    contents?: unknown;
    append?: unknown;
  }>(request);
  if (typeof body?.contents !== "string") return invalid("contents");
  try {
    return json(
      await workspace.write(String(body?.path ?? ""), body.contents, {
        append: body.append === true,
      }),
    );
  } catch (error) {
    return fileFailure(error);
  }
};

/** The path of a request about one file, or nothing when it named none. */
function pathOf(body: { path?: unknown } | null): string | undefined {
  return typeof body?.path === "string" && body.path.trim()
    ? body.path
    : undefined;
}

/**
 * `POST /files/stat`: is this path a file, and how big.
 *
 * What the server asks before it tells a Bot its file card is on screen, and what the card asks
 * before it draws a button — so neither says a file is there, or gone, on the strength of a listing
 * that ran out of entries before it got that far (see `stat` in workspace.ts).
 */
export const statFile: BotRoute = async ({ request }, { workspace }) => {
  const path = pathOf(await bodyOf<{ path?: unknown }>(request));
  if (path === undefined) return invalid("path");
  try {
    return json(await workspace.stat(path));
  } catch (error) {
    return fileFailure(error);
  }
};

/**
 * `POST /files/download`: one file's bytes, for the person the Bot works for.
 *
 * A file route whose answer is not JSON, as `/files/bytes` below is the other. The path goes through
 * the same confinement as every other, and a failure is the same fact it is everywhere else — a
 * path outside, nothing there, a folder, more than a download hands over.
 */
export const downloadFile: BotRoute = async ({ request }, { workspace }) => {
  const path = pathOf(await bodyOf<{ path?: unknown }>(request));
  if (path === undefined) return invalid("path");
  try {
    return bytes((await workspace.download(path)).bytes);
  } catch (error) {
    return fileFailure(error);
  }
};

/**
 * `POST /files/bytes`: one file's bytes, whole, for the server itself.
 *
 * The same answer as `/files/download` — bytes, named as nothing — under the workspace's other
 * bound (`whole` in workspace.ts says why there are two). A route of its own rather than a flag on
 * that one, so that which bound a request is held to is never something its body says.
 */
export const fileBytes: BotRoute = async ({ request }, { workspace }) => {
  const path = pathOf(await bodyOf<{ path?: unknown }>(request));
  if (path === undefined) return invalid("path");
  try {
    return bytes((await workspace.whole(path)).bytes);
  } catch (error) {
    return fileFailure(error);
  }
};

/**
 * A request's body, a piece at a time — and nothing at all for a request that sent none: a file of
 * no bytes is still a file.
 *
 * THROUGH A READER, NOT `for await` OVER THE BODY. A body that arrived over a socket is not
 * iterable in the pinned Bun: measured 2026-10-06 (1.3.11), `for await (… of request.body)` on a
 * request `Bun.serve` handed over threw `undefined is not a function` before the first piece, while
 * the same loop over a `Request` built in a test passed — so every test of this route that made its
 * own request was green and the first real put answered `laf:file_failed`. The wire test at the
 * root is what met it (`tests/file-handoff.test.ts`).
 *
 * Whatever was not asked for is let go of when the reading stops, so a put that is refused part-way
 * takes no more of the body off the wire.
 */
async function* piecesOf(request: Request): AsyncGenerator<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * The path a put named, from its header — percent-encoded there, because a header is ASCII and a
 * path in this folder is Korean more often than not. Nothing when there is none, it is blank, or
 * it is not an encoding of anything.
 */
function putPathOf(headers: Headers): string | undefined {
  const sent = headers.get(FILE_PATH_HEADER);
  if (!sent) return undefined;
  try {
    return pathOf({ path: decodeURIComponent(sent) });
  } catch {
    return undefined;
  }
}

/** What a request says its body weighs, when it says a number at all. */
function declaredLengthOf(headers: Headers): number | undefined {
  const sent = headers.get("content-length");
  if (sent === null || !/^\d+$/.test(sent.trim())) return undefined;
  return Number(sent);
}

/**
 * `POST /files/put`: the request's body, as a new file at the path its header names.
 *
 * THE BODY IS THE FILE, so the path cannot ride in it and rides in a header instead
 * (`shared/workspace-files.ts`). The one file route whose REQUEST is not JSON, as `/files/download`
 * is the one whose answer is not. What it answers is the file's facts, as `/files/stat` would say
 * them a moment later.
 *
 * Never over anything, and never more than the workspace's bound for it: both are `put` in
 * workspace.ts, which is handed the body unread so that it is the one place the bound is kept.
 */
export const putFile: BotRoute = async ({ request }, { workspace }) => {
  const path = putPathOf(request.headers);
  if (path === undefined) return invalid("path");
  try {
    return json(
      await workspace.put(
        path,
        piecesOf(request),
        declaredLengthOf(request.headers),
      ),
    );
  } catch (error) {
    return fileFailure(error);
  }
};

/**
 * `POST /files/project/remove`: a project's folder, and everything in it, gone. What deleting the
 * project does last on this side (`server/src/channels/deleting.ts`).
 *
 * BY THE PROJECT'S ID, NEVER A PATH, AND ONLY AT THE PERSON'S OWN DOOR: no call a Bot's run makes
 * says `person`, so nothing a Bot can be talked into reaches this.
 */
export const removeProjectFolder: BotRoute = async (
  { request, session },
  { workspace },
) => {
  if (fileScopeOf(request.headers.get(FILE_SCOPE_HEADER))?.kind !== "person") {
    return invalid("fileScope");
  }
  const body = await bodyOf<{ projectId?: unknown }>(request);
  if (!isProjectFolderId(body?.projectId)) return invalid("projectId");
  // A download its last page is still sending would make the folder again, for nothing to remove.
  if (
    session.fileScope?.kind === "project" &&
    session.fileScope.id === body.projectId
  ) {
    delete session.fileScope;
  }
  try {
    return json({ removed: await workspace.removeProject(body.projectId) });
  } catch (error) {
    return fileFailure(error);
  }
};
