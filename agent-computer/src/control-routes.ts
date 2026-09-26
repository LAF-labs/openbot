/**
 * Who has the wheel, over HTTP — and the one value a person types that the Bot must never see.
 *
 * The state machine is in `control.ts`, which has no Playwright in it so it can be tested without a
 * browser. These are the doors onto it, and the one place a secret enters the page.
 */
import type { BotRoute } from "./computer";
import { ControlRequestError, NO_SECRET_PENDING } from "./control";
import { actionFailure } from "./failures";
import { inTurn, settleTyping } from "./person-typing";
import { locateRef, onElement, StaleSnapshotError } from "./refs";
import { bodyOf, fact, invalid, json } from "./respond";
import { rememberSecretField, SECRET_JOIN_TIMEOUT_MS } from "./secret-fields";
import { digestOf } from "./typed-values";
import { within } from "./within";

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
    // The one thing a request for a secret must say is which field it goes in.
    if (error instanceof ControlRequestError) return invalid("ref");
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
  if (!pending) return fact(NO_SECRET_PENDING);
  const body = await bodyOf<{ text?: unknown }>(request);
  const text = body?.text;
  if (typeof text !== "string" || !text) return invalid("text");
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
    await onElement(() => field.click({ timeout: config.actionTimeoutMs }));
    // A failure here must not say what it was filling: Playwright's message for it does.
    await onElement(() =>
      field.fill(text, { timeout: config.actionTimeoutMs }),
    );
    /*
     * THE NODE, NOT THE REF AND NOT THE VALUE. The next snapshot has to blank this field
     * whatever the page calls it, and a ref is re-minted the moment the page renames the box
     * while the value is the one thing this process must not keep. The element itself is
     * neither: it is where the secret is, until the page is gone. The short wait is for a page
     * that left on the keystroke — the value left with it, and the person is waiting.
     *
     * AND A DIGEST OF THE VALUE, which is not the value: the page this box is on may send it
     * away in an address — a form sent by GET — after the box itself is gone (audit R3-03), and
     * the digest is how that address is blanked (`typed-values.ts`).
     */
    const handle = await field
      .elementHandle({ timeout: SECRET_JOIN_TIMEOUT_MS })
      .catch(() => null);
    const frame = handle
      ? await within(SECRET_JOIN_TIMEOUT_MS, handle.ownerFrame())
      : null;
    rememberSecretField(session, handle, pending.ref, {
      ...(frame ? { frame } : {}),
      digest: digestOf(text),
    });
    const characters = text.length;
    // Cleared only after it actually landed, so a failure leaves the request open and the person
    // can try again rather than being told to start over.
    session.control.secretSupplied();
    return json({ supplied: true, characters, url: target.url() });
  } catch (error) {
    if (error instanceof StaleSnapshotError) return actionFailure(error);
    // The field is gone, which is unretryable, so the request is closed rather than left open.
    // Keeping it open is right for a mistyped value and wrong here: the person would retype their
    // password into the same dead ref for ever. Clearing it also unblocks the Bot, which can see
    // on its next turn that nothing is pending and ask again against a fresh snapshot.
    session.control.secretSupplied();
    return actionFailure(error);
  }
};

export const takeControl: BotRoute = ({ session }) =>
  json(session.control.take());

/*
 * `reason` is dropped on release: it described the thing the person was asked to do, and once
 * they have done it, leaving it set would have the surface still showing the old request.
 *
 * Every box the person typed into is read once more first, in turn behind their last keystroke: the
 * Bot acts next, and the Bot's Enter is what sends a form carrying the last thing they typed.
 */
export const releaseControl: BotRoute = async ({ session }) => {
  await inTurn(session, () => settleTyping(session, { every: true }));
  /*
   * AND THE PAGE THE BOT GETS BACK IS NOT THE ONE ITS LAST SNAPSHOT SAW. A person held the wheel:
   * they may have opened a layer, moved the focus, logged in, gone to another site in the same tab.
   * A new document already moves the generation (`watchPage`); what they did inside one does not,
   * and a ref-less Enter pressed on it would be judged against the snapshot from before they took
   * over. So the Bot looks again before it acts.
   */
  session.snapshotId += 1;
  return json(session.control.release());
};
