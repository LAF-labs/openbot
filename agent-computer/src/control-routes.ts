/**
 * Who has the wheel, over HTTP — and the one value a person types that the Bot must never see.
 *
 * The state machine is in `control.ts`, which has no Playwright in it so it can be tested without a
 * browser. These are the doors onto it, and the one place a secret enters the page.
 */
import type { BotRoute } from "./computer";
import { ControlRequestError, NO_SECRET_PENDING } from "./control";
import { locateRef, StaleSnapshotError } from "./refs";
import { bodyOf, describe, json } from "./respond";
import { rememberSecretField, SECRET_JOIN_TIMEOUT_MS } from "./secret-fields";

// Who has the wheel. Polled by the surface alongside the screen, so the person sees the Bot ask
// for help without having to reload anything.
export const controlState: BotRoute = ({ session }) =>
  json(session.control.get());

// The Bot asking for help. It does not take control: it says it is stuck and why, and a person
// decides. A Bot that could hand itself to a human could also hand a human a page they never
// asked to see.
export const requestHelp: BotRoute = async ({ request, session }) => {
  const body = await bodyOf<{ reason?: unknown }>(request);
  return json(session.control.requestHelp(body?.reason));
};

// The Bot asking for one value it must not be told. It has already focused the field.
export const requestSecret: BotRoute = async ({ request, session }) => {
  const body = await bodyOf<{
    label?: unknown;
    ref?: unknown;
    snapshotId?: unknown;
  }>(request);
  try {
    return json(session.control.requestSecret(body ?? {}));
  } catch (error) {
    if (error instanceof ControlRequestError) {
      return json({ error: error.message }, 400);
    }
    throw error;
  }
};

/**
 * A person supplying that value.
 *
 * Scoped by the pending request rather than by a control handover: it is usable only while the Bot
 * has actually asked for a secret, and the request is cleared the moment it is answered, so this
 * cannot be used as a general back door to type into the page.
 *
 * The value is typed and forgotten. Not stored on `control`, not returned in the response, not
 * logged. The response says how many characters arrived, which is enough for the surface to
 * confirm something was sent and useless to anybody reading it later.
 *
 * It types and does not submit. Committing a form is a separate action through the gateway and
 * audit trail; secret entry only places the value in the named field.
 */
export const supplySecret: BotRoute = async (
  { request, botId, session },
  { config, profiles },
) => {
  const pending = session.control.pendingSecret();
  if (!pending) {
    return json({ error: NO_SECRET_PENDING }, 409);
  }
  const body = await bodyOf<{ text?: unknown }>(request);
  if (typeof body?.text !== "string" || !body.text) {
    return json({ error: "A value is required." }, 400);
  }
  try {
    const target = await profiles.page(botId);
    // Focus the field the Bot named, and let this throw if it cannot be found. A secret must not
    // be reported as delivered unless a field receives it.
    //
    // No generation check here: a Bot may take another snapshot after asking for a secret, while
    // the ref remains protected by Playwright's `aria-ref` rules.
    //
    // `aria-ref` resolves a ref only against the most recent snapshot, only while the element is
    // still connected, and mints a
    // new ref when an element's role or accessible name changes, so a recycled node cannot
    // inherit an old one. If the ref resolves, it is the field the Bot meant. If it does not,
    // nothing is typed, which is the outcome the generation check existed to guarantee.
    const field = locateRef(session, target, pending.ref, undefined);
    await field.click({ timeout: config.actionTimeoutMs });
    await field.fill(body.text, { timeout: config.actionTimeoutMs });
    /*
     * THE NODE, NOT THE REF AND NOT THE VALUE. The next snapshot has to blank this field
     * whatever the page calls it, and a ref is re-minted the moment the page renames the box
     * while the value is the one thing this process must not keep. The element itself is
     * neither: it is where the secret is, until the page is gone. The short wait is for a page
     * that left on the keystroke — the value left with it, and the person is waiting.
     */
    rememberSecretField(
      session,
      await field
        .elementHandle({ timeout: SECRET_JOIN_TIMEOUT_MS })
        .catch(() => null),
      pending.ref,
    );
    const characters = body.text.length;
    // Cleared only after it actually landed, so a failure leaves the request open and the person
    // can try again rather than being told to start over.
    session.control.secretSupplied();
    return json({ supplied: true, characters, url: target.url() });
  } catch (error) {
    if (error instanceof StaleSnapshotError) {
      return json({ error: error.message, stale: true }, 409);
    }
    // The field is gone, which is unretryable, so the request is closed rather than left open.
    // Keeping it open is right for a mistyped value and wrong here: the person would retype their
    // password into the same dead ref for ever. Clearing it also unblocks the Bot, which can see
    // on its next turn that nothing is pending and ask again against a fresh snapshot.
    session.control.secretSupplied();
    return json(
      {
        error: describe(
          error,
          "That value could not be entered: the field is no longer on the page. Ask the assistant to request it again.",
        ),
      },
      502,
    );
  }
};

export const takeControl: BotRoute = ({ session }) =>
  json(session.control.take());

// `reason` is dropped on release: it described the thing the person was asked to do, and once
// they have done it, leaving it set would have the surface still showing the old request.
export const releaseControl: BotRoute = ({ session }) =>
  json(session.control.release());
