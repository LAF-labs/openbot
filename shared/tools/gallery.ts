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
 * What a card's call answers when the grant could not be asked about at all — the store threw.
 *
 * Named, because it is the one way a card's call ends without the card that is neither a fact from
 * the table nor an object of this server's: the surface could not tell it from the card going on
 * screen, and drew the card (`cardEndingOf` in the app's `components/gallery/refused.tsx`).
 */
export const CARD_NOT_ASKED =
  "This deployment could not be asked whether that card is allowed, so it was not shown.";

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

/**
 * WHAT THIS PERSON'S ACCOUNTS ARE, WRITTEN ON THE CONNECT CARD A TURN HANDS ON.
 *
 * Each account this deployment can connect, by its catalogue key, with whether 연결 says it is on —
 * read from the connection's own row for every message (`readAccountStates`,
 * `server/src/plugins/overview-routes.ts`) and written here by the turn
 * (`server/src/turns/chat-tools.ts`). A keyword of this product's own, in JSON Schema's place for
 * those (`x-…`), at the top of the card's parameters.
 *
 * WHY ON THE CARD. A lookup that finds nothing has to say what could be connected, and it is
 * answered where only the run's tool list is known (`searchResultText`, `bridge.ts`): three fields
 * a tool, nothing else on the wire. The card is the tool that connecting is done with, it stands
 * behind the bridge — so nothing at the head of the prompt moves when somebody connects an account
 * (`toolsFingerprint` counts core tools only) — and a run that has no card, a routine's, has nobody
 * to connect anything and is told nothing about it.
 *
 * STATE, NOT A GUESS FROM WHAT IS MISSING. "No tool of that service in the list" was read as "not
 * connected" for a day (2026-10-05). An account can be on and have brought nothing — 카카오's
 * toolbox is the person's own and may be empty, a listing can fail at connect — and a Bot told
 * "not connected" raised the card, was told "already on, look the tools up", looked, and was told
 * "not connected" again, for thirty steps.
 */
export const ACCOUNT_STATES = "x-accounts";

export type AccountState = { key: string; connected: boolean };

const isAccountState = (value: unknown): value is AccountState =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as AccountState).key === "string" &&
  typeof (value as AccountState).connected === "boolean";

/** The card's parameters with the accounts written on them. Anything not an object is left alone. */
export function withAccountStates(
  parameters: unknown,
  accounts: readonly AccountState[],
): unknown {
  if (!parameters || typeof parameters !== "object") return parameters;
  return {
    ...parameters,
    [ACCOUNT_STATES]: accounts.map(({ key, connected }) => ({
      key,
      connected,
    })),
  };
}

/** What a turn wrote there, or null where none did. */
export function accountStatesIn(parameters: unknown): AccountState[] | null {
  if (!parameters || typeof parameters !== "object") return null;
  const written = (parameters as Record<string, unknown>)[ACCOUNT_STATES];
  return Array.isArray(written) ? written.filter(isAccountState) : null;
}

/** The card's parameters as the window declared them: what a Bot is shown as its schema. */
export function withoutAccountStates(parameters: unknown): unknown {
  if (!parameters || typeof parameters !== "object") return parameters;
  const { [ACCOUNT_STATES]: _states, ...declared } = parameters as Record<
    string,
    unknown
  >;
  return declared;
}

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
  /**
   * What was offered is connected, and it brought nothing a Bot can use: an account with no tool
   * in this turn's list. Not `laf:connection_on`, which sends the Bot to look the tools up.
   */
  | "laf:connection_unusable"
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
  /**
   * False when nothing that is connected can be worked through: every connected one is an account
   * and none of them has a tool in this turn's list. Only the turn knows, so only the turn says.
   */
  isUsable?: boolean;
  tools?: readonly string[];
}): ConnectionAnswer {
  const connected = input.offered.filter((id) => input.connected.includes(id));
  const code: ConnectionOutcome =
    input.isOffered === false
      ? "laf:connection_not_offered"
      : connected.length === 0
        ? "laf:connection_off"
        : input.isUsable === false
          ? "laf:connection_unusable"
          : "laf:connection_on";
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
  "laf:connection_unusable",
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
