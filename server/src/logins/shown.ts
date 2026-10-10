/**
 * A PERSON'S SAVED PASSWORD, TAKEN OUT OF WHAT A MODEL IS HANDED — IN ANY RUN.
 *
 * The Bot's computer hides a value for as long as the run that put it into a page lasts, and then
 * forgets it (`agent-computer/src/filled-values.ts`). A site does not forget: what it kept in its
 * own storage stays in the browser's profile after the tab is closed, and a page of that site can
 * write it out again in a run where nothing was put in at all — where the computer holds nothing
 * and hides nothing. This server can still tell, because the vault is here
 * (`docs/laf/redesign-2026-10.md` §6, "실행이 끝난 뒤에는 서버가 한 번 더 거른다").
 *
 * WHERE A BROWSER TOOL'S OUTCOME BECOMES WHAT A MODEL READS, on both paths that hand one over: a
 * conversation's turn (`turns/chat-tools.ts`) and an unattended run (`runner/unattended.ts`). What
 * is filed in a conversation is what was handed over, so this is also what keeps it out of the
 * record.
 *
 * A STRING IS JUDGED BY THE ADDRESS OF THE THING THAT SAYS WHERE IT IS. An outcome says where its
 * page is (`url`), and so does each tab in its list and the page an act arrived at; the words in
 * each are looked through for the passwords saved FOR THAT ADDRESS and for no others. Not for all
 * of a person's passwords on every page: that would make this a way to ask what they are
 * (`LoginVault.passwordsAt`). A tab of some other site listed beside the page is judged by its own
 * address, and a thing with no address — a file's text, a refusal — is not a page and is not read.
 *
 * PASSWORDS, NOT NAMES. A sign-in name is on every page of the site it signed in to, by design.
 *
 * WHAT THIS DOES NOT REACH, said rather than left to be assumed: a document of the saved site
 * framed inside a page of another (the outcome carries the page's address, not each frame's); what
 * the trail and an approval card write about an act — the page's origin and path, and the name of
 * the element acted on — which the gateway reads before this does; a value a person typed into a
 * card, which this server never knew; a picture. The picture is why
 * every call is told on, with whether it was a hit (`seen`): a page whose words held the password
 * shows it on screen too, and whoever keeps pictures has to know which calls those were.
 */
import { BYTES_AS_TEXT, blankerOf } from "../../../shared/hidden-values";
import { toolResultText } from "../../../shared/prompt/tool-results.ko";
import { log } from "../log";
import type { LoginVault } from "./store";

type Blank = (text: string) => string;

/** The origin of a page at this address, as the browser counts one, or null for what is no page. */
function originOfPage(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  return url.protocol === "https:" || url.protocol === "http:"
    ? url.origin
    : null;
}

/** The origin of every page an outcome says something is at. */
export function pageOriginsIn(outcome: unknown): string[] {
  const origins = new Set<string>();
  const read = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const each of value) read(each);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, each] of Object.entries(value)) {
      if (key === "url" && typeof each === "string") {
        const origin = originOfPage(each);
        if (origin) origins.add(origin);
      } else {
        read(each);
      }
    }
  };
  read(outcome);
  return [...origins];
}

/**
 * An outcome with the passwords saved for each page's origin taken out of that page's words, and
 * whether anything was.
 *
 * THE NEAREST ADDRESS DECIDES, AND REPLACES THE ONE ABOVE IT. A list of tabs inside a page's
 * outcome is a list of other pages: a tab of another site is not looked through for this site's
 * password, and a tab of this site inside another's outcome is.
 */
export function withoutShown<T>(
  outcome: T,
  shown: ReadonlyMap<string, readonly string[]>,
): { outcome: T; hidden: boolean } {
  const blankers = new Map<string, Blank | null>();
  const blankAt = (address: string): Blank | null => {
    const origin = originOfPage(address);
    if (!origin) return null;
    if (!blankers.has(origin)) {
      blankers.set(origin, blankerOf(shown.get(origin) ?? []));
    }
    return blankers.get(origin) ?? null;
  };
  let hidden = false;
  const walk = (value: unknown, blank: Blank | null): unknown => {
    if (typeof value === "string") {
      if (!blank) return value;
      const left = blank(value);
      if (left !== value) hidden = true;
      return left;
    }
    if (Array.isArray(value)) return value.map((each) => walk(each, blank));
    if (value && typeof value === "object") {
      const at = (value as { url?: unknown }).url;
      const here = typeof at === "string" ? blankAt(at) : blank;
      return Object.fromEntries(
        Object.entries(value).map(([key, each]) => [
          key,
          // The same fields the computer's door skips (`shared/hidden-values.ts`).
          BYTES_AS_TEXT.has(key) ? each : walk(each, here),
        ]),
      );
    }
    return value;
  };
  const left = walk(outcome, null) as T;
  return { outcome: hidden ? left : outcome, hidden };
}

/** Said on an outcome something was hidden in, so the mark is not taken for the page's own. */
const SAID = toolResultText("laf:value_hidden");

/**
 * The outcome, saying that something in it was hidden — once, whoever hid it.
 *
 * Beside what it already says, in whichever shape that is: most outcomes carry a list of
 * sentences, and one that hands a Bot over to a person carries a single sentence, which is kept.
 */
function saying<T extends Record<string, unknown>>(outcome: T): T {
  const said = outcome.notes;
  const notes = Array.isArray(said)
    ? said
    : typeof said === "string" && said
      ? [said]
      : [];
  return notes.includes(SAID)
    ? outcome
    : { ...outcome, notes: [...notes, SAID] };
}

/** Whose run an outcome is being handed over in, and for which call. */
export type ShownRun = {
  /** The person whose vault it is: the one the Bot is acting for. */
  userId: string;
  botId: string;
  /** The conversation the run is in, when it is in one. */
  threadId?: string;
  /** The Bot's call the outcome answers: what a picture of the page would be filed under. */
  toolCallId?: string;
};

export type ShownGuard = <T>(run: ShownRun, outcome: T) => Promise<T>;

/**
 * The guard both paths put a browser tool's outcome through before a model reads it.
 *
 * THROWS WHERE THE VAULT CANNOT BE ASKED. An outcome that could not be checked is not handed over
 * as though it had been: both callers answer a throw as a call that failed, and the Bot looks
 * again. Where there is no vault at all, nothing was saved and there is nothing to look for.
 */
export function createShownGuard(deps: {
  logins?: Pick<LoginVault, "passwordsAt">;
  /**
   * Told of every outcome handed over, and whether a password was hidden in it. The page that
   * showed one is on screen, so nothing of the run is pictured from there on — and the calls
   * after a hit are the ones its picture would be filed under (`computer/gateway/secrets.ts`,
   * `handedOver`). Left out by a run nobody keeps a picture of.
   */
  seen?: (run: ShownRun, hidden: boolean) => void;
}): ShownGuard {
  /** Said once for each: a login this server cannot read is read at every look at its site. */
  const warned = new Set<string>();
  const vault = deps.logins;
  // No vault: nothing was saved, nothing can be shown back, and there is nobody to tell.
  if (!vault) return async (_run, outcome) => outcome;
  const hiddenIn = async <T>(
    run: ShownRun,
    outcome: T,
  ): Promise<{ outcome: T; hidden: boolean }> => {
    if (!outcome || typeof outcome !== "object") {
      return { outcome, hidden: false };
    }
    if (Array.isArray(outcome)) return { outcome, hidden: false };
    const origins = pageOriginsIn(outcome);
    if (origins.length === 0) return { outcome, hidden: false };
    const { shown, unreadable } = await vault.passwordsAt(run.userId, origins);
    const news = unreadable.filter((id) => !warned.has(id));
    if (news.length > 0) {
      for (const id of news) warned.add(id);
      log.warn("saved_login_unreadable", { bot: run.botId, logins: news });
    }
    if (shown.size === 0) return { outcome, hidden: false };
    const left = withoutShown(outcome, shown);
    return left.hidden
      ? {
          outcome: saying(left.outcome as Record<string, unknown>) as T,
          hidden: true,
        }
      : { outcome, hidden: false };
  };
  return async (run, outcome) => {
    const left = await hiddenIn(run, outcome);
    deps.seen?.(run, left.hidden);
    return left.outcome;
  };
}
