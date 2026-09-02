/**
 * What a `computer_type` argument keeps once the boundary has said the field was a secret.
 *
 * §3.5 suspected and the tests wave measured (6a99045) that the text a Bot types lands in the
 * conversation store verbatim and is handed back to the model on every later turn. For ordinary
 * typing that is correct and is most of what makes a transcript readable — "typed 김기범 into the
 * name box" is the answer to what a Bot did, and a store that forgot it would leave the Bot unable
 * to say what it had already filled in.
 *
 * It is wrong in exactly one place. `computer_request_secret` exists so a credential never passes
 * through the model at all: the Bot names a field, a person types into it themselves, and the value
 * travels a route the model cannot see. A model that ignored that and put the credential in a
 * `computer_type` argument has the action REFUSED at the gateway — and the refusal acts on the
 * action, not on the transcript, so the value stayed in the history and was replayed into the
 * context window on every following turn. The refusal is what did not happen; the text was still
 * there. This module is what makes the refusal reach the record too.
 *
 * Redaction is decided from the TOOL RESULT rather than from the text, because the boundary is the
 * thing that knows a field was a password box and a pattern is not. The pattern is the fallback for
 * the one case where no result exists — a run that died between the call and its answer.
 *
 * Pure on purpose: `appendMessages` is a transaction holding an advisory lock, and the rule that
 * decides whether a credential survives should be testable without a database.
 */
import { looksLikeASecret } from "../agents/memory-store";
import type { StoredMessage } from "./thread-store";

/**
 * What replaces the text. Read by the model, never by a person.
 *
 * The transcript line for `computer_type` has never shown the typed value — it identifies the field
 * and nothing else (`computer-tools.tsx`) — so this string does not need a Korean twin. It is there
 * so a model reading its own history sees that it typed something and that the something is gone,
 * rather than seeing an empty string and concluding the field is still blank.
 */
export const SECRET_REDACTION = "[redacted: secret field]";

/** The one tool whose arguments carry a typed value. */
const TYPING_TOOL = "computer_type";

/**
 * Refusal codes that mean "the field was a secret".
 *
 * Today that is one code. `laf:policy_denied` was looked for and does not exist in this deployment:
 * `FactCode` in `computer/policy.ts` holds `laf:use_request_secret` and `laf:declined_recently` and
 * nothing else, so a branch for it would be a branch nothing can reach. The password-field SHAPE it
 * was described with is handled below regardless, and without naming a code — which is what makes
 * this survive the gateway's refusal shape being rewritten.
 */
const SECRET_FIELD_CODES = new Set(["laf:use_request_secret"]);

/**
 * The rule that refused, when the rule itself names a password box.
 *
 * `SECRET_FIELD_RULE` in `computer/default-policy.ts` is the shipped one and reads
 * `intent == "type" && (element.type == "password" || matches(element.name, "…"))`. It arrives on
 * the wire as `rule` on both refusal shapes, and it is the only signal present today: neither the
 * app's fetch wrapper nor the unattended loop copies the server's `code` field onto the tool result
 * (see the module note below), so a reader that keyed on the code alone would redact nothing.
 */
const PASSWORD_FIELD_RULE = /element\.type\s*===?\s*["']password["']/;

/** One tool call as AG-UI carries it. Narrowed here because `Message` types `toolCalls` loosely. */
type StoredToolCall = {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
};

/** A JSON object, or undefined for anything that is not one. */
function asObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A nested `element.type`, wherever a refusal chose to hang its subject. */
function elementTypeIn(body: Record<string, unknown>): string | undefined {
  const roots = [body, (body.subject ?? {}) as Record<string, unknown>];
  for (const root of roots) {
    const element = root.element;
    if (element && typeof element === "object" && !Array.isArray(element)) {
      const type = (element as Record<string, unknown>).type;
      if (typeof type === "string") return type;
    }
  }
  return undefined;
}

/**
 * Whether a tool result says the typing was refused because the field held a secret.
 *
 * TWO WIRE SHAPES, BOTH JSON STRINGS IN `content`, AND ONE FALLBACK.
 *
 * 1. The attended path (`app/src/lib/copilot/computer-tools.tsx`) turns a 403 into
 *    `{ok:false, refused:true, rule, reason}`. It reads `code` off `body.error` rather than off
 *    `body.code`, so a policy refusal reaches the model with the RULE and no code.
 * 2. The unattended path (`runner/unattended.ts`, `outcomeOfError`) builds
 *    `{ok:false, refused:true, reason, rule}` from `ActionRefusedError`, which carries a `code`
 *    field it does not copy. Same result: rule, no code.
 *
 * So the code is accepted where it is present — it is the fact the gateway actually decides, and
 * the shape another wave is rewriting towards — and the password-field rule is what fires today.
 * Anything that is not JSON at all (an `Error: …` line, or a bare code) is matched as text, because
 * a refusal that failed to serialise is still a refusal.
 */
export function isSecretFieldRefusal(content: string): boolean {
  const text = content.trim();
  if (!text) return false;

  const body = asObject(text);
  if (!body) {
    return (
      [...SECRET_FIELD_CODES].some((code) => text.includes(code)) ||
      PASSWORD_FIELD_RULE.test(text)
    );
  }

  for (const field of ["code", "error", "reason"] as const) {
    const held = body[field];
    if (typeof held === "string" && SECRET_FIELD_CODES.has(held.trim())) {
      return true;
    }
  }

  /*
   * The password-field shape only counts on a REFUSAL. A successful `computer_type` answers with the
   * element it typed into, and that element carries `type` too — so reading the shape without this
   * guard would redact exactly the case where a deployment had decided, in writing, that this Bot
   * may fill that box.
   */
  const refused = body.refused === true || body.ok === false;
  if (!refused) return false;

  if (typeof body.rule === "string" && PASSWORD_FIELD_RULE.test(body.rule)) {
    return true;
  }
  return elementTypeIn(body) === "password";
}

/** The tool calls on a message, or an empty list for a message that made none. */
function toolCallsOf(message: StoredMessage): StoredToolCall[] {
  const calls = (message as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls.filter(
    (call): call is StoredToolCall =>
      !!call &&
      typeof call === "object" &&
      typeof (call as StoredToolCall).id === "string" &&
      typeof (call as StoredToolCall).function?.name === "string" &&
      typeof (call as StoredToolCall).function?.arguments === "string",
  );
}

/** The `text` argument of a call, when it has one that parses. */
function typedText(call: StoredToolCall): string | undefined {
  const args = asObject(call.function.arguments);
  const text = args?.text;
  return typeof text === "string" ? text : undefined;
}

/**
 * The same call with its typed value replaced, or null when there was nothing to replace.
 *
 * Unparseable arguments are replaced WHOLE rather than left alone. Leaving them would keep the
 * value for precisely the calls whose shape nobody can read, which is the wrong way round for a
 * rule about credentials; the call, its name and its id all survive, and only the arguments — which
 * were already unreadable — are lost.
 */
function withoutTheValue(call: StoredToolCall): StoredToolCall | null {
  const args = asObject(call.function.arguments);
  if (!args) {
    return {
      ...call,
      function: {
        ...call.function,
        arguments: JSON.stringify({ text: SECRET_REDACTION }),
      },
    };
  }
  if (typeof args.text !== "string" || args.text === SECRET_REDACTION) {
    return null;
  }
  return {
    ...call,
    function: {
      ...call.function,
      arguments: JSON.stringify({ ...args, text: SECRET_REDACTION }),
    },
  };
}

/**
 * Redact the typed value out of every `computer_type` call this batch should not keep.
 *
 * `held` is what the thread already holds. It is read for two things and written to for none:
 * results that arrived on an earlier append, and — the part that matters most — which calls were
 * ALREADY redacted. Every run hands the whole history back as its input, so the unredacted copy of
 * a message comes round again on the very next turn, and a rule that only looked at this batch
 * would put the credential straight back. The stored decision wins.
 *
 * Three reasons a call loses its text, in the order they are checked:
 *
 * 1. It was redacted before. Nothing un-redacts.
 * 2. Its result says the boundary refused it because the field was a secret.
 * 3. It has NO result anywhere — the run ended between the call and its answer — and the text
 *    itself looks like a secret. `looksLikeASecret` is the memory store's filter, imported rather
 *    than copied so there is one answer to "does this look like a credential" in this deployment.
 *    Ordinary text with no result stays: a crash is not evidence of anything.
 */
export function redactSecretTyping(
  incoming: readonly StoredMessage[],
  held: readonly StoredMessage[] = [],
): StoredMessage[] {
  const results = new Map<string, string>();
  const redactedBefore = new Set<string>();
  for (const message of [...held, ...incoming]) {
    const answersFor = (message as { toolCallId?: unknown }).toolCallId;
    if (typeof answersFor === "string" && typeof message.content === "string") {
      results.set(answersFor, message.content);
    }
  }
  for (const message of held) {
    for (const call of toolCallsOf(message)) {
      if (
        call.function.name === TYPING_TOOL &&
        typedText(call) === SECRET_REDACTION
      ) {
        redactedBefore.add(call.id);
      }
    }
  }

  return incoming.map((message) => {
    // Narrowed rather than merely filtered by `toolCallsOf`: `StoredMessage` is a union of thirteen
    // roles and only this one has a `toolCalls` field to put back.
    if (message.role !== "assistant") return message;
    const calls = toolCallsOf(message);
    if (calls.length === 0) return message;

    let changed = false;
    let redacted = false;
    const rewritten = calls.map((call) => {
      if (call.function.name !== TYPING_TOOL) return call;
      const result = results.get(call.id);
      const shouldRedact = redactedBefore.has(call.id)
        ? true
        : result === undefined
          ? looksLikeASecret(typedText(call) ?? "")
          : isSecretFieldRefusal(result);
      if (!shouldRedact) return call;

      redacted = true;
      const cleaned = withoutTheValue(call);
      if (!cleaned) return call;
      changed = true;
      return cleaned;
    });

    if (!redacted) return message;
    // `lafRedacted` is stamped even when nothing needed rewriting, because a copy that arrived
    // already redacted is still a redacted message and a reader asking "was anything taken out of
    // this turn" should get the same answer either way.
    const marked = message.lafRedacted === true;
    if (!changed && marked) return message;
    return {
      ...message,
      toolCalls: rewritten as typeof message.toolCalls,
      lafRedacted: true,
    };
  });
}
