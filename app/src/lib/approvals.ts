/**
 * The questions a boundary raised, from the browser's side: reading them, answering them, and
 * knowing which tool call each one belongs to.
 *
 * One module for all of it because the two halves have to agree. A tool call that met an `ask` rule
 * holds itself open waiting for an answer, and the card a person answers on is drawn on that same
 * tool call's line in the transcript. Those are different components on different render passes, so
 * the id travels through here.
 *
 * A question is held against the tool call that raised it rather than against the Bot. The Bot's
 * list is the wrong key: nothing withdraws a question when the wait around it ends, so pressing
 * Stop, reloading the tab or a turn that errors all leave an unanswered entry sitting in the
 * server's registry until it expires. A card that showed "the oldest thing this Bot is waiting on"
 * would then put a stale question in front of somebody on an unrelated line, record their Allow
 * against an action nobody is waiting for, and leave the action they were actually looking at
 * waiting out the full ten minutes.
 *
 * IT IS ALSO WHERE THE QUESTION BECOMES A SENTENCE. The server sends what the action is; the words
 * are chosen here, once, for every card that asks. See `describeSubject`.
 */
import { readableLabel, readableName } from "@shared/element-label";
import { moneyWordIn, shippedAskRuleOf } from "@shared/policy-rules";
import { type CallPreview, callPreviewOf } from "@/lib/call-preview";
import { t } from "@/lib/i18n";
import { serviceLabel, toolLabel } from "@/lib/plugins/tool-labels";
import { refusalText } from "@/lib/refusals";

/**
 * How long the surface holds a tool call open for an answer, and how often it looks.
 *
 * Ten minutes matches the server's own window, so the wait ends because the question expired rather
 * than because the two sides disagreed about when it had.
 */
const WAIT_FOR_ANSWER_MS = 10 * 60_000;
const WAIT_POLL_MS = 1_000;

/**
 * How wide "always allow" would be, decided by the server from the action itself.
 *
 * `host` covers every action on one site, `file` one path, `tool` one tool by name. It is here so
 * the button can say which — a person cannot consent to a widening they were not shown — and it is
 * never sent back when the button is pressed: the server reads the scope off its own record, so
 * nothing a page could do makes the grant wider than the sentence somebody read.
 */
export type AllowanceScope = {
  kind: "host" | "file" | "tool";
  value: string;
};

/**
 * How long a yes is meant to last, as the three buttons on a card say it.
 *
 * `once` is this action. `thread` is this conversation — bound to the thread the question came
 * from, and to a day. `always` is until somebody takes it back. The middle one exists because the
 * other two are a day apart in weight, and somebody clearing an obstacle for one afternoon had
 * nothing honest to press.
 */
export type ApprovalTier = "once" | "thread" | "always";

/**
 * The scope out of a pause reply, or undefined if it was not one.
 *
 * One parser for both callers — the computer's tools and the plugin call — because a scope that
 * half-validates in one of them is a button offering a widening the server will not perform. Not
 * knowing means offering "this once" alone, which is the safe direction and the behaviour this card
 * had before the wider button existed.
 */
export function allowanceScopeOf(value: unknown): AllowanceScope | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { kind, value: scoped } = value as Record<string, unknown>;
  if (kind !== "host" && kind !== "file" && kind !== "tool") return undefined;
  if (typeof scoped !== "string" || !scoped) return undefined;
  return { kind, value: scoped };
}

/**
 * WHAT THE BOT IS ABOUT TO DO, AS FACTS. The sentence is written here and nowhere else.
 *
 * The server used to send a finished English sentence in a field called `question`, assembled by
 * `describeAsk` in `server/src/computer/policy.ts`, and three screens rendered it as it arrived —
 * while the MCP guard's questions in that same field were Korean. One field, two languages, and a
 * Korean reader shown "The Bot wants to press “결제하기”" whatever the dictionary said
 * (docs/laf/redesign-2026-09.md §3.1, §5.1(b)).
 *
 * Mirrors `AskSubject` on the server. Every field is what the SERVER resolved — the element off its
 * own snapshot of the page, the host off the address it is about to open — never anything the model
 * said it was doing, which is the property that makes the question worth answering at all.
 */
export type AskSubject = {
  kind: "browser" | "file" | "tool";
  intent:
    | "navigate"
    | "activate"
    | "type"
    | "read"
    | "read_file"
    | "write_file"
    | "list_files"
    | "upload"
    | "call_tool"
    | "act";
  host?: string;
  path?: string;
  element?: { role: string; name: string };
  file?: { path: string };
  tool?: {
    server: string;
    name: string;
    guard?: "money" | "external" | "destructive" | "unannotated";
  };
  repeatCount?: number;
  reason: "policy_ask" | "guard_floor" | "repeat" | "unannotated";
};

export type PendingApproval = {
  id: string;
  botId: string;
  /** The expression that asked, shown as a rule so a person can see which boundary they are at. */
  rule: string;
  /** What is about to happen, in facts. `describeSubject` turns it into a sentence. */
  subject: AskSubject;
  /**
   * What an outward call will send. Typed as the server sends it, and read through
   * `callPreviewOf` before it is drawn: this arrives as JSON like everything else here.
   */
  preview?: unknown;
  /** Absent when nothing durable could be derived; the card then offers "this once" alone. */
  scope?: AllowanceScope;
  /** Present when "for this conversation" is on offer. See `OpenQuestion.threadId`. */
  threadId?: string;
  /**
   * The conversation step the question holds open: which thread, which of the Bot's tool calls.
   * What lets every window of that conversation draw the card, and carry the step on once it is
   * answered if the window that raised it has gone (`lib/copilot/stranded-steps.ts`).
   */
  step?: { threadId: string; toolCallId: string };
  /** Some window is holding the step and will carry it on. */
  held?: true;
  requestedAt: string;
  expiresAt: string;
  /** Absent while nobody has answered. False is an answer. */
  granted?: boolean;
  /** How wide a yes was, when wider than this once. Set by the server with `granted`. */
  tier?: Exclude<ApprovalTier, "once">;
  answeredBy?: string;
};

/**
 * The subject out of a pause reply, or undefined if there was not one.
 *
 * Checked rather than cast. It arrives as JSON over HTTP and a card that trusted the shape would
 * render "undefined" into the sentence somebody is being asked to consent to; not knowing what the
 * question is about is a thing to say plainly rather than to paper over.
 */
export function askSubjectOf(value: unknown): AskSubject | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { kind, intent, reason } = value as Record<string, unknown>;
  if (kind !== "browser" && kind !== "file" && kind !== "tool")
    return undefined;
  if (
    !INTENTS.has(intent as AskSubject["intent"]) ||
    !REASONS.has(reason as AskSubject["reason"])
  ) {
    return undefined;
  }
  return value as AskSubject;
}

const INTENTS = new Set<AskSubject["intent"]>([
  "navigate",
  "activate",
  "type",
  "read",
  "read_file",
  "write_file",
  "list_files",
  "upload",
  "call_tool",
  "act",
]);

const REASONS = new Set<AskSubject["reason"]>([
  "policy_ask",
  "guard_floor",
  "repeat",
  "unannotated",
]);

/**
 * The 을/를 that follows a label, decided by the label's last letter.
 *
 * Korean picks the object particle by whether the preceding syllable ends in a consonant, and an
 * element's label is a variable, so the sentence cannot carry it. It is passed in as a parameter
 * instead and the dictionary entry places it: "‘출금 승인’{particle} 누르려 합니다".
 *
 * Anything not ending in Hangul — "Submit", a number, an icon's label — gets the form Korean writing
 * uses when the reading is not known. It is slightly stiff and it is never wrong, which is the right
 * way round for a sentence somebody is being asked to consent to.
 */
function objectParticle(word: string): string {
  const last = [...word].at(-1) ?? "";
  const code = last.codePointAt(0) ?? 0;
  if (code < 0xac00 || code > 0xd7a3) return "을(를)";
  return (code - 0xac00) % 28 === 0 ? "를" : "을";
}

/** One sentence to say, as a dictionary key and the values that go into it. */
export type Phrase = { key: string; params: Record<string, string | number> };

/**
 * THE WORDS FOR ONE QUESTION, chosen from the facts and never sent by a server.
 *
 * Exported as keys rather than as finished text so a test can walk every intent and reason the
 * server can emit and check the dictionary has each one — `t()` on a variable is invisible to
 * `i18n-coverage.test.ts`, which is why `approval-subject.test.ts` exists (the arrangement
 * `agent-presets.test.ts` set up for the presets).
 */
export function subjectPhrases(subject: AskSubject): {
  action: Phrase;
  /** Why it stopped, where that is not already obvious from the rule. */
  reason?: Phrase;
} {
  return {
    action: actionPhrase(subject),
    ...(reasonPhrase(subject) ? { reason: reasonPhrase(subject) } : {}),
  };
}

function actionPhrase(subject: AskSubject): Phrase {
  const host = subject.host ?? "";
  // As a person reads it, and short enough to quote (`shared/element-label.ts`): the money card
  // once asked about "‘앱 다 운 로 드 앱 다 운 로 드’".
  const name = readableLabel(subject.element?.name ?? "");
  const named = { name, host, particle: objectParticle(name) };
  switch (subject.intent) {
    case "activate":
      if (name && host) {
        return { key: "It wants to press “{name}” on {host}.", params: named };
      }
      if (name) return { key: "It wants to press “{name}”.", params: named };
      return host
        ? { key: "It wants to press something on {host}.", params: { host } }
        : {
            key: "It wants to press something on the page it has open.",
            params: {},
          };
    case "type":
      if (name && host) {
        return {
          key: "It wants to type into “{name}” on {host}.",
          params: named,
        };
      }
      if (name)
        return { key: "It wants to type into “{name}”.", params: named };
      return host
        ? { key: "It wants to type into a field on {host}.", params: { host } }
        : {
            key: "It wants to type into a field on the page it has open.",
            params: {},
          };
    case "navigate":
      if (host && subject.path) {
        return {
          key: "It wants to open {host}{path}.",
          params: { host, path: subject.path },
        };
      }
      return host
        ? { key: "It wants to open {host}.", params: { host } }
        : { key: "It wants to open a page.", params: {} };
    case "read":
      return host
        ? { key: "It wants to look at {host}.", params: { host } }
        : { key: "It wants to look at the page it has open.", params: {} };
    case "read_file":
      return {
        key: "It wants to read the file {path}.",
        params: { path: subject.file?.path ?? "" },
      };
    case "write_file":
      return {
        key: "It wants to write to the file {path}.",
        params: { path: subject.file?.path ?? "" },
      };
    case "list_files": {
      // The workspace root arrives as ".", which is a path nobody would recognise as their folder.
      const path = subject.file?.path ?? "";
      return path && path !== "."
        ? { key: "It wants to list what is in {path}.", params: { path } }
        : { key: "It wants to list what is in the workspace.", params: {} };
    }
    case "upload": {
      // A workspace file handed to a site: the file is what a person recognises, the host is where
      // it goes.
      const path = subject.file?.path ?? "";
      return host
        ? {
            key: "It wants to upload the file {path} to {host}.",
            params: { path, host },
          }
        : { key: "It wants to upload the file {path}.", params: { path } };
    }
    case "call_tool": {
      // By the names a person knows them by, where this surface has one: "지메일의 ‘메일 보내기’",
      // not "gmail의 ‘send_message’" (audit R4-14). An unnamed tool keeps its own name.
      const server = subject.tool?.server ?? "";
      const tool = subject.tool?.name ?? "";
      return {
        key: "It wants to use the “{tool}” tool on {server}.",
        params: {
          tool: toolLabel(`${server}/${tool}`) ?? tool,
          server: serviceLabel(server) ?? server,
        },
      };
    }
    default:
      return host
        ? { key: "It wants to do something on {host}.", params: { host } }
        : {
            key: "It wants to do something on the page it has open.",
            params: {},
          };
  }
}

function reasonPhrase(subject: AskSubject): Phrase | undefined {
  if (subject.reason === "repeat") {
    return {
      key: "It has just done the same thing {count} times.",
      params: { count: subject.repeatCount ?? 0 },
    };
  }
  if (subject.reason === "unannotated") {
    return {
      key: "The tool declared no risk at all, so it is treated as the most dangerous thing it could be.",
      params: {},
    };
  }
  if (subject.reason !== "guard_floor") return undefined;
  switch (subject.tool?.guard) {
    case "money":
      return {
        key: "The tool is declared as one that moves money.",
        params: {},
      };
    case "external":
      return {
        key: "The tool is declared as one that sends something outward.",
        params: {},
      };
    case "destructive":
      return {
        key: "The tool is declared as one that can destroy something.",
        params: {},
      };
    default:
      return undefined;
  }
}

/**
 * How long is left to answer, in words, or null once there is nothing left to say.
 *
 * A question expires after ten minutes and the card simply vanished when it did — no clock, no
 * sentence, nothing to explain why the buttons a person was about to press were gone
 * (docs/laf/redesign-2026-09.md §5.6(g)-7). Seconds only under a minute, because "1분 남음" sitting
 * there while the last thirty seconds run out is the part that reads as broken.
 *
 * Null for an approval that carries no expiry — an older reply, or a room frame from a server that
 * has not been restarted — rather than a guess at one.
 */
export function timeLeftToAnswer(
  expiresAt: string,
  now: number = Date.now(),
): string | null {
  const at = Date.parse(expiresAt);
  if (!expiresAt || Number.isNaN(at)) return null;
  const left = Math.max(0, at - now);
  if (left === 0) return t("Time is up");
  const seconds = Math.ceil(left / 1000);
  if (seconds < 60) return t("{seconds}s left", { seconds });
  return t("{minutes}m left", { minutes: Math.ceil(seconds / 60) });
}

/**
 * The question, in one sentence, in the language the person reads.
 *
 * One function for every surface that asks — the line-level card, the room's card and the admin
 * list — because the same press has to mean the same thing on all three, and two copies of this
 * would be two descriptions of one grant.
 */
export function describeSubject(subject: AskSubject): string {
  const said = subjectPhrases(subject);
  const action = t(said.action.key, said.action.params);
  if (!said.reason) return action;
  return `${action} ${t(said.reason.key, said.reason.params)}`;
}

/**
 * WHY IT STOPPED TO ASK, in a person's words rather than in the rule's.
 *
 * The card used to print the expression that matched — `intent == "activate" && matches(page.host,
 * "(^|[.])(kbstar[.]com|…)$")` — in monospace, beside a sentence that began "이 규칙 때문에". Nobody
 * deciding whether a click on toss.im is fine reads CEL, so the one question the card most needed to
 * answer — why is it asking me this — was answered in a language only an administrator reads (UI/UX
 * audit 0.5.3, item 3). The expression is recognised against the shipped rules in
 * `shared/policy-rules.ts`, by equality, and said as what that rule is for.
 *
 * Undefined where the question already says why — a repeat, or a tool that declared itself risky —
 * so the card does not give two reasons for one stop. An expression this build did not write is an
 * administrator's own rule, and is said to be exactly that rather than guessed at.
 */
export function whyAskedPhrase(
  rule: string | null | undefined,
  subject: AskSubject | undefined,
): Phrase | undefined {
  if (subject && subject.reason !== "policy_ask") return undefined;
  switch (shippedAskRuleOf(rule)) {
    case "money_word":
      return moneyWordPhrase(subject?.element?.name);
    case "money_host":
      return subject?.host
        ? {
            key: "Asked because {host} is a site where money moves.",
            params: { host: subject.host },
          }
        : {
            key: "Asked because this is a site where money moves.",
            params: {},
          };
    case "upload":
      return {
        key: "Asked because it would hand one of the Bot's files to a website.",
        params: {},
      };
    default:
      return { key: "Asked because a rule set here says to.", params: {} };
  }
}

/**
 * The money-word rule's reason, naming the word the card can find in the label — or the general
 * reason when it finds none, since naming a word that is not on the button would be the card
 * explaining a match it did not see.
 */
function moneyWordPhrase(label: string | undefined): Phrase {
  // Found in the readable name: a letter-spaced "결 제 하 기" holds no "결제" to find.
  const found = moneyWordIn(
    label === undefined ? undefined : readableName(label),
  );
  const params = { word: found?.word ?? "" };
  switch (found?.kind) {
    case "money":
      return {
        key: "Asked because it is a “{word}” button, and money may leave.",
        params,
      };
    case "irreversible":
      return {
        key: "Asked because it is a “{word}” button, and that may not be undone.",
        params,
      };
    case "outward":
      return {
        key: "Asked because it is a “{word}” button, and something may be sent out.",
        params,
      };
    case "confirm":
      return {
        key: "Asked because it is a “{word}” button, where a person usually confirms.",
        params,
      };
    default:
      return {
        key: "Asked because the button may pay, send, delete or confirm something.",
        params: {},
      };
  }
}

/**
 * The action as a short noun phrase — "toss.im에서 ‘비즈니스’ 누르기" — for the line a decided card
 * leaves behind.
 *
 * Not `describeSubject` cut short: that is a sentence about what the Bot WANTS, written to be
 * answered, and after the answer it is the wrong tense. Walked for Korean by
 * `approval-decision.test.ts`, for the reason `subjectPhrases` is walked by its own test.
 */
export function actionNounPhrase(subject: AskSubject | undefined): Phrase {
  if (!subject) {
    return { key: "something this screen cannot name", params: {} };
  }
  const host = subject.host ?? "";
  const name = readableLabel(subject.element?.name ?? "");
  switch (subject.intent) {
    case "activate":
      if (name && host) {
        return { key: "pressing “{name}” on {host}", params: { name, host } };
      }
      if (name) return { key: "pressing “{name}”", params: { name } };
      return host
        ? { key: "pressing something on {host}", params: { host } }
        : { key: "pressing something on the page", params: {} };
    case "type":
      if (name && host) {
        return {
          key: "typing into “{name}” on {host}",
          params: { name, host },
        };
      }
      if (name) return { key: "typing into “{name}”", params: { name } };
      return host
        ? { key: "typing into a field on {host}", params: { host } }
        : { key: "typing into a field on the page", params: {} };
    case "navigate":
      return host
        ? {
            key: "opening {host}{path}",
            params: { host, path: subject.path ?? "" },
          }
        : { key: "opening a page", params: {} };
    case "read":
      return host
        ? { key: "looking at {host}", params: { host } }
        : { key: "looking at the page", params: {} };
    case "read_file":
      return {
        key: "reading the file {path}",
        params: { path: subject.file?.path ?? "" },
      };
    case "write_file":
      return {
        key: "writing to the file {path}",
        params: { path: subject.file?.path ?? "" },
      };
    case "list_files": {
      const path = subject.file?.path ?? "";
      return path && path !== "."
        ? { key: "listing what is in {path}", params: { path } }
        : { key: "listing what is in the workspace", params: {} };
    }
    case "upload": {
      const path = subject.file?.path ?? "";
      return host
        ? {
            key: "uploading the file {path} to {host}",
            params: { path, host },
          }
        : { key: "uploading the file {path}", params: { path } };
    }
    case "call_tool": {
      const server = subject.tool?.server ?? "";
      const tool = subject.tool?.name ?? "";
      return {
        key: "using “{tool}” on {server}",
        params: {
          tool: toolLabel(`${server}/${tool}`) ?? tool,
          server: serviceLabel(server) ?? server,
        },
      };
    }
    default:
      return host
        ? { key: "doing something on {host}", params: { host } }
        : { key: "doing something on the page", params: {} };
  }
}

/**
 * WHAT BECAME OF A QUESTION, kept so the card can fold into a line instead of vanishing.
 *
 * An answered card used to disappear from the conversation entirely: "Deny" left nothing behind,
 * not a word, and "Allow" left nothing either — somebody scrolling back could not see what they had
 * let their Bot do on a bank's site (UI/UX audit 0.5.3, item 3). The decision is held against the
 * tool call, as the question was, and drawn in its place.
 *
 * `tier` comes from the card that was pressed, or from the server's record, which carries it beside
 * `granted` for a yes wider than this once. A yes with no tier on it was this once.
 */
export type ApprovalDecision = {
  outcome: "allowed" | "declined" | "unanswered";
  tier?: ApprovalTier;
  subject?: AskSubject;
  /**
   * The question a No answered, and whose Bot: what 다시 물어보기 names when the person takes the
   * No back (`reconsiderDecline`). Absent on a decision recorded before it was kept.
   */
  approvalId?: string;
  botId?: string;
  /** The person took this No back: the next attempt at the action is asked about again. */
  reconsidered?: boolean;
};

/** The line a decided card leaves behind, as one dictionary key and its values. */
export function decisionPhrase(decision: ApprovalDecision): Phrase {
  const said = actionNounPhrase(decision.subject);
  const action = t(said.key, said.params);
  if (decision.outcome === "declined") {
    return decision.reconsidered
      ? { key: "Will ask again next time · {action}", params: { action } }
      : { key: "Denied · {action}", params: { action } };
  }
  if (decision.outcome === "unanswered") {
    return {
      key: "No answer came, so it did not go ahead · {action}",
      params: { action },
    };
  }
  if (decision.tier === "always") {
    return { key: "Always allowed · {action}", params: { action } };
  }
  if (decision.tier === "thread") {
    return {
      key: "Allowed for this conversation · {action}",
      params: { action },
    };
  }
  return { key: "Allowed · {action}", params: { action } };
}

/**
 * Where the decisions are kept, so a reload does not take them away.
 *
 * In this browser's storage and nowhere else, which is an honest limit rather than a gap papered
 * over: the server keeps a question in memory for its ten minutes and on purpose never in a table
 * (`server/src/computer/approvals.ts`), and the transcript holds the tool call's result, not who
 * answered what. So a card answered here still reads as answered after a reload here; on another
 * device the step's own line ("사람이 거절함") is what remains. One person per deployment, so there
 * is nobody else's decision in this store to show.
 *
 * Bounded, oldest out, so a year of questions does not grow the storage without end.
 */
const DECISIONS_KEY = "laf.approval-decisions.v1";
const DECISIONS_KEPT = 200;

let decided: Map<string, ApprovalDecision> | null = null;

function decisions(): Map<string, ApprovalDecision> {
  if (decided) return decided;
  const read = new Map<string, ApprovalDecision>();
  try {
    const raw = globalThis.localStorage?.getItem(DECISIONS_KEY);
    const rows: unknown = raw ? JSON.parse(raw) : [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!Array.isArray(row) || typeof row[0] !== "string") continue;
      const decision = decisionOf(row[1]);
      if (decision) read.set(row[0], decision);
    }
  } catch {
    // Nothing to read, or nothing readable: the decisions made from now on are still drawn.
  }
  decided = read;
  return read;
}

/** A stored decision, checked: storage is text an older build may have written. */
function decisionOf(value: unknown): ApprovalDecision | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { outcome, tier, subject, approvalId, botId, reconsidered } =
    value as Record<string, unknown>;
  if (
    outcome !== "allowed" &&
    outcome !== "declined" &&
    outcome !== "unanswered"
  ) {
    return undefined;
  }
  const checked = askSubjectOf(subject);
  return {
    outcome,
    ...(tier === "once" || tier === "thread" || tier === "always"
      ? { tier }
      : {}),
    ...(checked ? { subject: checked } : {}),
    ...(typeof approvalId === "string" && approvalId ? { approvalId } : {}),
    ...(typeof botId === "string" && botId ? { botId } : {}),
    ...(reconsidered === true ? { reconsidered: true } : {}),
  };
}

function keepDecisions(held: Map<string, ApprovalDecision>): void {
  try {
    const rows = [...held].slice(-DECISIONS_KEPT);
    globalThis.localStorage?.setItem(DECISIONS_KEY, JSON.stringify(rows));
  } catch {
    // Nowhere to keep it. The line still stands for as long as this tab is open.
  }
}

/**
 * The question on this tool call was decided: take the buttons down and leave the line.
 *
 * A decision already held for the call is kept rather than replaced, with one exception: a yes
 * held without its width is completed by one that has it. First writer used to win outright, and the
 * wait holding the tool call — which reads "allowed" off the server a second at a time — could write
 * before the "항상 허용" press's own answer came back, so a standing allowance was recorded, and
 * drawn, as a one-time "허용함" with no way back offered (measured 2026-09-25 on toss.im).
 */
export function decideQuestion(
  toolCallId: string,
  decision: ApprovalDecision,
): void {
  if (!toolCallId) return;
  const held = decisions();
  const before = held.get(toolCallId);
  if (!before) {
    held.set(toolCallId, decision);
    keepDecisions(held);
  } else if (
    before.outcome === "allowed" &&
    decision.outcome === "allowed" &&
    !before.tier &&
    decision.tier
  ) {
    held.set(toolCallId, { ...before, tier: decision.tier });
    keepDecisions(held);
  }
  open.delete(toolCallId);
  for (const watcher of watchers) watcher();
}

export function decisionOn(toolCallId: string): ApprovalDecision | undefined {
  return decisions().get(toolCallId);
}

/**
 * "다시 물어보기": take back a No before it runs out, from the line its card left.
 *
 * A No stands for half an hour after its question closed (`DECLINE_STICKS_MS` on the server), and
 * the question itself is gone after ten minutes — so a person who changed their mind could not say
 * so from the conversation, and the Bot was refused without asking (0.5.4 QA). This reopens nothing
 * and allows nothing: the next time the Bot tries, it is asked about again, on a card of its own.
 *
 * A 409 is success here: no No of that question stands any more (it ran out, or a restart forgot
 * it), which is the same fact — the next attempt asks.
 */
export async function reconsiderDecline(
  toolCallId: string,
  decision: ApprovalDecision,
): Promise<ApprovalAnswerResult> {
  if (!decision.approvalId || !decision.botId) {
    return { ok: false, gone: false, retryable: false };
  }
  let response: Response;
  try {
    response = await fetch(
      `/api/approvals/${encodeURIComponent(decision.botId)}/${encodeURIComponent(decision.approvalId)}/reconsider`,
      { method: "POST", credentials: "include" },
    );
  } catch {
    return { ok: false, gone: false, retryable: true };
  }
  if (response.ok || response.status === 409) {
    const held = decisions();
    held.set(toolCallId, { ...decision, reconsidered: true });
    keepDecisions(held);
    for (const watcher of watchers) watcher();
    return { ok: true };
  }
  if (response.status >= 500) {
    return { ok: false, gone: false, retryable: true };
  }
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
  } | null;
  return {
    ok: false,
    gone: false,
    retryable: false,
    ...(typeof body?.code === "string" ? { code: body.code } : {}),
  };
}

/**
 * A pause reply, read once, in one place.
 *
 * Two callers meet this shape — an acting call on the computer and a call to somebody else's server
 * — and until this existed they each unpicked it field by field, in their own file, into their own
 * object. Which meant that adding a field to the reply and forwarding it in one of them left the
 * other silently dropping it, with both sides' tests green: measured, the "always allow" button
 * simply never appeared, because one of the two hops had not been told the scope existed.
 *
 * Null for anything that is not a pause, so a caller can ask this question and the "is it one"
 * question at the same time.
 */
export function pauseFrom(
  body: Record<string, unknown> | null,
): Omit<OpenQuestion, "botId"> | null {
  if (body?.awaitingApproval !== true) return null;
  // What an outward call will send, checked entry by entry. Absent leaves the card as it was.
  const preview = callPreviewOf(body.preview);
  return {
    approvalId: typeof body.approvalId === "string" ? body.approvalId : "",
    // Undefined where the reply carried no subject or one this build does not recognise. The card
    // then says it is being asked about something it cannot name, which is the honest failure: the
    // alternative is a sentence somebody consents to that describes an action nobody sent.
    subject: askSubjectOf(body.subject),
    ...(preview ? { preview } : {}),
    rule: typeof body.rule === "string" ? body.rule : null,
    scope: allowanceScopeOf(body.scope),
    // The conversation the question came from, when the server said so. The third button is drawn
    // off this and nothing else: a card that offered "for this conversation" for a question raised
    // from nowhere would be a button the answering route silently ignores.
    ...(typeof body.threadId === "string" && body.threadId
      ? { threadId: body.threadId }
      : {}),
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : "",
  };
}

/** A question one tool call is waiting on, as its own line in the transcript needs to draw it. */
export type OpenQuestion = {
  approvalId: string;
  botId: string;
  /** What it is about, in facts. Undefined when the reply did not carry a subject we understand. */
  subject: AskSubject | undefined;
  /** What an outward call will send, already checked. The card draws it under the question. */
  preview?: CallPreview | undefined;
  rule: string | null;
  /** What answering "always" would cover, or undefined when only this once is on offer. */
  scope?: AllowanceScope | undefined;
  /**
   * The conversation the question came from, when it came from one.
   *
   * Present means "for this conversation" is on offer beside "always". The server decided which
   * thread from the request that raised the question; it is never sent back when the button is
   * pressed, for the same reason the scope is not.
   */
  threadId?: string | undefined;
  /** When the question stops being answerable, so the card can count down. Empty when unknown. */
  expiresAt: string;
};

const open = new Map<string, OpenQuestion>();
const watchers = new Set<() => void>();
/**
 * Every line an approval was ever drawn on in this tab, and what it was about — kept after the card
 * closes. A card closes on a 409 the moment another window has answered, before this tab's wait has
 * read that answer; the wait still has to find the line to leave the answer on. More than one line
 * when the page a notice opens draws the same question beside the conversation's own card.
 */
const raised = new Map<string, Map<string, AskSubject | undefined>>();

/**
 * Say that this tool call is waiting on an answer, so its line can draw the card.
 *
 * Handed over rather than fetched again: the server said all of it in the reply that paused the
 * call, and a card that re-derived its question from a list would be back to guessing which entry
 * in that list was its own.
 */
export function openQuestion(toolCallId: string, question: OpenQuestion): void {
  if (!toolCallId) return;
  open.set(toolCallId, question);
  const asking = raised.get(question.approvalId) ?? new Map();
  asking.set(toolCallId, question.subject);
  raised.set(question.approvalId, asking);
  for (const watcher of watchers) watcher();
}

/** The wait is over, whichever way it went. Nothing should still be offering buttons for it. */
export function closeQuestion(toolCallId: string): void {
  if (!open.delete(toolCallId)) return;
  for (const watcher of watchers) watcher();
}

export function questionOn(toolCallId: string): OpenQuestion | undefined {
  return open.get(toolCallId);
}

/** Everything currently waiting, for a reader that wants the set rather than one entry. */
export function openQuestions(): OpenQuestion[] {
  return [...open.values()];
}

/**
 * The same set with the tool call each question is on — for a reader that points back at the card,
 * like the header's drawer ("사장님 차례" → the card in the conversation).
 */
export function openQuestionCalls(): {
  toolCallId: string;
  question: OpenQuestion;
}[] {
  return [...open.entries()].map(([toolCallId, question]) => ({
    toolCallId,
    question,
  }));
}

/**
 * Whether anything at all is waiting on an answer.
 *
 * The card itself is a transcript row, so scrolling up past it takes the only sign that a Bot is
 * blocked off the screen — and a Bot that has stopped to ask looks exactly like a Bot that has
 * stopped. The transcript's status slot uses this to keep saying so wherever the reader is.
 */
export function anyQuestionOpen(): boolean {
  return open.size > 0;
}

export function watchQuestions(listener: () => void): () => void {
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
  };
}

/**
 * The open questions for one Bot, or null if the server could not be asked.
 *
 * Null and an empty list are kept apart on purpose. A caller waiting for its own answer must not read
 * a failed request as "the question is gone", which is what an empty list means here.
 */
export async function readApprovals(
  botId: string,
): Promise<PendingApproval[] | null> {
  try {
    const response = await fetch(`/api/approvals/${botId}`, {
      credentials: "include",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { approvals?: PendingApproval[] };
    return body.approvals ?? [];
  } catch {
    return null;
  }
}

/**
 * What became of an answer.
 *
 * `gone` is the server's 409: the question expired, or somebody answered it in another tab. Nothing
 * is broken and there is nothing to retry, so a card that hears it should come down rather than sit
 * there with an error beside two buttons that will never work again.
 *
 * `retryable` says whether pressing again could go differently: nothing came back, or the server
 * broke on the way. Anything else it answered is a refusal — signed out, a Bot that is not this
 * person's or is not there any more — and is told the same however often it is pressed; `code` is
 * its fact. Measured 2026-09-16 (audit R5-06): every refusal was read as "not gone", and the card
 * said "다시 시도해 주세요" in front of a 403 no press could get past.
 *
 * No prose crosses this boundary. The server's sentences are English, and a component that rendered
 * them would show a Korean reader English no matter what the dictionary said — so this reports what
 * happened, and `answerProblem` below is where it becomes words.
 */
export type ApprovalAnswerResult =
  | { ok: true }
  | { ok: false; gone: boolean; retryable: boolean; code?: string };

export async function answerApproval(
  botId: string,
  approvalId: string,
  granted: boolean,
  /**
   * "And stop asking me about this" — for this conversation, or for good.
   *
   * A tier, not a scope and not a thread. What it covers and which conversation were decided when
   * the question was raised and are held on the server's own record; sending either from here
   * would let a page grant itself something other than what it displayed. Only meaningful
   * alongside `granted: true` — there is no "always deny", because a thing that should never
   * happen belongs in the boundary where everybody can read it.
   */
  tier: ApprovalTier = "once",
): Promise<ApprovalAnswerResult> {
  let response: Response;
  try {
    response = await fetch(`/api/approvals/${botId}/${approvalId}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ granted, tier }),
    });
  } catch {
    // It never arrived, so nothing was recorded and another press is a fresh attempt.
    return { ok: false, gone: false, retryable: true };
  }
  if (response.ok) return { ok: true };
  if (response.status === 409) {
    return { ok: false, gone: true, retryable: false };
  }
  // A server that broke or is restarting (the front door's 503) may well take the next press.
  if (response.status >= 500) {
    return { ok: false, gone: false, retryable: true };
  }
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
  } | null;
  return {
    ok: false,
    gone: false,
    retryable: false,
    ...(typeof body?.code === "string" ? { code: body.code } : {}),
  };
}

/**
 * The refusals an answer can meet beyond the session guard's own (`ACCESS_REFUSALS`), by code.
 *
 * `t()` on a variable, so `approval-answers.test.tsx` walks this table for its Korean.
 */
export const ANSWER_REFUSALS: Record<string, string> = {
  // The ownership guard's fact. "Not yours" and "not here" are one answer on purpose
  // (`server/src/auth/guards.ts`), and for the person a question was raised for it is the second:
  // the Bot was deleted while it waited.
  "laf:bot_not_found":
    "This Bot is no longer here, so its question cannot be answered.",
};

/**
 * What a card says when an answer did not go through — the same words on a conversation's line and
 * in a room, so one press means one thing on both.
 *
 * "Try again" only where another press can go differently. Saying it in front of a refusal is how a
 * working feature comes to look broken; the refusal is said as what it is instead.
 */
export function answerProblem(
  result: Extract<ApprovalAnswerResult, { ok: false }>,
): string {
  if (result.retryable) {
    return t("That answer could not be recorded. Try again.");
  }
  return refusalText(
    ANSWER_REFUSALS,
    result.code,
    t("That answer could not be recorded."),
  );
}

/**
 * Hold a tool call open until somebody answers its question.
 *
 * Polled rather than pushed. The answer arrives on a server this tab has no other channel to, and it
 * may well be given in a different tab or by a different person, so the only honest way to learn it
 * is to keep asking. A second between looks costs one request while a Bot is stopped and nothing at
 * all the rest of the time.
 */
export async function waitForApproval(
  botId: string,
  approvalId: string,
  signal: AbortSignal | undefined,
): Promise<"granted" | "declined" | "gave up" | "cancelled" | "handed over"> {
  const deadline = Date.now() + WAIT_FOR_ANSWER_MS;
  heldHere.set(approvalId, botId);
  listenForLeaving();
  try {
    while (Date.now() < deadline) {
      // Stop must work out of this wait as well, or pressing it leaves a Bot parked on a question
      // nobody is going to answer.
      if (signal?.aborted) return "cancelled";
      /*
       * HELD, NOT MERELY READ. Asking after the question by holding it is what tells every other
       * window of this conversation that this one is alive and will carry the step on, so none of
       * them does it a second time (`server/src/computer/approvals.ts`, `hold`).
       */
      const held = await holdApproval(botId, approvalId);
      // Gone from a server we did reach means it expired and was swept, which is the same outcome
      // as running out of patience here. A server we could NOT reach says nothing, so it is not read
      // as an answer.
      if (held.state === "gone") {
        return settled(approvalId, "unanswered", "gave up");
      }
      // Another window took the step while this one was asleep — a hidden tab is throttled to a
      // timer a minute, and one frozen for longer counts as gone. That window carries it on now.
      if (held.state === "elsewhere") return "handed over";
      const mine = held.state === "holding" ? held.approval : undefined;
      if (mine?.granted === true) {
        return settled(approvalId, "allowed", "granted", mine.tier);
      }
      if (mine?.granted === false) {
        return settled(approvalId, "declined", "declined");
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    }
    return settled(approvalId, "unanswered", "gave up");
  } finally {
    heldHere.delete(approvalId);
  }
}

/**
 * The questions this window is holding the step of, by approval, with their Bot: what it lets go
 * of when the page goes away, and what tells this window's own conversation that a question on
 * its screen is already being waited on here.
 */
const heldHere = new Map<string, string>();

/** Whether this window is the one waiting on this question and will carry its step on. */
export function isHeldHere(approvalId: string): boolean {
  return heldHere.has(approvalId);
}

/**
 * This window's name for itself, as the server tells holders apart. Made up per page load: a
 * reloaded window is a new window, and it is the reload that let the old one go.
 */
let windowId: string | undefined;
function thisWindow(): string {
  windowId ??= crypto.randomUUID();
  return windowId;
}

/** What holding a question's step came to. */
export type HoldResult =
  | { state: "holding"; approval: PendingApproval }
  /** Another window holds it and is alive; this one draws the card and leaves the rest to that. */
  | { state: "elsewhere"; approval: PendingApproval }
  /** Not open any more: answered and spent, withdrawn, or run out. */
  | { state: "gone" }
  /** The server could not be asked. Says nothing about the question. */
  | { state: "unknown" };

export async function holdApproval(
  botId: string,
  approvalId: string,
): Promise<HoldResult> {
  let response: Response;
  try {
    response = await fetch(
      `/api/approvals/${encodeURIComponent(botId)}/${encodeURIComponent(approvalId)}/hold`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ holder: thisWindow() }),
      },
    );
  } catch {
    return { state: "unknown" };
  }
  if (response.status === 409) return { state: "gone" };
  if (!response.ok) return { state: "unknown" };
  const body = (await response.json().catch(() => null)) as {
    approval?: PendingApproval;
    holding?: boolean;
  } | null;
  if (!body?.approval) return { state: "unknown" };
  return body.holding === true
    ? { state: "holding", approval: body.approval }
    : { state: "elsewhere", approval: body.approval };
}

/**
 * THE PAGE IS GOING AWAY: let go of every step it holds, so the next window to open the
 * conversation carries them on at once rather than after the quiet the server allows a window that
 * could not say so. `pagehide` rather than `beforeunload`, which a phone does not fire when the tab
 * is swiped away; `keepalive` so the request outlives the page that sent it.
 */
let listening = false;
function listenForLeaving(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("pagehide", (event) => {
    // Kept in the back/forward cache, the page is not gone: it comes back holding what it held.
    if (event.persisted) return;
    for (const [approvalId, botId] of heldHere) {
      void fetch(
        `/api/approvals/${encodeURIComponent(botId)}/${encodeURIComponent(approvalId)}/release`,
        {
          method: "POST",
          credentials: "include",
          keepalive: true,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ holder: thisWindow() }),
        },
      ).catch(() => {});
    }
  });
}

/**
 * The turn that raised this question was stopped: close it, so no window goes on offering buttons
 * for an answer nobody is waiting for. Not a No — nothing is refused and the next attempt asks.
 */
export async function withdrawApproval(
  botId: string,
  approvalId: string,
): Promise<void> {
  try {
    await fetch(
      `/api/approvals/${encodeURIComponent(botId)}/${encodeURIComponent(approvalId)}/withdraw`,
      { method: "POST", credentials: "include" },
    );
  } catch {
    // Unreachable: it runs out on its own in ten minutes, as every question did before this.
  }
}

/**
 * The card for a question this window learned about from the server rather than from its own tool
 * call — raised in another window, or by this conversation before a reload. The same fields the
 * pause reply carries, off the server's record.
 */
export function questionFromRecord(approval: PendingApproval): OpenQuestion {
  const preview = callPreviewOf(approval.preview);
  return {
    approvalId: approval.id,
    botId: approval.botId,
    subject: askSubjectOf(approval.subject),
    ...(preview ? { preview } : {}),
    rule: approval.rule || null,
    scope: allowanceScopeOf(approval.scope),
    ...(approval.threadId ? { threadId: approval.threadId } : {}),
    expiresAt: approval.expiresAt,
  };
}

/**
 * What the wait learned, left on the card's line before the wait hands its answer back.
 *
 * Here because this is where a question answered in ANOTHER window is first known about in this
 * one — that card's press recorded nothing here, and without this the line would vanish as it used
 * to. The tier is the server's, so a yes this wait reads first is recorded as wide as it was given.
 */
function settled<Answer>(
  approvalId: string,
  outcome: ApprovalDecision["outcome"],
  answer: Answer,
  tier?: ApprovalTier,
): Answer {
  for (const [toolCallId, subject] of raised.get(approvalId) ?? []) {
    decideQuestion(toolCallId, {
      outcome,
      ...(tier ? { tier } : {}),
      ...(subject ? { subject } : {}),
    });
  }
  return answer;
}
