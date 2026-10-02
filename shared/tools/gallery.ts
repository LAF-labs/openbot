/**
 * What the model is told when a gallery card goes on screen, and what a card reads for itself.
 *
 * These were written beside each component in the app (`components/gallery/*.tsx`), which was the
 * only place a card's call was ever carried out. A turn the server owns carries it out on the
 * server (`server/src/turns/chat-tools.ts`), and a Bot must read the same sentence whichever side
 * did — so the sentences live here, and the gallery specs name them from here.
 */
import { toolResultText } from "../prompt/tool-results.ko";

/** The sentence a card's call answers the model with, by the card's name. */
export const GALLERY_CONFIRMATIONS: Readonly<Record<string, string>> = {
  showRecord: "The record is now on screen for the person.",
  showMetrics: "The figures are now on screen for the person.",
  showChecklist: "The checklist is now on screen for the person.",
  showNotice: "The notice is now on screen for the person.",
  showBarChart: "The bar chart is now on screen for the person.",
  showPieChart: "The donut chart is now on screen for the person.",
  showLineChart: "The line chart is now on screen for the person.",
  showAreaChart: "The area chart is now on screen for the person.",
  showProgress: "The progress chart is now on screen for the person.",
  showActivityReport:
    "The report is on screen for the person, filled with figures read from this deployment. You were not given the figures.",
  showFile:
    "The file card is on screen for the person, with its name, its size and a button to download it. Do not paste the file's contents into your answer again.",
};

/**
 * The card that hands the person a file from the Bot's folder (`components/gallery/file.tsx`).
 *
 * Named here because it is the one card whose confirmation is conditional: the sentence above is
 * only true of a file that is there, so a turn checks before it says it
 * (`server/src/turns/chat-tools.ts`), and a refused one is not filed under 만든 것.
 */
export const FILE_CARD = "showFile";

/** What a card that is not in the table above — a component authored in the browser — answers. */
export const ON_SCREEN = "It is now on screen for the person.";

/**
 * The cards whose call IS a question to the person: the call waits for their answer, and the answer
 * is its result. No confirmation, because there is nothing to confirm until somebody chooses.
 */
export const GALLERY_DECISIONS: ReadonlySet<string> = new Set([
  "askApproval",
  "askChoice",
  // 연결's switches: the call waits until one is on, or the person says not now.
  "showConnection",
]);

/** The connect card, by the name its call is made under. */
export const CONNECT_CARD = "showConnection";

const isSaid = (value: unknown): boolean =>
  typeof value === "string" && value.trim() !== "";

/**
 * WHETHER A QUESTION CARD HAS A QUESTION IN IT: something to read and, for a choice, something to
 * press.
 *
 * Pressed on the running app, 2026-10-03. Asked for a choice card, the fleet's model called
 * `askChoice` with `{}`. The cards stand behind the bridge (`bridge.ts`): a Bot is told their names
 * and reads a schema when it looks one up, and a call made from what it remembers of an earlier
 * look can arrive with nothing in it. The turn waited on it all the same — a card with no title
 * and no options saying 답을 기다려요, for the ten minutes a question may wait, with nothing on it
 * to say what was being asked.
 *
 * THESE CARDS' OWN RULES, NOT THE DECLARED SCHEMA'S. The window declares `options` as required and
 * the persona question is asked without any — the card draws its four itself — while an empty
 * list satisfies a schema and can be answered by nobody. An option needs both what comes back
 * (`id`) and what is read (`label`). An approval needs what is being agreed to (`summary`) as well
 * as its name: a yes to a title alone is a yes to nothing in particular.
 *
 * The connect card is not asked here: what it offers is checked against what this deployment has
 * (`server/src/turns/chat-tools.ts`, `connectCard`).
 */
export function isAskable(
  name: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  if (name === "askApproval") return isSaid(args.title) && isSaid(args.summary);
  if (name !== "askChoice") return true;
  if (!isSaid(args.title)) return false;
  if (args.saves === "persona") return true;
  const options = args.options;
  return (
    Array.isArray(options) &&
    options.length > 0 &&
    options.every(
      (option) =>
        option !== null &&
        typeof option === "object" &&
        isSaid((option as { id?: unknown }).id) &&
        isSaid((option as { label?: unknown }).label),
    )
  );
}

/**
 * How a connect card's wait came out. Facts, as codes; the sentence a Bot reads for each is in
 * `shared/prompt/tool-results.ko.ts`, and the words a person reads are the card's own.
 */
export type ConnectionOutcome =
  /** At least one of what was offered is connected now. */
  | "laf:connection_on"
  /** None is: the person said not now, or left the switches alone. */
  | "laf:connection_off"
  /** Nothing that was offered exists on this deployment, so no switch was drawn. */
  | "laf:connection_not_offered";

/**
 * A CONNECT CARD'S ANSWER — what the call waited for.
 *
 * The card used to be drawn and the turn ended: "the switches are on screen", and the person, having
 * turned one on, had to ask for the same thing again (the reference this was read against pauses
 * its run on the card and resumes it when the connection lands — `~/laf/docs/open-dot-review-2026-10-01.md`
 * B2). Now the call waits, and its answer says which of the offered services are on, so the Bot goes
 * straight on with what was asked.
 *
 * `tools` names what a connection that landed during the wait put behind the bridge. The context
 * layer that lists deferred tools is frozen for the epoch and its reminder rides on the person's
 * NEXT message (`server/src/context/conversations.ts`), so inside the turn this answer is the only
 * place the Bot can learn those names from.
 */
export type ConnectionAnswer = {
  code: ConnectionOutcome;
  /** Of the services the Bot offered, the ones connected now. */
  connected: string[];
  /** And the ones that are not. */
  notConnected: string[];
  tools?: string[];
  /** What the Bot reads. */
  reason: string;
};

export function connectionAnswer(input: {
  /** What the Bot's call offered. */
  offered: readonly string[];
  /** Of those, what is connected now — by 연결's own reading, never by anybody's say-so. */
  connected: readonly string[];
  /** False when this deployment has none of the offered services at all. */
  isOffered?: boolean;
  tools?: readonly string[];
}): ConnectionAnswer {
  const connected = input.offered.filter((id) => input.connected.includes(id));
  const code: ConnectionOutcome =
    input.isOffered === false
      ? "laf:connection_not_offered"
      : connected.length > 0
        ? "laf:connection_on"
        : "laf:connection_off";
  return {
    code,
    connected,
    notConnected: input.offered.filter((id) => !connected.includes(id)),
    ...(input.tools && input.tools.length > 0
      ? { tools: [...input.tools] }
      : {}),
    reason: toolResultText(code),
  };
}

const CONNECTION_OUTCOMES: readonly string[] = [
  "laf:connection_on",
  "laf:connection_off",
  "laf:connection_not_offered",
];

/** A stored connect answer, read back for the card. Null for anything that is not one. */
export function readConnectionAnswer(
  result: unknown,
): Pick<ConnectionAnswer, "code" | "connected" | "notConnected"> | null {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const answer = value as Record<string, unknown>;
  if (
    typeof answer.code !== "string" ||
    !CONNECTION_OUTCOMES.includes(answer.code)
  ) {
    return null;
  }
  const ids = (list: unknown) =>
    Array.isArray(list)
      ? list.filter((id): id is string => typeof id === "string")
      : [];
  return {
    code: answer.code as ConnectionOutcome,
    connected: ids(answer.connected),
    notConnected: ids(answer.notConnected),
  };
}

/** Which server-side function each activity report reads. Not the model's choice. */
export const ACTIVITY_REPORT_FUNCTIONS: Readonly<Record<string, string>> = {
  activity: "botActivity",
  refusals: "recentRefusals",
};

/**
 * The data functions a card's call will read, checked against the card's grants before it is
 * drawn. Only the activity report reads anything; every other card draws what it was handed.
 */
export function galleryReads(
  name: string,
  args: Record<string, unknown>,
): readonly string[] {
  if (name !== "showActivityReport") return [];
  const report = typeof args.report === "string" ? args.report : undefined;
  const functionName = report ? ACTIVITY_REPORT_FUNCTIONS[report] : undefined;
  return functionName ? [functionName] : [];
}
