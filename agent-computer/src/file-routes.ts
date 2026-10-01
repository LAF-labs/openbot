/**
 * The Bot's files, over HTTP: `/files/read`, `/files/list` and `/files/write` for the Bot, and
 * `/files/stat` and `/files/download` for handing one to the person it works for.
 *
 * They reach the durable workspace volume, confined to it by workspace.ts. Reading and writing are
 * the two operations a Bot needs to keep notes between turns. Nothing here decides whether a Bot
 * MAY touch a path: the gateway in front of this process does that.
 */
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
 * The one file route whose answer is not JSON. The path goes through the same confinement as every
 * other, and a failure is the same fact it is everywhere else — a path outside, nothing there, a
 * folder, more than a download hands over.
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
