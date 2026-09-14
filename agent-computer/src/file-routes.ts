/**
 * The Bot's files, over HTTP: `/files/read`, `/files/list` and `/files/write`.
 *
 * They reach the durable workspace volume, confined to it by workspace.ts. Reading and writing are
 * the two operations a Bot needs to keep notes between turns. Nothing here decides whether a Bot
 * MAY touch a path: the gateway in front of this process does that.
 */
import type { BotRoute } from "./computer";
import { bodyOf, describe, json } from "./respond";
import { WorkspaceFileError, WorkspacePathError } from "./workspace";

/**
 * Which status a file failure deserves.
 *
 * A path outside the workspace is the caller asking for something it may never have, so 403: retrying
 * it unchanged will never work, and it is not a fault. A missing file or an oversized write is a 400,
 * because a different request would succeed. Collapsing both into 500 would tell the Bot the computer
 * is broken and invite it to try the same thing again.
 */
export function fileStatus(error: unknown): 400 | 403 | 500 {
  if (error instanceof WorkspacePathError) return 403;
  if (error instanceof WorkspaceFileError) return 400;
  return 500;
}

export const readFile: BotRoute = async ({ request }, { workspace }) => {
  const body = await bodyOf<{ path?: unknown }>(request);
  try {
    return json(await workspace.read(String(body?.path ?? "")));
  } catch (error) {
    return json(
      { error: describe(error, "The file could not be read.") },
      fileStatus(error),
    );
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
    return json(
      { error: describe(error, "The folder could not be listed.") },
      fileStatus(error),
    );
  }
};

export const writeFile: BotRoute = async ({ request }, { workspace }) => {
  const body = await bodyOf<{
    path?: unknown;
    contents?: unknown;
    append?: unknown;
  }>(request);
  if (typeof body?.contents !== "string") {
    return json({ error: "The contents to write are required." }, 400);
  }
  try {
    return json(
      await workspace.write(String(body?.path ?? ""), body.contents, {
        append: body.append === true,
      }),
    );
  } catch (error) {
    return json(
      { error: describe(error, "The file could not be written.") },
      fileStatus(error),
    );
  }
};
