import { t } from "@/lib/i18n";

/**
 * WHETHER A DESTRUCTIVE ACTION STILL APPLIES, ASKED AT THE PRESS AND NOT AT RENDER.
 *
 * A confirm dialog is drawn from what the screen knew when it opened. Between that and the press,
 * another window — or a Bot, through its own tools — may have deleted the thing, and a delete sent
 * after that is either refused by the server or, worse, "succeeds" at nothing. So each destructive
 * dialog asks at the press (`ConfirmDialog`'s `recheck`) and gets back `null`, go ahead, or the one
 * sentence that says why not — and then nothing is sent (`docs/laf/dialogs.md`).
 *
 * ONE READ, AND ONLY A CLEAR ANSWER STOPS THE PRESS. A read that fails for another reason — a 500,
 * a list that did not parse — is not this check's to judge: the action goes, and its own answer is
 * what the person hears. A read that nothing answered throws, and `pressOnce` turns that into "the
 * server could not be reached" rather than sending a delete into the same silence.
 */

async function read(path: string): Promise<Response> {
  return fetch(path, { credentials: "include" });
}

/** The list a route answers with, or null when it did not answer with one. */
async function listFrom<T>(
  response: Response,
  field: string,
): Promise<T[] | null> {
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const list = body?.[field];
  return Array.isArray(list) ? (list as T[]) : null;
}

/** A Bot, before it is deleted. */
export async function botDeleteRecheck(
  agentId: string,
): Promise<string | null> {
  const response = await read(`/api/agents/${encodeURIComponent(agentId)}`);
  return response.status === 404
    ? t("This Bot has already been deleted.")
    : null;
}

/** A routine, before it is deleted. There is no read of one routine; gone from the list is gone. */
export async function routineDeleteRecheck(
  routineId: string,
): Promise<string | null> {
  const routines = await listFrom<{ id: string }>(
    await read("/api/routines"),
    "routines",
  );
  if (!routines) return null;
  return routines.some((routine) => routine.id === routineId)
    ? null
    : t("This routine has already been deleted.");
}

/** A routine's notepad, before it is emptied: its routine gone, or nothing in it to empty. */
export async function notepadClearRecheck(
  routineId: string,
): Promise<string | null> {
  const response = await read(
    `/api/routines/${encodeURIComponent(routineId)}/notepad`,
  );
  if (response.status === 404) {
    return t("This routine has already been deleted.");
  }
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as {
    notepad?: { entries?: unknown[] } | null;
  } | null;
  const entries = body?.notepad?.entries;
  return Array.isArray(entries) && entries.length === 0
    ? t("The notepad is already empty.")
    : null;
}

/**
 * A skill, before it is deleted. The server answers a delete of a skill that is not there with a
 * 200 and does nothing, so without this the dialog would close on a success that was not one.
 */
export async function skillDeleteRecheck(slug: string): Promise<string | null> {
  const skills = await listFrom<{ slug: string }>(
    await read("/api/plugins"),
    "skills",
  );
  if (!skills) return null;
  return skills.some((skill) => skill.slug === slug)
    ? null
    : t("This skill has already been deleted.");
}

/**
 * The shared computer, before it is reset through a row's Bot. The reset goes through that Bot,
 * and the server refuses it for one that is gone — the computer keeps listing it regardless.
 */
export async function computerResetRecheck(
  botId: string,
): Promise<string | null> {
  const computers = await listFrom<{ botId: string; mayDrive?: boolean }>(
    await read("/api/computers"),
    "computers",
  );
  if (!computers) return null;
  const row = computers.find((computer) => computer.botId === botId);
  return row && row.mayDrive !== false
    ? null
    : t(
        "That Bot is no longer there, so the computer cannot be reset through it.",
      );
}

/** A component written in the playground, before it is deleted. */
export async function playgroundDeleteRecheck(
  name: string,
): Promise<string | null> {
  const components = await listFrom<{ name: string }>(
    await read("/api/sandboxed"),
    "components",
  );
  if (!components) return null;
  return components.some((component) => component.name === name)
    ? null
    : t("It has already been deleted.");
}
