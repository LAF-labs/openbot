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
import type {
  SecretInto,
  SecretRequest,
  SnapshotElement,
  SnapshotResult,
} from "../schema";
import { hostOf, originOf } from "./addresses";
import { type ActionActor, ActionRefusedError } from "./caller";
import type { Govern } from "./govern";
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
};

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
  };
}

export type Secrets = ReturnType<typeof createSecrets>;
