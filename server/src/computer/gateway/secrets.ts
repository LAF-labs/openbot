/**
 * The one path on which a value travels from a person's keyboard to a page, and what this server
 * remembers about it afterwards.
 *
 * Everything that knows WHICH box holds a secret is here: the field an open request names, the
 * fields a person has already typed into, and the masking every later snapshot passes through on
 * its way into this process. It is the path audit A3's S1 leak ran along (2026-09-10) and the one
 * W1-b closed, so it is kept where the whole of it can be read at once — a request resolved
 * against the snapshot, a field followed by identity rather than wording, a value that never
 * crosses this process.
 */

import { secretFieldsOf } from "../../../../shared/secret-ask";
import type { AuditStore } from "../../audit";
import { describeFailure } from "../../failure-text";
import { log } from "../../log";
import { LoginSealError } from "../../logins/crypto";
import type { LoginVault } from "../../logins/store";
import {
  type ComputerClient,
  ComputerUnavailableError,
  type FieldWhere,
  NO_SECRET_PENDING,
  STALE_REFS,
  STOPPED,
  StaleSnapshotError,
} from "../client";
import { isSecretFieldElement } from "../default-policy";
import type { PolicyDecision } from "../policy";
import type {
  ControlState,
  SecretInto,
  SecretRequest,
  SnapshotElement,
  SnapshotResult,
} from "../schema";
import { hostOf, originOf } from "./addresses";
import { type ActionActor, ActionRefusedError } from "./caller";
import type { Govern } from "./govern";
import { FILL_LOGIN_TOOL } from "./intent";
import type { SnapshotCache } from "./snapshots";
import { write, writeControlEvent } from "./trail";

/** A field a person typed a secret into, as this server can know it: its ref, on an origin. */
type TypedInto = { ref: string; origin: string; role: string; name: string };

/** How long the computer is given to hear that a stopped caller's ask is taken back. */
const WITHDRAW_MS = 5_000;

/**
 * A card values are waiting for: the snapshot it was judged in, where, and each box as what it
 * was judged as, in the card's order. See `supplySecret`.
 */
type Requested = {
  snapshotId: number;
  origin: string;
  fields: { ref: string; role: string; name: string }[];
  /** The conversation whose run asked, where it said. Whose run the values are put in for. */
  threadId?: string;
};

/** A run that named no conversation, or one this server learnt of from the computer. */
const ANY_RUN = "";

/** How many calls a picture stays refused for after their run. A turn is some tens of calls. */
const SHOWN_CALLS_MAX = 512;

/**
 * What a request for values came to, when a login the person saved answered it instead of them.
 *
 * `loginFilled`: the values went in — which login, by id and site, and into how many boxes;
 * nothing of the values. `loginChoice`: the site has several saved logins and the Bot named none,
 * so nothing was put in and nobody was asked: what each is called, for the Bot to choose by.
 */
export type SavedLoginAnswer = {
  loginFilled?: { id: string; site?: string; fields: number };
  loginChoice?: { id: string; label: string; site?: string }[];
  /**
   * Nobody is there to be asked, and no saved login answered: nothing was put in and no card was
   * opened. Only where the asker said there is nobody (`requestSecret`, `nobodyToAsk`).
   */
  loginNotSaved?: true;
};

/**
 * What asking for values answers: the Bot's control state as the computer has it — with where
 * the open request points, while a person is being asked — and, where a saved login answered
 * instead, what it came to.
 */
export type SecretAsked = ControlState & {
  secretInto?: SecretInto;
} & SavedLoginAnswer;

/**
 * How many such fields one computer's snapshots are masked against. Two cards of the most boxes
 * a card holds (`SECRET_FIELDS_MAX`) and a few besides: it was eight when a card held one.
 */
const TYPED_INTO_LIMIT = 16;

/** The roles a value can be typed into. What `computer_request_secret` may name. */
const SECRET_ENTRY_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "input",
]);

/**
 * The element, minus the value of a secret field.
 *
 * The computer already drops these; this is the same rule applied where the snapshot enters this
 * process, so an older `agent-computer` image cannot hand a password to the model through a server
 * that knows better.
 */
function withoutSecretValue(element: SnapshotElement): SnapshotElement {
  if (element.value === undefined || !isSecretFieldElement(element)) {
    return element;
  }
  return { ...element, value: "" };
}

/**
 * A person's answer that is not an answer to the card that stands: not one value for each of its
 * boxes. Its own error because nothing was wrong with the page or the request — the route says it
 * as the same fact it says for a body with no value at all (`routes.ts`).
 */
export class SecretValuesError extends Error {
  readonly code = "laf:secret_value_required";
  constructor() {
    super("laf:secret_value_required");
    this.name = "SecretValuesError";
  }
}

export function createSecrets(deps: {
  /** The computer, addressed as the Bot that is asking. See `createComputerGateway`. */
  as: (botId: string) => ComputerClient;
  auditStore: AuditStore;
  snapshots: SnapshotCache;
  /**
   * The gate every acting call goes through. Handed in as a function because it is made after
   * this is (`gateway.ts`: it reads `suppliedOn` from here), and called only once both exist.
   */
  govern: Govern;
  /**
   * What the deployment's people saved for their Bot's browser. Absent where there is no vault,
   * and then every value is asked of a person, as it always was.
   */
  logins?: Pick<LoginVault, "forOrigin" | "open" | "used">;
}) {
  const { as, auditStore, snapshots, govern } = deps;
  /**
   * Where each open secret request points, as this server resolved it when the request was made.
   *
   * Held here rather than read back off the computer, because the computer keeps the Bot's label
   * and the ref and nothing else — and the host and the control's own name are what a person needs
   * beside a label a model wrote. Cleared when the value is supplied.
   */
  const secretTargets = new Map<string, SecretInto>();
  /**
   * The field the open secret request names, and the fields a person has already typed one into —
   * the second is what every later snapshot is masked against.
   *
   * IDENTITY, NOT WORDING. The auditor's box was called 패스워드, a word neither list had, and it
   * was marked by nothing the tree carries (2026-09-10). The computer follows the node itself; this
   * is the same rule where the snapshot enters this process, for a computer image that predates it.
   * A ref is Playwright's name for one element for as long as the element keeps its role and name,
   * and a new document never reuses one (every navigation prefixes them afresh, measured `e5` →
   * `f2e5`) — so the ref is the identity. The origin, role and name are held beside it against a
   * browser that closed while idle and began counting from `e1` again, where the same ref is
   * somebody else's box: they cost nothing, because a box renamed under the same browser is handed
   * a new ref anyway. Not the path: a single-page app moves its path under a box still holding the
   * value.
   */
  const secretRequests = new Map<string, Requested>();
  const typedInto = new Map<string, TypedInto[]>();
  /**
   * The Bots a value was put into the browser for, and the runs it was put in for — until the
   * computer has been told each run is over (`runEnded`).
   *
   * WHOSE RUN, BECAUSE A BOT MAY BE ON TWO. A routine's run ends while the person's conversation
   * is half-way through the site it just signed in to; told of that end, the computer would close
   * the tab the conversation is working in. So an end is passed on only for a run that put a value
   * in — by its conversation, which is what both the ask and the end of a turn name.
   *
   * IN THIS PROCESS, LIKE THE REST HERE, AND RELEARNT WHEN IT IS LOST. The computer says for itself
   * that it is holding a value (`ControlState.valuesHeld`), and a server that started again
   * mid-run reads that the next time anybody asks for the control state (`valuesSeen`). Whose run
   * it was is not something the computer knows, so the next run of that Bot's to end ends it.
   */
  const valueRuns = new Map<string, Set<string>>();
  const putInFor = (botId: string, threadId: string | undefined): void => {
    const runs = valueRuns.get(botId) ?? new Set<string>();
    runs.add(threadId ?? ANY_RUN);
    valueRuns.set(botId, runs);
  };

  /**
   * The runs in which a saved password was taken out of something handed to a model
   * (`logins/shown.ts`), by Bot — and the calls of those runs, from the one it was hidden in on.
   *
   * APART FROM `valueRuns`, BECAUSE NOTHING WAS PUT IN. An end of a run noted there is passed on to
   * the computer, which closes every tab a value went into, whoever's run put it there. A run that
   * only read a page has no tab of its own to close, and its end must not close another run's.
   *
   * THE RUN, AND THEN ITS CALLS. For the rest of the run nothing of the Bot's browser is pictured:
   * the page whose words held the password is the page on screen, and it is still there through a
   * scroll that hands over no words. The run's end lets go of that — but a picture belongs to a
   * call, and the window offers it when a task is over, again while the call's result is on its
   * way, and after a stop not until the next turn (`app/src/lib/computer/last-frame.ts`). So the
   * calls handed over from the hit on are remembered past the run, and refused by name.
   */
  const shownRuns = new Map<string, Set<string>>();
  const shownCalls = new Set<string>();
  const callOf = (botId: string, toolCallId: string) =>
    `${botId} ${toolCallId}`;

  /**
   * A browser call's outcome was handed to a model in this run; `hidden` where a saved password
   * was taken out of it. Every call is told here, not only a hit: the ones after it are what the
   * picture of that page would be filed under.
   */
  function handedOver(
    botId: string,
    run: { threadId?: string; toolCallId?: string },
    hidden: boolean,
  ): void {
    const key = run.threadId ?? ANY_RUN;
    if (hidden) {
      const runs = shownRuns.get(botId) ?? new Set<string>();
      runs.add(key);
      shownRuns.set(botId, runs);
    }
    if (!run.toolCallId || !shownRuns.get(botId)?.has(key)) return;
    const call = callOf(botId, run.toolCallId);
    shownCalls.delete(call);
    shownCalls.add(call);
    // The oldest goes first: a picture is offered within a turn or two of its call, not a day on.
    for (const oldest of shownCalls) {
      if (shownCalls.size <= SHOWN_CALLS_MAX) break;
      shownCalls.delete(oldest);
    }
  }

  /**
   * Whether a value is being held in this Bot's browser, as far as this server knows — or a page
   * in it showed a saved password to a run that has not ended.
   */
  function holdsValues(botId: string): boolean {
    return valueRuns.has(botId) || shownRuns.has(botId);
  }

  /** Whether a picture offered for this call of this Bot's is one not to keep. */
  function frameWithheld(botId: string, toolCallId?: string): boolean {
    return (
      holdsValues(botId) ||
      (toolCallId !== undefined && shownCalls.has(callOf(botId, toolCallId)))
    );
  }

  /** This Bot's browser was stopped or reset: its tabs are closed, and what was held went with them. */
  function valuesLetGo(botId: string): void {
    valueRuns.delete(botId);
    shownRuns.delete(botId);
  }

  /** The computer said it holds a value this server has no note of: one from before a restart. */
  function valuesSeen(botId: string): void {
    if (!valueRuns.has(botId)) putInFor(botId, undefined);
  }

  /**
   * A run of this Bot's is over. If it is one a value was put in for, the computer is told, and
   * closes the tabs the value went into before it stops hiding it.
   *
   * Never throws: this is called as a turn is let go of, where there is nobody to answer an error
   * to. A computer that could not be told, or could not close a tab, is still holding the value —
   * and is still noted here as holding it, so the next run to end tells it again.
   */
  async function runEnded(botId: string, threadId?: string): Promise<void> {
    // What this run was only shown is this server's note alone: let go of here, and the computer
    // is told nothing on its account (`shownRuns`).
    const shown = shownRuns.get(botId);
    if (shown?.delete(threadId ?? ANY_RUN) && shown.size === 0) {
      shownRuns.delete(botId);
    }
    const runs = valueRuns.get(botId);
    if (!runs) return;
    if (!runs.has(threadId ?? ANY_RUN) && !runs.has(ANY_RUN)) return;
    // ONLY THE RUNS NOTED BEFORE THE COMPUTER WAS TOLD. A value put in for another run while this
    // is on its way may reach the computer after it has let go of everything, and that run's note
    // has to outlive this answer: it is what tells the computer at that run's own end.
    const ending = [...runs];
    try {
      const { ended } = await as(botId).runEnded();
      if (!ended) {
        log.warn("computer_values_still_held", { bot: botId });
        return;
      }
      for (const run of ending) runs.delete(run);
      if (runs.size === 0 && valueRuns.get(botId) === runs) {
        valueRuns.delete(botId);
      }
    } catch (error) {
      log.warn("computer_run_end_not_told", {
        bot: botId,
        reason: describeFailure(error),
      });
    }
  }

  function forgetTypedInto(computerId: string): void {
    typedInto.delete(computerId);
    secretRequests.delete(computerId);
  }

  /** A snapshot's elements, masked against what this server knows about secret fields. */
  function withoutSecrets(
    computerId: string,
    result: SnapshotResult,
  ): SnapshotElement[] {
    const origin = originOf(result.url);
    const fields = (typedInto.get(computerId) ?? []).filter(
      (field) => field.origin === origin,
    );
    return result.elements.map((element) => {
      const typed = fields.some(
        (field) =>
          field.ref === element.ref &&
          field.role === element.role &&
          field.name === element.name,
      );
      if (!typed) return withoutSecretValue(element);
      // A person put a secret in this box. It is a password field from here on, whatever it says.
      return {
        ...element,
        type: "password",
        ...(element.value === undefined ? {} : { value: "" }),
      };
    });
  }

  /** Where the open secret request points, if one is open. See `control` in `handovers.ts`. */
  function targetOf(botId: string) {
    return secretTargets.get(botId);
  }

  /**
   * Whether a person put a secret into a field on this page's site. The high-risk check reads it:
   * a password entered and then a press is a sign-in or a change of the password, and only the
   * second is something a standing allowance should not carry.
   */
  function suppliedOn(computerId: string, pageUrl: string): boolean {
    const origin = originOf(pageUrl);
    return (typedInto.get(computerId) ?? []).some(
      (field) => field.origin === origin,
    );
  }

  /**
   * The login a person saved for the site these boxes are on, opened — or what there is instead.
   *
   * A LOGIN ANSWERS ONLY A SIGN-IN, AND ONLY ITS OWN SITE'S (2026-10-10, record §6, piece 2-4):
   *
   *  - THE BOXES ARE A PASSWORD BOX, WITH OR WITHOUT ONE BOX FOR THE NAME. Read off each box's own
   *    markup by the computer (`FieldWhere.kind`), never off what the Bot called it or what a look
   *    marked: a look marks a texted code and a card number as secret too, and a saved password
   *    goes into neither. Anything else on the card — a third box, a lone text box — and a
   *    person is asked, as before.
   *  - THEY ARE ALL IN ONE DOCUMENT, OF AN ORIGIN THE LOGIN WAS SAVED FOR. The document the box is
   *    in, which in a frame is not the page the tab is on; HTTPS, by the rule that read the origin
   *    when it was saved (`shared/login-origin.ts`, asked of the vault). The computer holds the
   *    values to the same origins again when they arrive.
   *  - ONE LOGIN, OR THE ONE THE BOT NAMED. Several for one site are named back — what each is
   *    called, never what it holds — and nobody is asked; a name that is not one of this site's
   *    is refused with a row, because a page can tell a Bot which login to ask for.
   *
   * NULL IS "ASK THE PERSON", and it is the answer whenever this cannot be sure: no vault, a
   * computer from before it could say where a box is, a seal that does not open (said in the log;
   * the person types it this once and the 계정 screen is where it is mended).
   */
  async function savedLoginFor(
    computerId: string,
    botId: string,
    actor: ActionActor,
    input: SecretRequest,
    fields: readonly { ref: string }[],
    pageUrl: string,
  ): Promise<
    | { choose: { id: string; label: string; site?: string }[] }
    | {
        login: { id: string; site?: string; origins: readonly string[] };
        /** The value for each box, in the card's order. */
        values: string[];
      }
    | null
  > {
    const vault = deps.logins;
    if (!vault) return null;
    let where: FieldWhere[];
    try {
      ({ fields: where } = await as(botId).whereFields(
        fields.map((field) => field.ref),
        input.snapshotId,
      ));
    } catch (error) {
      // The page moved on: the request is stale whoever would have answered it.
      if (error instanceof StaleSnapshotError) throw error;
      // A computer that cannot say — an image from before this, for the length of a rollout.
      return null;
    }
    const kinds = fields.map(
      (field) => where.find((one) => one.ref === field.ref)?.kind ?? "other",
    );
    const passwords = kinds.filter((kind) => kind === "password").length;
    const names = kinds.filter((kind) => kind === "text").length;
    if (passwords !== 1 || names > 1 || passwords + names !== fields.length) {
      return null;
    }
    const origins = new Set(where.map((one) => one.origin));
    const [origin] = origins;
    if (origins.size !== 1 || !origin) return null;

    const candidates = await vault.forOrigin(actor.id, origin);
    const named =
      typeof input.login === "string"
        ? candidates.find((login) => login.id === input.login)
        : undefined;
    if (typeof input.login === "string" && !named) {
      const refusal: PolicyDecision = {
        allowed: false,
        matched: null,
        source: "deny",
        forward: false,
        code: "laf:login_not_for_this_site",
      };
      await write(auditStore, {
        toolName: FILL_LOGIN_TOOL,
        botId,
        actor,
        computerId,
        element: undefined,
        ref: fields[0]?.ref,
        filePath: undefined,
        pageUrl,
        decision: refusal,
      });
      throw new ActionRefusedError(null, "laf:login_not_for_this_site");
    }
    const chosen = named ?? (candidates.length === 1 ? candidates[0] : null);
    if (!chosen) {
      if (candidates.length === 0) return null;
      return {
        choose: candidates.map(({ id, label, site }) => ({
          id,
          label,
          ...(site ? { site } : {}),
        })),
      };
    }
    let opened: Awaited<ReturnType<typeof vault.open>>;
    try {
      opened = await vault.open(actor.id, chosen.id);
    } catch (error) {
      if (!(error instanceof LoginSealError)) throw error;
      log.warn("saved_login_unreadable", { bot: botId, login: chosen.id });
      return null;
    }
    // Removed between the list and now: there is no login, and the person is asked.
    if (!opened) return null;
    return {
      login: {
        id: chosen.id,
        ...(chosen.site ? { site: chosen.site } : {}),
        origins: opened.login.origins,
      },
      values: kinds.map((kind) =>
        kind === "password" ? opened.password : opened.username,
      ),
    };
  }

  /**
   * Asking for a secret, and supplying one.
   *
   * Both are audited, and neither records the value. The row says a secret was asked for, what it
   * was called, and which field it went in, the things an investigator needs in order to know a
   * human credential entered this session. The value itself is on one path only, from a person's
   * keyboard to the page, and is not on this one.
   */
  async function requestSecret(
    computerId: string,
    botId: string,
    actor: ActionActor,
    input: SecretRequest,
    /** A person's answer, where a rule asked about this request before it was made. */
    approvalId?: string,
    /** The caller's Stop. */
    signal?: AbortSignal,
    /**
     * A run with nobody in front of it (a routine's): the vault answers or nothing does. No card
     * is opened on the computer — one would wait for its ten minutes on a person who is not
     * there, holding the Bot's browser on a box nobody will fill — and a rule that refuses the
     * saved login is the answer, since there is no person for the refusal to fall through to.
     */
    options: { nobodyToAsk?: true } = {},
  ): Promise<SecretAsked> {
    /*
     * THE FIELD IS RESOLVED HERE, NEVER TAKEN FROM THE BOT.
     *
     * This call used to go straight to the computer with whatever ref and label the model sent,
     * outside the policy and outside the snapshot: a page that steered the Bot could ask for
     * "네이버 비밀번호" into a box of its own, and the masked prompt showed the person exactly that.
     * The ref now has to name a field on the snapshot this server holds, the host and the field's
     * own label are recorded and returned beside the Bot's words, and a ref that resolves to
     * nothing — or to a button — is refused with a row, like any other action.
     */
    const cached = snapshots.get(computerId);
    if (!cached || cached.stale || cached.snapshotId !== input.snapshotId) {
      throw new StaleSnapshotError(STALE_REFS);
    }
    /*
     * EVERY BOX OF THE CARD, EACH RESOLVED THE SAME WAY (2026-10-10, `shared/secret-ask.ts`). A
     * card with no box, with more than a card holds, or with one box twice is not a card: said as
     * a ref that names no field, which is what it is to the model that wrote it.
     */
    const asked = secretFieldsOf(input);
    const resolved = (asked ?? []).map((field) => ({
      ...field,
      element: cached.elements.get(field.ref),
    }));
    const notAField = asked
      ? resolved.find(
          (field) =>
            !field.element || !SECRET_ENTRY_ROLES.has(field.element.role),
        )
      : { ref: "", element: undefined };
    if (notAField) {
      const { element } = notAField;
      const refusal: PolicyDecision = {
        allowed: false,
        matched: null,
        source: "deny",
        forward: false,
        code: "laf:secret_target_not_a_field",
      };
      await write(auditStore, {
        toolName: "computer_request_secret",
        botId,
        actor,
        computerId,
        element,
        ref: notAField.ref || undefined,
        filePath: undefined,
        pageUrl: cached.url,
        decision: refusal,
      });
      throw new ActionRefusedError(null, "laf:secret_target_not_a_field");
    }
    // Each label is one line, bounded (`secretFieldsOf`): it is drawn above a masked box and
    // written into the trail.
    const fields = resolved.flatMap((field) =>
      field.element
        ? [
            {
              ref: field.ref,
              label: field.label,
              role: field.element.role,
              name: field.element.name,
            },
          ]
        : [],
    );
    const [first, ...rest] = fields;
    if (!first) throw new StaleSnapshotError(STALE_REFS);
    const host = hostOf(cached.url);
    /*
     * A LOGIN THE PERSON SAVED FOR THIS SITE ANSWERS BEFORE THEY ARE ASKED (record §6, piece 2-4).
     *
     * The Bot asks the same way either way — "these boxes need values I must not know" — and
     * who holds them is this server's to settle: the vault where the person put a login for this
     * origin, the person otherwise. No tool was added for it and no model is shown a value; the
     * Bot is told only that the boxes were filled (`SavedLoginAnswer`).
     *
     * THE FILL IS THE BOT'S ACT, JUDGED AS IT HAPPENS, under an intent of its own (`fill_login`):
     * nobody is asked and a stored credential is used, which is not what `fill_secret` is a rule
     * about. It leaves the rows every act leaves, with which login beside which boxes on which
     * site — never the name a person gave it, never a value.
     *
     * A RULE THAT REFUSES THE SAVED LOGIN DOES NOT REFUSE THE PERSON. "Never use a saved login on
     * this host" is a rule about the vault; whether the Bot may ask the person to type is the
     * other intent's, decided next, with its own row. Without this a refused login would leave
     * the Bot no way to ask at all — the same call, answered the same way, for ever.
     */
    const saved = await savedLoginFor(
      computerId,
      botId,
      actor,
      input,
      fields,
      cached.url,
    );
    if (saved && "choose" in saved) {
      return { ...(await as(botId).control()), loginChoice: saved.choose };
    }
    if (saved) {
      const { login, values } = saved;
      try {
        await govern(
          computerId,
          FILL_LOGIN_TOOL,
          botId,
          actor,
          {
            ref: first.ref,
            ...(rest.length > 0
              ? { alsoRefs: rest.map((field) => field.ref) }
              : {}),
            login: {
              id: login.id,
              ...(login.site ? { site: login.site } : {}),
            },
            ...(signal ? { signal } : {}),
            ...(approvalId ? { approvalId } : {}),
          },
          async (judgedFirst, _path, judgedRest) => {
            const judged = [judgedFirst, ...judgedRest];
            const into = fields.map((field, index) => {
              const as = judged[index];
              if (!as) throw new StaleSnapshotError(STALE_REFS);
              return {
                ref: field.ref,
                element: { role: as.role, name: as.name },
                value: values[index] ?? "",
              };
            });
            // NOTED BEFORE THE VALUES LEAVE, as with a person's: a fill that fails at its second
            // box has put a name into the page, and the computer is holding it for the run.
            // For the run it is put in for: a routine's own name where it has one (`runKey`).
            putInFor(botId, actor.runKey ?? actor.threadId);
            const filled = await as(botId).fillLogin(into, {
              snapshotId: input.snapshotId,
              origins: login.origins,
            });
            // What every later look is masked against, exactly as after a person typed.
            const known = typedInto.get(computerId) ?? [];
            typedInto.set(
              computerId,
              [
                ...known,
                ...into.map(({ ref, element }) => ({
                  ref,
                  ...element,
                  origin: originOf(cached.url),
                })),
              ].slice(-TYPED_INTO_LIMIT),
            );
            // When it was last used is the vault's to know; losing that is not losing the fill.
            await deps.logins?.used(actor.id, login.id).catch(() => undefined);
            return filled;
          },
        );
        return {
          ...(await as(botId).control()),
          loginFilled: {
            id: login.id,
            ...(login.site ? { site: login.site } : {}),
            fields: fields.length,
          },
        };
      } catch (error) {
        // Refused BY A RULE, and only that. A question, a stop and a failure are their own
        // answers — and so is a person's no: somebody who was asked whether their saved login may
        // be used here, and said it may not, has not asked to be shown a box to type it into.
        const byARule =
          error instanceof ActionRefusedError &&
          (error.code === "laf:policy_denied" ||
            error.code === "laf:no_rule_allows");
        if (!byARule || options.nobodyToAsk) throw error;
      }
    }
    // Nobody to ask, and the vault did not answer — nothing saved for this origin, a card that is
    // not a sign-in, a seal that does not open. Said as that, with nothing opened and no row: no
    // act was made and nobody was asked.
    if (options.nobodyToAsk) {
      return { ...(await as(botId).control()), loginNotSaved: true };
    }
    /*
     * THROUGH THE GATE, LIKE EVERY OTHER ACT OF THE BOT'S (2026-10-10, record §6).
     *
     * This went to the computer on the checks above and nothing else: no rule was asked, the
     * repeat count never saw it, and its one row was a note beside the trail. A Bot could ask a
     * person for a value on a site the deployment had forbidden it to act on, as often as it
     * liked. It is decided as `fill_secret` now — an intent of its own, because the shipped
     * policy refuses a Bot TYPING into a password field (`intent == "type"`) and that field is
     * what this is for — and it leaves the rows every act leaves: allowed, refused, or a question.
     *
     * What is judged is the Bot asking. The value is a person's, typed by them into the masked
     * box; no rule stands between a person and a field they were shown (the same line
     * `person-files.ts` draws for the folder). What the gate gives their typing is the FIELD: it
     * goes into the one judged here, or nowhere (`supplySecret`).
     */
    const state = await govern(
      computerId,
      "computer_request_secret",
      botId,
      actor,
      {
        ref: first.ref,
        // One card, decided once: a rule about any of its boxes is a rule about the card.
        ...(rest.length > 0
          ? { alsoRefs: rest.map((field) => field.ref) }
          : {}),
        ...(signal ? { signal } : {}),
        ...(approvalId ? { approvalId } : {}),
      },
      async (judgedFirst, _path, judgedRest) => {
        /*
         * WHAT WAS JUDGED IS WHAT IS KEPT. The boxes above were read off the snapshot to refuse a
         * card that names no field; what a person's values are later held to is the gate's own
         * reading of each box, handed here, and not a second reading of the same snapshot.
         */
        const judged = [judgedFirst, ...judgedRest];
        for (const [index, field] of fields.entries()) {
          const as = judged[index];
          if (!as) throw new StaleSnapshotError(STALE_REFS);
          field.role = as.role;
          field.name = as.name;
        }
        /*
         * THE CALLER'S STOP GOES WITH THE CALL, AND A REQUEST MADE FOR A CALLER THAT HAS STOPPED
         * IS TAKEN BACK. The signal reached the gate and not the computer, so a slow computer
         * held a stopped turn until the client's own deadline; and where the computer answered
         * after the Stop — or had made the request before the call to it was cut — a masked box
         * stood asking for a value nobody was waiting for (Codex's read of this change). The
         * request is taken back on the computer, nothing of it is kept here, and the caller is
         * told what any stopped act is told.
         *
         * ONLY THIS REQUEST IS TAKEN BACK, AND NOBODY WAITS FOR THAT. The first version let go of
         * the computer's whole state with a person's own door (`release`): a hand another turn
         * was still waiting on went with it, unmarked, and that turn was told the person had done
         * it. And it awaited the letting-go under the client's own deadline, so a stopped turn
         * still hung on a slow computer — the thing this is here to end (both, Codex's second
         * read). The computer is told which ask — its boxes and the snapshot it was made with —
         * and leaves anything else as it is; the telling is given a few seconds of its own and is not
         * waited for. A computer that cannot be reached lets the ask go by its own clock.
         */
        const madeFor = as(botId);
        const takeBack = () =>
          void madeFor
            .withdrawSecret(
              {
                refs: fields.map((field) => field.ref),
                snapshotId: input.snapshotId,
              },
              AbortSignal.timeout(WITHDRAW_MS),
            )
            .catch(() => undefined);
        try {
          const made = await madeFor.requestSecret(
            {
              fields: fields.map(({ ref, label }) => ({ ref, label })),
              snapshotId: input.snapshotId,
            },
            signal,
          );
          if (!signal?.aborted) return made;
        } catch (error) {
          if (signal?.aborted) takeBack();
          throw error;
        }
        takeBack();
        throw new ComputerUnavailableError(STOPPED);
      },
    );
    const into: SecretInto = {
      host,
      // The first box, for a window from before a card held several.
      element: { role: first.role, name: first.name },
      fields,
    };
    secretTargets.set(computerId, into);
    secretRequests.set(computerId, {
      snapshotId: input.snapshotId,
      origin: originOf(cached.url),
      fields: fields.map(({ ref, role, name }) => ({ ref, role, name })),
      ...(actor.threadId ? { threadId: actor.threadId } : {}),
    });
    // ONE ROW FOR ONE CARD — it is also what tells a person a Bot is waiting on them
    // (`notifications/from-audit.ts`), and a card of three boxes is one thing to come back to.
    await writeControlEvent(auditStore, "computer.secret_requested", {
      botId,
      actor,
      computerId,
      // One box reads as it always has; a card's boxes follow one another.
      reason: fields
        .map(
          (field) =>
            `${field.label} (into ${field.role} "${field.name}" on ${host})`,
        )
        .join("; "),
    });
    return { ...state, secretInto: into };
  }

  async function supplySecret(
    computerId: string,
    botId: string,
    actor: ActionActor,
    /** A value for every box of the card, in the card's order. */
    values: readonly string[],
  ) {
    /*
     * INTO THE FIELDS THAT WERE JUDGED, OR NOWHERE.
     *
     * The value used to be sent with nothing beside it, and the computer put it into whatever its
     * own note of the request named. The field the gate judged — its role and its name, on the
     * snapshot it was judged in — travels with the value now, and the computer refuses where the
     * control is called something else by then or the page has moved on (`holdToLabel`, the hold
     * a click has had since 2026-09-07). A page that swaps its password box for a comment box
     * between the question and the answer gets no value. A card of several boxes is held box by
     * box, each to its own.
     *
     * WITH NO JUDGEMENT HELD HERE, NOTHING IS SENT. This server restarted between the question and
     * the answer, or the request was let go: the turn that asked is gone, and a value typed now
     * would land in a page nobody is reading, into a field nothing here vouches for. It is told
     * what the computer says of a value nothing is waiting for.
     *
     * AND A VALUE FOR EVERY BOX, OR NOTHING IS SENT. Which box an absent value belonged to is not
     * something this may guess — a window from before a card held several sends one value for a
     * card of two, and that is a card it cannot answer.
     */
    const request = secretRequests.get(computerId);
    if (!request) throw new StaleSnapshotError(NO_SECRET_PENDING);
    if (
      values.length !== request.fields.length ||
      values.some((value) => !value)
    ) {
      throw new SecretValuesError();
    }
    // NOTED BEFORE THE VALUES LEAVE, not after they land: a supply that fails at its third box
    // has put two values into the page, and the computer is holding those.
    putInFor(botId, request.threadId);
    const result = await as(botId).supplySecret([...values], {
      // Which ask this answers — the computer takes values for that one and no other —
      snapshotId: request.snapshotId,
      // — and what each box was judged as, which is what it must still be.
      fields: request.fields.map(({ ref, role, name }) => ({
        ref,
        element: { role, name },
      })),
    });
    secretTargets.delete(computerId);
    secretRequests.delete(computerId);
    // Bounded: a session that asks for a hundred secrets is not one this should remember.
    const known = typedInto.get(computerId) ?? [];
    const filled = request.fields.map((field) => ({
      ...field,
      origin: request.origin,
    }));
    typedInto.set(computerId, [...known, ...filled].slice(-TYPED_INTO_LIMIT));
    await writeControlEvent(auditStore, "computer.secret_supplied", {
      botId,
      actor,
      computerId,
      // Length, never content — and over the whole card, never box by box. Enough to show
      // something real was entered.
      reason:
        request.fields.length === 1
          ? `${result.characters} characters`
          : `${result.characters} characters in ${request.fields.length} fields`,
    });
    return result;
  }

  return {
    forgetTypedInto,
    withoutSecrets,
    targetOf,
    suppliedOn,
    requestSecret,
    supplySecret,
    holdsValues,
    handedOver,
    frameWithheld,
    valuesSeen,
    valuesLetGo,
    runEnded,
  };
}

export type Secrets = ReturnType<typeof createSecrets>;
