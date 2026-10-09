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
import type { AuditStore } from "../../audit";
import {
  type ComputerClient,
  ComputerUnavailableError,
  NO_SECRET_PENDING,
  STALE_REFS,
  STOPPED,
  StaleSnapshotError,
} from "../client";
import { isSecretFieldElement } from "../default-policy";
import type { PolicyDecision } from "../policy";
import type { SecretRequest, SnapshotElement, SnapshotResult } from "../schema";
import { hostOf, originOf } from "./addresses";
import { type ActionActor, ActionRefusedError } from "./caller";
import type { Govern } from "./govern";
import type { SnapshotCache } from "./snapshots";
import { write, writeControlEvent } from "./trail";

/** A field a person typed a secret into, as this server can know it: its ref, on an origin. */
type TypedInto = { ref: string; origin: string; role: string; name: string };

/** How long the computer is given to hear that a stopped caller's ask is taken back. */
const WITHDRAW_MS = 5_000;

/** A field a value is waiting for: where it was judged, and as what. See `supplySecret`. */
type Requested = TypedInto & { snapshotId: number };

/** How many such fields one computer's snapshots are masked against. */
const TYPED_INTO_LIMIT = 8;

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
}) {
  const { as, auditStore, snapshots, govern } = deps;
  /**
   * Where each open secret request points, as this server resolved it when the request was made.
   *
   * Held here rather than read back off the computer, because the computer keeps the Bot's label
   * and the ref and nothing else — and the host and the control's own name are what a person needs
   * beside a label a model wrote. Cleared when the value is supplied.
   */
  const secretTargets = new Map<
    string,
    { host: string; element: { role: string; name: string } }
  >();
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
  ) {
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
    const element = cached.elements.get(input.ref);
    if (!element || !SECRET_ENTRY_ROLES.has(element.role)) {
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
        ref: input.ref,
        filePath: undefined,
        pageUrl: cached.url,
        decision: refusal,
      });
      throw new ActionRefusedError(null, "laf:secret_target_not_a_field");
    }
    const into = {
      host: hostOf(cached.url),
      element: { role: element.role, name: element.name },
    };
    // One line, bounded: it is rendered on the masked box and written into the trail.
    const label = input.label.replace(/\s+/g, " ").trim().slice(0, 120);
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
        ref: input.ref,
        ...(signal ? { signal } : {}),
        ...(approvalId ? { approvalId } : {}),
      },
      async () => {
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
         * read). The computer is told which ask — the ref and the snapshot it was made with — and
         * leaves anything else as it is; the telling is given a few seconds of its own and is not
         * waited for. A computer that cannot be reached lets the ask go by its own clock.
         */
        const madeFor = as(botId);
        const takeBack = () =>
          void madeFor
            .withdrawSecret(
              { ref: input.ref, snapshotId: input.snapshotId },
              AbortSignal.timeout(WITHDRAW_MS),
            )
            .catch(() => undefined);
        try {
          const made = await madeFor.requestSecret({ ...input, label }, signal);
          if (!signal?.aborted) return made;
        } catch (error) {
          if (signal?.aborted) takeBack();
          throw error;
        }
        takeBack();
        throw new ComputerUnavailableError(STOPPED);
      },
    );
    secretTargets.set(computerId, into);
    secretRequests.set(computerId, {
      ref: input.ref,
      snapshotId: input.snapshotId,
      origin: originOf(cached.url),
      role: element.role,
      name: element.name,
    });
    await writeControlEvent(auditStore, "computer.secret_requested", {
      botId,
      actor,
      computerId,
      reason: `${label} (into ${element.role} "${element.name}" on ${into.host})`,
    });
    return { ...state, secretInto: into };
  }

  async function supplySecret(
    computerId: string,
    botId: string,
    actor: ActionActor,
    text: string,
  ) {
    /*
     * INTO THE FIELD THAT WAS JUDGED, OR NOWHERE.
     *
     * The value used to be sent with nothing beside it, and the computer put it into whatever its
     * own note of the request named. The field the gate judged — its role and its name, on the
     * snapshot it was judged in — travels with the value now, and the computer refuses where the
     * control is called something else by then or the page has moved on (`holdToLabel`, the hold
     * a click has had since 2026-09-07). A page that swaps its password box for a comment box
     * between the question and the answer gets no value.
     *
     * WITH NO JUDGEMENT HELD HERE, NOTHING IS SENT. This server restarted between the question and
     * the answer, or the request was let go: the turn that asked is gone, and a value typed now
     * would land in a page nobody is reading, into a field nothing here vouches for. It is told
     * what the computer says of a value nothing is waiting for.
     */
    const request = secretRequests.get(computerId);
    if (!request) throw new StaleSnapshotError(NO_SECRET_PENDING);
    const result = await as(botId).supplySecret(text, {
      // Which ask this answers — the computer takes a value for that one and no other —
      ref: request.ref,
      snapshotId: request.snapshotId,
      // — and what the field was judged as, which is what it must still be.
      element: { role: request.role, name: request.name },
    });
    secretTargets.delete(computerId);
    secretRequests.delete(computerId);
    // Bounded: a session that asks for a hundred secrets is not one this should remember.
    const known = typedInto.get(computerId) ?? [];
    const { snapshotId: _judgedIn, ...field } = request;
    typedInto.set(computerId, [...known, field].slice(-TYPED_INTO_LIMIT));
    await writeControlEvent(auditStore, "computer.secret_supplied", {
      botId,
      actor,
      computerId,
      // Length, never content. Enough to show something real was entered.
      reason: `${result.characters} characters`,
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
  };
}

export type Secrets = ReturnType<typeof createSecrets>;
