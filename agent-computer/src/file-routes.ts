/**
 * The Bot's files, over HTTP: `/files/read`, `/files/list` and `/files/write`.
 *
 * They reach the durable workspace volume, confined to it by workspace.ts. Reading and writing are
 * the two operations a Bot needs to keep notes between turns. Nothing here decides whether a Bot
 * MAY touch a path: the gateway in front of this process does that.
 */
import type { BotRoute } from "./computer";
import { fileFailure } from "./failures";
import { bodyOf, invalid, json } from "./respond";

export const readFile: BotRoute = async ({ request }, { workspace }) => {
  const body = await bodyOf<{ path?: unknown }>(request);
  try {
    return json(await workspace.read(String(body?.path ?? "")));
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
