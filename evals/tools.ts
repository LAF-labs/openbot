/**
 * The product's tools, as the surface actually sends them to a Bot.
 *
 * NOT A MIRROR ANY MORE. This file used to hold hand-copied names, descriptions and schemas, with a
 * banner asking whoever changed a registration to change this too — and it had already drifted:
 * `computer_snapshot` read differently here than in the browser, and `computer_read_file` said the
 * workspace survives "between conversations" in one place and "between runs" in another. An eval
 * measuring paraphrased tool descriptions certifies a product that does not exist, and the words
 * ARE half of what is being measured (the remember/update_profile split lives in them).
 *
 * So it re-exports the one catalogue. `tests/tool-catalogue.test.ts` asserts the three consumers —
 * the surface, the server's unattended loop, and this — reference the same objects.
 */
import {
  computerTool,
  COMPUTER_TOOLS as SHARED_COMPUTER_TOOLS,
} from "../shared/tools/computer";
import {
  MANAGE_ROUTINE as SHARED_MANAGE_ROUTINE,
  REMEMBER as SHARED_REMEMBER,
  UPDATE_PROFILE as SHARED_UPDATE_PROFILE,
} from "../shared/tools/self";

/**
 * One tool from the catalogue, by name — THE OBJECT, not a copy of it.
 *
 * Rebuilding it field by field here would pass every equality check and still be a second copy,
 * which is exactly the shape that drifted. `tests/tool-catalogue.test.ts` asserts identity, so a
 * copy fails there rather than in a verdict about words nobody was sent.
 */
function computer(name: string) {
  const tool = computerTool(name);
  if (!tool) throw new Error(`No computer tool named ${name}.`);
  return tool;
}

export const REMEMBER = SHARED_REMEMBER;
export const UPDATE_PROFILE = SHARED_UPDATE_PROFILE;
export const MANAGE_ROUTINE = SHARED_MANAGE_ROUTINE;

export const NAVIGATE = computer("computer_navigate");
export const READ = computer("computer_read");
export const SNAPSHOT = computer("computer_snapshot");
export const TYPE = computer("computer_type");
export const CLICK = computer("computer_click");
export const REQUEST_SECRET = computer("computer_request_secret");
export const REQUEST_HELP = computer("computer_request_help");
export const LIST_FILES = computer("computer_list_files");
export const READ_FILE = computer("computer_read_file");

/** Everything the catalogue holds, for the hash a report records. */
export const ALL_COMPUTER_TOOLS = SHARED_COMPUTER_TOOLS;
