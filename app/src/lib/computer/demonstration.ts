/**
 * Teaching a Bot a task by doing it once, from the browser's side.
 *
 * Grok records your screen and turns it into a workflow you invoke with `/` or `@`. We cannot copy
 * the recording half — its agent runs on your machine, so demonstrating and doing happen in one
 * place, and ours works in a browser on a VM your Chrome is not. What we copy exactly is the shape
 * of it: start, then save or discard, and what you keep is a named thing the Bot can be pointed at.
 *
 * WHAT IT BECOMES IS A SKILL, which is the same object Grok calls a workflow — a slug you type
 * after `/`, a title, a line of summary, and the instruction itself. So there is no new noun here
 * and no new place to look: what a demonstration produces sits in the `/` menu beside everything
 * else somebody wrote.
 *
 * The recording lives on the server only while the wheel is held, and this module never sees an
 * input event: the person drives, the server records, and these calls read and dispose of what it
 * kept. Nothing is stored anywhere until somebody presses save.
 */

/** One thing that happened, as the server recorded it. Never what anybody typed. */
export type RecordedStep =
  | { kind: "opened"; url: string }
  | { kind: "pressed"; element: { role: string; name: string } | null }
  | { kind: "typed"; into: string | null }
  | { kind: "key"; key: string };

export type Recording = {
  steps: RecordedStep[];
  finished: boolean;
};

/** The three fields a skill is made of, drafted from the recording. */
export type Draft = {
  title: string;
  summary: string;
  instructions: string;
};

/** What was recorded, or null when this Bot is not being taught. Never throws. */
export async function readRecording(
  computerId: string,
): Promise<Recording | null> {
  try {
    const response = await fetch(
      `/api/computers/${encodeURIComponent(computerId)}/demonstration`,
      { credentials: "include" },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      demonstration?: Recording | null;
    };
    return body.demonstration ?? null;
  } catch {
    return null;
  }
}

/** Throw the recording away. What somebody decides not to keep should stop existing. */
export async function discardRecording(computerId: string): Promise<void> {
  await fetch(
    `/api/computers/${encodeURIComponent(computerId)}/demonstration`,
    {
      method: "DELETE",
      credentials: "include",
    },
  ).catch(() => {});
}

/**
 * Ask the server to write the recording up as a procedure.
 *
 * Null for every way there is no draft — a model that did not answer, a deployment with none, a
 * recording with nothing in it. The recording survives all of them, so the honest offer is to say
 * so and let the person press it again.
 */
export type WriteUpResult =
  | { ok: true; draft: Draft }
  /** The provider refused or ran out of patience. Pressing again now does the same thing. */
  | { ok: false; retryLater: true }
  /** Something came back and could not be used. Pressing again may well work. */
  | { ok: false; retryLater: false };

export async function writeUpRecording(
  computerId: string,
): Promise<WriteUpResult> {
  try {
    const response = await fetch(
      `/api/computers/${encodeURIComponent(computerId)}/demonstration/write-up`,
      { method: "POST", credentials: "include" },
    );
    const body = (await response.json().catch(() => null)) as {
      draft?: Draft;
      retryLater?: boolean;
    } | null;
    if (response.ok && body?.draft) return { ok: true, draft: body.draft };
    return { ok: false, retryLater: body?.retryLater === true };
  } catch {
    // The request never landed, which is the same thing to press: not now.
    return { ok: false, retryLater: true };
  }
}

/**
 * Save the draft as a skill, which is what makes it reachable.
 *
 * Straight to the skills surface, unchanged: a skill written this way is a skill somebody wrote,
 * and a second endpoint for "skills that came from a demonstration" would be a second set of rules
 * about who may write one and what it may say.
 */
export async function saveAsSkill(
  draft: Draft & { slug: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch("/api/plugins/skills", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    return { ok: false, error: body?.error ?? "" };
  } catch {
    return { ok: false, error: "" };
  }
}

/**
 * A title turned into something typeable after `/`.
 *
 * The skill routes take lower-case letters, numbers and hyphens, two to forty characters. A Korean
 * title has none of those, so it falls back to a stable prefix and a suffix from the clock rather
 * than refusing — the person can edit it, and a name somebody has to invent in English before they
 * can save is a step between them and the thing they just made.
 */
export function slugFrom(title: string, now = Date.now()): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug.length >= 2 ? slug : `task-${now.toString(36).slice(-6)}`;
}
