/**
 * What a call IS, in the terms a rule is written in and a person is asked in.
 *
 * Derived from the call, never supplied with it. A rule about activation, a floor under typing and
 * the facts on an approval card all read these, so a new acting route cannot arrive without an
 * intent, and a subject cannot say something about a page that the server did not resolve itself.
 */
import type { AskSubject } from "../approvals";
import type { PolicyContext } from "../policy";
import type { SnapshotElement } from "../schema";
import { hostOf, pathOf } from "./addresses";

/**
 * Whether a `computer_key` call is really typing.
 *
 * `hunter2`, sent as six keypresses with no ref, used to arrive as six actions on nothing in
 * particular: no element resolved, so the password-field `deny` matched an empty label and the
 * value went into the focused box one character at a time. A key name is a word — Enter, Tab,
 * ArrowDown, F5 — and a single printable character is a letter. Shift still types (`Shift+a` is
 * `A`); Control, Alt and Meta make a shortcut, which is the thing this tool is for.
 */
export function isTextKey(key: string): boolean {
  const parts = key.split("+");
  const last = parts.pop() ?? "";
  const modifiers = parts.map((part) => part.trim().toLowerCase());
  if (
    modifiers.some(
      (modifier) =>
        modifier === "control" ||
        modifier === "alt" ||
        modifier === "meta" ||
        modifier === "controlormeta",
    )
  ) {
    return false;
  }
  const points = Array.from(last);
  return points.length === 1 && last !== " " && !/\p{C}/u.test(last);
}

/**
 * What an action does, from what the gateway already knows.
 *
 * Derived here rather than passed in by each call site, so a new acting route cannot arrive
 * without an intent and fall outside every rule written in terms of one.
 *
 * Enter and Space are activations. They press whatever has focus, so a rule about activation must
 * cover keypresses as well as clicks.
 */
const ACTIVATING_KEYS = new Set(["Enter", "NumpadEnter", "Space", " "]);

/**
 * The intents this gateway can produce, which is every one that is not about somebody else's server.
 *
 * Named so that both readers of an intent take the same value: the policy context, whose union also
 * covers MCP calls, and the subject a person is shown, whose union also covers a tool call and the
 * unrecognised case. A plain `PolicyContext["intent"]` here would let `read_tool` into a browser
 * subject, which is a sentence about a page that no page was involved in.
 */
export type BrowserIntent = Extract<
  PolicyContext["intent"],
  AskSubject["intent"] | undefined
>;

export function intentOf(
  toolName: string,
  key: string | undefined,
): BrowserIntent {
  switch (toolName) {
    case "computer_click":
      return "activate";
    case "computer_key":
      return key && ACTIVATING_KEYS.has(key) ? "activate" : "type";
    case "computer_type":
      return "type";
    case "computer_navigate":
      return "navigate";
    case "computer_read":
    case "computer_snapshot":
    case "computer_screenshot":
    case "computer_scroll":
    // Looking at a tab the browser already has open changes nothing on any website. What it changes
    // is which page the NEXT action lands on, and that action is judged on its own.
    case "computer_switch_tab":
      return "read";
    case "computer_upload_file":
      return "upload";
    case "computer_read_file":
      return "read_file";
    case "computer_write_file":
      return "write_file";
    case "computer_list_files":
      return "list_files";
    default:
      return undefined;
  }
}

/** Whether the rule that asked was one about a Bot going round in circles. See `REPEAT_RULE`. */
function isAboutRepetition(expression: string | null): boolean {
  return expression !== null && /\brepeat\s*\./.test(expression);
}

/**
 * What is about to happen, as the facts a person is shown.
 *
 * Assembled here, once, from what the SERVER resolved: the element off its own snapshot, the host
 * off the URL it is about to open. The sentence used to be assembled in `policy.ts`, in English,
 * and rendered as-is on three Korean screens — see {@link AskSubject}.
 */
export function askSubjectOf(input: {
  intent: BrowserIntent;
  pageUrl: string;
  filePath: string | undefined;
  element: SnapshotElement | undefined;
  /** The expression that asked, to tell a question about repetition from any other. */
  matched: string | null;
  repeatCount: number;
}): AskSubject {
  const reason = isAboutRepetition(input.matched) ? "repeat" : "policy_ask";
  const repeated =
    reason === "repeat" ? { repeatCount: input.repeatCount } : {};
  // A file call has nothing to do with whatever the browser is showing, so its subject names no
  // host: saying one would send somebody to a page that has nothing to do with it.
  if (input.filePath) {
    return {
      kind: "file",
      intent: input.intent ?? "act",
      file: { path: input.filePath },
      ...repeated,
      reason,
    };
  }
  const host = hostOf(input.pageUrl);
  const path = pathOf(input.pageUrl);
  return {
    kind: "browser",
    intent: input.intent ?? "act",
    ...(host ? { host } : {}),
    ...(path ? { path } : {}),
    ...(input.element
      ? { element: { role: input.element.role, name: input.element.name } }
      : {}),
    ...repeated,
    reason,
  };
}
