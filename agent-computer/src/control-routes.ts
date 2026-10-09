/**
 * What the Bot has asked a person for, over HTTP — and the one value a person types that the Bot
 * must never see.
 *
 * The state machine is in `control.ts`, which has no Playwright in it so it can be tested without a
 * browser. These are the doors onto it, and the one place a person's typing enters the page: there
 * is no door here, or anywhere in this process, by which a person clicks or types on the Bot's page
 * themselves (owner, 2026-10-09).
 */
import type { BotRoute } from "./computer";
import { ControlRequestError, NO_SECRET_PENDING } from "./control";
import { actionFailure } from "./failures";
import { holdToLabel } from "./label-hold";
import { onElement, resolveRef, STALE_REFS, StaleSnapshotError } from "./refs";
import { bodyOf, fact, invalid, json } from "./respond";
import { rememberSecretField, SECRET_JOIN_TIMEOUT_MS } from "./secret-fields";
import { assertLooked } from "./tab-loss";
import { digestOf } from "./typed-values";
import { within } from "./within";

// What the Bot is asking for. Polled by the surface alongside the screen, so the person sees the
// Bot ask for help without having to reload anything.
export const controlState: BotRoute = ({ session }) =>
  json(session.control.get());

// The Bot asking for a hand with something outside its screen. It says what and why, and a person
// answers: done, or skip.
//
// Which tab it asked on is kept: that page is where the Bot goes on from once they have, and it is
// not the tab closed to keep the Bot's tabs to their number while the ask stands (`tab-cap.ts`).
// Asked of the books, not of the browser — asking for a hand must not be what starts one.
export const requestHelp: BotRoute = async (
  { request, botId, session },
  { profiles },
) => {
  const body = await bodyOf<{ reason?: unknown }>(request);
  session.helpTab = profiles.tabOf(botId);
  return json(session.control.requestHelp(body?.reason));
};

/**
 * The Bot asking for one value it must not be told, into a field it names by a ref.
 *
 * A REF OF THE SNAPSHOT THE BOT IS ON, LIKE EVERY OTHER CALL THAT NAMES ONE. This door took any
 * ref with any snapshot id and wrote both down. Measured 2026-10-05: a Bot whose sign-in popup had
 * gone, and which had looked again with a read, could still ask for a value into the popup's ref —
 * and the person's value then went into whatever the page behind called that ref. A stale ref is
 * refused here as it is on a click, and one with no snapshot id is stale by definition.
 *
 * AND OF THE TAB THAT SNAPSHOT WAS OF, which is kept: the value goes into that tab or into none
 * (`supplySecret`).
 */
export const requestSecret: BotRoute = async (
  { request, botId, session },
  { profiles },
) => {
  const body = await bodyOf<{
    label?: unknown;
    ref?: unknown;
    snapshotId?: unknown;
  }>(request);
  // The one thing a request for a secret must say is which field it goes in.
  if (typeof body?.ref !== "string" || !body.ref.trim()) return invalid("ref");
  try {
    const tab = await profiles.page(botId);
    // The ref may be from before the Bot's tab went from under it: it names something on a page
    // that is gone, or on the tab the Bot is on now, which it has not seen.
    assertLooked(session);
    if (body.snapshotId !== session.snapshotId) {
      throw new StaleSnapshotError(STALE_REFS);
    }
    const state = session.control.requestSecret(body);
    session.secretTab = tab;
    return json(state);
  } catch (error) {
    if (error instanceof ControlRequestError) return invalid("ref");
    return actionFailure(error);
  }
};

/**
 * A person supplying that value.
 *
 * Scoped by the pending request: it is usable only while the Bot has actually asked for a secret,
 * and the request is cleared the moment it is answered, so this cannot be used as a general back
 * door to type into the page.
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
  const body = await bodyOf<{ text?: unknown; element?: unknown }>(request);
  const text = body?.text;
  if (typeof text !== "string" || !text) return invalid("text");
  try {
    const target = await profiles.page(botId);
    /*
     * INTO THE TAB IT WAS ASKED ON, OR INTO NONE. The ask ends when the tab it was made on goes
     * (`tab-loss.ts`), so nothing is pending by the time a person types and neither of these is
     * reached that way. They are here because what they guard is a person's password, and the
     * rule below is true of one tab only: a tab a site opened while the Bot waited becomes the
     * Bot's tab without any tab having been lost, and the value was not asked for there.
     */
    assertLooked(session);
    if (session.secretTab !== target) throw new StaleSnapshotError(STALE_REFS);
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
    //
    // ON THE TAB THE BOT ASKED ON, which is the half of that the rules do not give: each tab has
    // its own most recent snapshot, and the same ref names a different box on each.
    //
    // AND HELD TO WHAT THE GATE JUDGED IT AS (2026-10-10). The paragraph above rests on how
    // Playwright mints refs, which is its business and can change under us; a click has not rested
    // on it since 2026-09-07 (`label-hold.ts`). The server sends the role and the name its policy
    // judged the request on, and a field that is called something else by now — or is no longer
    // there to be asked — gets no value: a person's password goes into the box they were shown
    // the name of, or nowhere. An older server sends neither and is held to neither.
    const field = await resolveRef(session, target, pending.ref, undefined);
    await holdToLabel(field, body?.element);
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
    // Cleared only after it actually landed.
    session.control.secretSupplied();
    session.secretTab = undefined;
    return json({ supplied: true, characters, url: target.url() });
  } catch (error) {
    /*
     * THE VALUE REACHED NO FIELD, AND THE BOT IS NOT TOLD IT DID. The field is gone, which is
     * unretryable, so the request is closed rather than left open: the person would retype their
     * password into the same dead ref for ever. But closed as what it was. This called
     * `secretSupplied`, and an ask that is simply gone is read by the Bot's wait as answered — the
     * Bot heard "이 사람이 그 값을 칸에 직접 입력했다" and went on to press the button under an
     * empty box. Closed as nobody's answer (`ControlState.unanswered`), the wait says the value
     * was not entered, and the person's own card has this failure's code to say why.
     */
    session.control.secretNotSupplied();
    session.secretTab = undefined;
    return actionFailure(error);
  }
};

/*
 * A person answering an ask: 다 했어요 on a request for help, or 건너뛰기 on either kind, which the
 * surface tells the waiting turn about first (`server/src/turns/people.ts`) and then sends here so
 * the next ask finds none standing. `reason` and any pending secret are dropped with it.
 */
export const releaseControl: BotRoute = ({ session }) =>
  json(session.control.release());
