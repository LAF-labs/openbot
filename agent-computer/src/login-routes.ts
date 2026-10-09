/**
 * A SAVED LOGIN, PUT INTO THE SITE IT WAS SAVED FOR AND NOWHERE ELSE (2026-10-10, record §6).
 *
 * A person saves a sign-in name and a password for a site, and the server puts them into the
 * Bot's browser when the Bot comes to that site's sign-in — nobody types, and no model is shown a
 * value. What keeps a page from talking the Bot into putting that password somewhere else is what
 * a password manager uses: the value goes only where it was saved for.
 *
 * THE FRAME THE BOX IS IN, NOT THE PAGE THE TAB IS ON. A sign-in box is often in a frame from
 * another origin, and a page of anybody's can put a box on the screen: what is compared with the
 * origins a login was saved for is the address of the box's own document. HTTPS, by the one rule
 * that also judged the origin when it was saved (`shared/login-origin.ts`).
 *
 * ASKED TWICE, BY THE ONE WHO KNOWS. The server asks first where the boxes are (`whereFields`) —
 * that is how it finds which saved login is this site's, and it sends no value until it has. And
 * the values are held to the same question when they arrive (`fillLogin`): every box is asked
 * again, before any value goes in, because a page may have put another document's box under the
 * same ref between the two calls, and only this process can see that. Once, not box by box: a
 * node cannot move to a document of another origin, so what was true of a box before the first
 * value is true of it when its own goes in — or the box is gone, and nothing goes in.
 */
import type { Locator } from "playwright";
import { isSavedOrigin } from "../../shared/login-origin";
import { SECRET_FIELDS_MAX } from "../../shared/secret-ask";
import type { BotRoute } from "./computer";
import { type Box, putValues } from "./control-routes";
import { actionFailure } from "./failures";
import { holdToLabel } from "./label-hold";
import { LoginOriginError } from "./origin-hold";
import { resolveRef, STALE_REFS, StaleSnapshotError } from "./refs";
import { bodyOf, invalid, json } from "./respond";
import { SECRET_JOIN_TIMEOUT_MS } from "./secret-fields";
import { assertLooked } from "./tab-loss";
import { within } from "./within";

/** The address of the document a control is in, or null where the page would not say. */
async function documentOf(field: Locator): Promise<string | null> {
  const handle = await field
    .elementHandle({ timeout: SECRET_JOIN_TIMEOUT_MS })
    .catch(() => null);
  if (!handle) return null;
  const frame = await within(SECRET_JOIN_TIMEOUT_MS, handle.ownerFrame());
  void handle.dispose().catch(() => undefined);
  return frame ? frame.url() : null;
}

/**
 * The origin of that document, as an address is written — never the address itself, whose path
 * and query are the page's and may be a person's. Empty for a document with no web origin: a
 * frame written in place (`about:srcdoc`), a `data:` page.
 */
function originOf(address: string | null): string {
  if (!address || !URL.canParse(address)) return "";
  const { origin } = new URL(address);
  return origin === "null" ? "" : origin;
}

/** The refs a call names, or null where it names none, too many, or something that is not one. */
function refsOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0 || value.length > SECRET_FIELDS_MAX) return null;
  return value.every((ref) => typeof ref === "string" && ref.trim())
    ? (value as string[])
    : null;
}

/**
 * `POST /login/where`: which origin each of these boxes is in. Read-only — nothing on the page
 * changes, no ask is opened, and nobody is shown anything.
 *
 * A REF OF THE SNAPSHOT THE BOT IS ON, like every call that names one: an origin read off a ref
 * from another look would be the origin of whatever that ref names now.
 */
export const whereFields: BotRoute = async (
  { request, botId, session },
  { profiles },
) => {
  const body = await bodyOf<{ refs?: unknown; snapshotId?: unknown }>(request);
  const refs = refsOf(body?.refs);
  if (!refs) return invalid("refs");
  try {
    const target = await profiles.page(botId);
    assertLooked(session);
    if (body?.snapshotId !== session.snapshotId) {
      throw new StaleSnapshotError(STALE_REFS);
    }
    const fields = [];
    for (const ref of refs) {
      const field = await resolveRef(session, target, ref, undefined);
      fields.push({ ref, origin: originOf(await documentOf(field)) });
    }
    return json({ fields });
  } catch (error) {
    return actionFailure(error);
  }
};

/**
 * `POST /login/fill`: a saved login's values, each into its box — if every box is still what the
 * gate judged it as, in a document of an origin the login was saved for.
 *
 * EVERY BOX IS ASKED BEFORE ANY VALUE GOES IN, as with a person's card (`control-routes.ts`): a
 * sign-in name is not left in a page whose password box turned out to be somebody else's.
 *
 * WHAT WENT IN IS HELD FOR THE RUN, exactly as a person's value is (`filled-values.ts`): the
 * page that shows a sign-in name back shows this one too.
 *
 * It fills and does not submit. Pressing the button is the Bot's next act, judged on its own.
 */
export const fillLogin: BotRoute = async (
  { request, botId, session },
  { profiles, config },
) => {
  const body = await bodyOf<{
    fields?: unknown;
    snapshotId?: unknown;
    origins?: unknown;
  }>(request);
  const named = Array.isArray(body?.fields)
    ? body.fields.map((field) =>
        field && typeof field === "object"
          ? (field as { ref?: unknown; element?: unknown; value?: unknown })
          : {},
      )
    : [];
  if (!refsOf(named.map((field) => field.ref))) return invalid("fields");
  if (!named.every((field) => typeof field.value === "string" && field.value)) {
    return invalid("fields");
  }
  const origins = Array.isArray(body?.origins)
    ? body.origins.filter((origin) => typeof origin === "string")
    : [];
  // Saved for nowhere is saved for nowhere: no origin is every origin's mismatch, said as one.
  const savedFor = (address: string | null) =>
    address !== null &&
    isSavedOrigin(origins as string[], address, {
      // A developer's own stack, where the page under test has no certificate. The same opt-in
      // that lets the browser open a loopback address at all, and never a deployment's.
      allowLoopbackHttp: config.allowPrivateHosts,
    });
  try {
    const target = await profiles.page(botId);
    assertLooked(session);
    if (body?.snapshotId !== session.snapshotId) {
      throw new StaleSnapshotError(STALE_REFS);
    }
    const boxes: Box[] = [];
    for (const { ref, element } of named) {
      const field = await resolveRef(session, target, ref as string, undefined);
      await holdToLabel(field, element);
      if (!savedFor(await documentOf(field))) throw new LoginOriginError();
      boxes.push({ field, judged: element, ref: ref as string });
    }
    await putValues(
      { session, target, config },
      boxes,
      named.map((field) => field.value as string),
    );
    // How many boxes, and where the tab is — never what went into any of them.
    return json({ filled: true, fields: boxes.length, url: target.url() });
  } catch (error) {
    return actionFailure(error);
  }
};
