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
import { type ComputerClient, StaleSnapshotError } from "../client";
import { isSecretFieldElement } from "../default-policy";
import type { PolicyDecision } from "../policy";
import type { SecretRequest, SnapshotElement, SnapshotResult } from "../schema";
import { hostOf, originOf } from "./addresses";
import { type ActionActor, ActionRefusedError } from "./caller";
import type { SnapshotCache } from "./snapshots";
import { write, writeControlEvent } from "./trail";

/** A field a person typed a secret into, as this server can know it: its ref, on an origin. */
type TypedInto = { ref: string; origin: string; role: string; name: string };

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
}) {
  const { as, auditStore, snapshots } = deps;
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
  const secretRequests = new Map<string, TypedInto>();
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
      throw new StaleSnapshotError(
        "The snapshot this ref came from is no longer current. Take a fresh snapshot and use the refs from it.",
      );
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
    const state = await as(botId).requestSecret({ ...input, label });
    secretTargets.set(computerId, into);
    secretRequests.set(computerId, {
      ref: input.ref,
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
    const result = await as(botId).supplySecret(text);
    secretTargets.delete(computerId);
    const request = secretRequests.get(computerId);
    secretRequests.delete(computerId);
    if (request) {
      // Bounded: a session that asks for a hundred secrets is not one this should remember.
      const known = typedInto.get(computerId) ?? [];
      typedInto.set(computerId, [...known, request].slice(-TYPED_INTO_LIMIT));
    }
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
    requestSecret,
    supplySecret,
  };
}

export type Secrets = ReturnType<typeof createSecrets>;
