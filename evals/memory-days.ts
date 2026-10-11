/**
 * `eval:memory-days` — what an owner said in passing, days later. A MEASUREMENT, not a verdict:
 * nothing here passes or fails, and it exits 0 whatever the numbers are.
 *
 * WHY. A fact the Bot did not write to 수첩 (`remember`) lives only in the transcript and in the
 * day's summary, and the summary is merged every night and cut oldest-first at 3,000 characters
 * (`server/src/context/day-close.ts`). The `days` case of `eval:cache` plants two needles and asks
 * on day 5; nobody had measured, per kind of fact, whether one is written down at the moment,
 * whether the summary still holds it after a night, three nights and a week, and what the Bot says
 * when it does not. Four numbers, kept apart so a later change can be held against each:
 *
 *   capture   the owner says a durable fact inside a request for something else, never "기억해".
 *             One real turn on the production prompt and schema: did the Bot call `remember`, and
 *             did the line hold the fact? Three things it must NOT write ride beside the table
 *             (`./memory-days-facts.ts`), each attempt put to the product's own floors.
 *   survival  the fact NOT written down, and the conversation walked through 1, 3 and 7 day closes
 *             on the production store — its tick, the compaction, the server model's summary, the
 *             merge and the bound. Is the fact in what the Bot is given on the morning after?
 *   recall    that morning the owner asks in other words. The real answer, read by rule:
 *             correct · partial · asks-again · denies · wrong · other. And whether the Bot looked
 *             it up — `mcp__projects__read` `kind: search`, through the bridge, carried out by the
 *             production tool — with what the turn cost: requests, tokens, dollars, seconds.
 *   notebook  the same walk with the fact written down (the line in 수첩, the `remember` call in
 *             the thread): the control arm, measured rather than assumed.
 *
 * The walk has two kinds of week for a fact not written down. `passing` is the `days` case's:
 * quiet days that say nearly the same thing, which a summary folds into a few lines. `passing-busy`
 * is a week whose every turn carries something else worth keeping (`busyTurn`), so the bound has
 * something to push out. The notebook arm walks the quiet week.
 *
 * THE WALK reuses the `days` case's days (`./cache-days.ts`: four turns a day, one page read, the
 * same scripted answers), and differs in one thing: its filler turns ask no model. Only the closes
 * and the recall are real requests, so a week costs seven closes and three questions.
 *
 * WHAT IS MODELLED, AND SAID SO (docs/laf/eval-pack.md has the whole list):
 *   - the search reads this conversation from memory, by the production tool's own code path and
 *     the search's own matching rule and snippet; there is no database here, so no project exists
 *   - the owner's mail, drive and calendar are the product's own adapters over an account with
 *     nothing in it; any other connected tool is answered `laf:tool_failed`
 *   - the nightly dream and the hourly curation are not run (both need the database)
 *   - `remember` is answered by the product's floors and words, and nothing is stored
 *   - the Bot's day-1 answer in the walk is scripted: it does the request and does not restate the
 *     fact, so the fact stands on the owner's words alone
 *   - N is nights. A night whose day is under the close's 8,000-character floor makes no close,
 *     as in production; each table says how many closes were made
 *
 *   bun run eval:memory-days                 key / base URL / BOT_MODEL from .env
 *   EVAL_RUNS=3                              runs per cell (default 3)
 *   EVAL_MEMORY_PARTS=capture,days           which halves run
 *   EVAL_MEMORY_ARMS=passing,passing-busy,notebook   the walk's arms
 *   EVAL_ONLY=supplier-terms/aside,…         those facts alone
 *   EVAL_PROVIDER=…                          pin one OpenRouter provider, as eval:model does
 *   EVAL_MEMORY_CLOSES=1,3,7                 the mornings asked on (14,21 reaches the bound)
 *   EVAL_MEMORY_CONCURRENCY=4                walks at once
 *   EVAL_MEMORY_BUDGET_USD=1                 no new job starts past this
 *   EVAL_MEMORY_REPORT=path.json             print a saved report again, by today's rules
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { CompletionProvider } from "../agent-bot/src/provider";
import {
  looksLikeAnInstruction,
  looksLikeASecret,
  looksLikeAStandingOrder,
} from "../server/src/agents/memory-store";
import {
  createProjectSummaries,
  createProjectTools,
  readingOf,
} from "../server/src/channels/project-tool";
import {
  jevAsker,
  modelAsker,
  withFallback,
} from "../server/src/computer/decision-askers";
import { createCompactor } from "../server/src/context/compaction";
import { createConversationStore } from "../server/src/context/conversations";
import {
  createDaySummarizer,
  DAY_SUMMARY_SYSTEM,
  type StampedMessage,
  SUMMARY_MAX_CHARS,
} from "../server/src/context/day-close";
import { textOf as storedTextOf } from "../server/src/context/message-text";
import { callTool as gmailCall } from "../server/src/plugins/gmail-rest";
import { callTool as calendarCall } from "../server/src/plugins/google-calendar-rest";
import { callTool as driveCall } from "../server/src/plugins/google-drive-rest";
import { toolNameFor } from "../server/src/plugins/store";
import {
  type ConversationSearch,
  SEARCH_PAGE,
  snippetOf,
} from "../server/src/search/conversations";
import { MAX_MEMORY_LENGTH } from "../shared/notebook";
import {
  contextFactsFor,
  contextLayerText,
  systemPromptText,
} from "../shared/prompt";
import { HARNESS_VERSION } from "../shared/prompt/harness";
import { toolResultText } from "../shared/prompt/tool-results.ko";
import { openAccountsIn } from "../shared/tools/bridge";
import { PROJECT_TOOLS, READ_PROJECTS } from "../shared/tools/projects";
import { REMEMBER, UPDATE_PROFILE } from "../shared/tools/self";
import { answerText, TURNS as DAY_TURNS } from "./days-talk";
import { REALISTIC_TOOLSET } from "./deferral";
import {
  answerAfterTheLastCall,
  callsOf,
  clientMessagesOf,
  evalEffort,
  eventsOfSse,
  type ObservedCall,
  resultsOf,
  type StreamEvent,
  textOf,
} from "./lib";
import {
  beforeTheFact,
  busyTurn,
  decisionEndpointFor,
  FACTS,
  type Fact,
  lookupsOf,
  MUST_NOTS,
  type MustNot,
  meanOf,
  outOf,
  RECALLS,
  type Recall,
  recallOf,
  type Survival,
  survivalIn,
  writtenOf,
} from "./memory-days-facts";
import {
  CATALOGUE_HASH,
  EVAL_ABOUT,
  EVAL_BOT,
  EVAL_MEMORIES,
  EVAL_STANDING_ROLE,
  EVAL_TIME_ZONE,
  PROMPT_HASH,
} from "./prompt";

/**
 * `passing`       not written down, on the `days` case's quiet days
 * `passing-busy`  not written down, on days that each carry other things worth keeping
 * `notebook`      written down, on the quiet days — the control
 */
const ARMS = ["passing", "passing-busy", "notebook"] as const;
type Arm = (typeof ARMS)[number];

/**
 * How many day closes stand between the fact and the question: a night, three, a week.
 * `EVAL_MEMORY_CLOSES=14,21` walks further — the one way to see the summary's bound, which a week
 * of these days does not reach.
 */
let CLOSES: readonly number[] = (process.env.EVAL_MEMORY_CLOSES ?? "1,3,7")
  .split(",")
  .map((item) => Number.parseInt(item.trim(), 10))
  .filter((closes) => Number.isInteger(closes) && closes > 0)
  .sort((a, b) => a - b);
if (CLOSES.length === 0) CLOSES = [1, 3, 7];
const LAST_DAY = Math.max(...CLOSES);
const HOURS = [9, 11, 15, 19];
/** Which of a day's turns the owner says the fact in: the afternoon's. */
const SAID_TURN = 2;

const MODEL = process.env.BOT_MODEL?.trim() ?? "";
const KEY = process.env.OPENAI_API_KEY ?? "";
/*
 * THE KEY GOES WHERE THE BOT'S OWN REQUESTS GO, AND NOWHERE ELSE. Unset, agent-bot's client talks
 * to OpenAI, so the closes' calls do too — never to a default of this file's choosing. And Jev is
 * asked only where production would ask it (`decisionEndpointFor`).
 */
const BASE_URL =
  process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
const JEV_BASE_URL = decisionEndpointFor(process.env);
const SERVER_MODEL = process.env.SERVER_MODEL?.trim() || "z-ai/glm-5.3-flash";
const JEV_MODEL = process.env.EVAL_JEV_MODEL ?? "typesafe/jev-1.13-20260917";
const PROVIDER = process.env.EVAL_PROVIDER?.trim() || null;
const number = (name: string, fallback: number) => {
  const read = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(read) && read > 0 ? read : fallback;
};
const RUNS = Math.floor(number("EVAL_RUNS", 3));
const CONCURRENCY = Math.floor(number("EVAL_MEMORY_CONCURRENCY", 4));
const BUDGET_USD = number("EVAL_MEMORY_BUDGET_USD", 1);
const listed = (name: string, fallback: string) =>
  (process.env[name] ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
const PARTS = listed("EVAL_MEMORY_PARTS", "capture,days");
const CHOSEN_ARMS = listed("EVAL_MEMORY_ARMS", ARMS.join(",")).filter(
  (name): name is Arm => (ARMS as readonly string[]).includes(name),
);
const ONLY = listed("EVAL_ONLY", "");
const wanted = (id: string) => ONLY.length === 0 || ONLY.includes(id);

/** A reasoning model can sit before its first token; the product's own stall guard allows this. */
const REQUEST_TIMEOUT_MS = 180_000;
/** How many client-loop rounds a turn may spend, as `eval:model` allows. */
const MAX_ROUNDS = 4;

type WireTool = { name: string; description: string; parameters?: unknown };

/**
 * What a chat Bot with everything connected is handed (`./deferral.ts`), and the one tool the
 * server adds to a main conversation's turn: the projects' reader, behind the bridge. Each is the
 * catalogue's own object — the words are half of what is measured.
 */
const TOOLS: readonly WireTool[] = [...REALISTIC_TOOLSET, ...PROJECT_TOOLS];
const TOOL_NAMES = TOOLS.map((tool) => tool.name);

const factsAt = (now: Date, memories: readonly string[]) =>
  contextFactsFor({
    mode: "chat",
    now,
    timeZone: EVAL_TIME_ZONE,
    bot: EVAL_BOT,
    standingRole: EVAL_STANDING_ROLE,
    about: EVAL_ABOUT,
    memories,
    person: { timeZone: EVAL_TIME_ZONE, locale: "ko-KR" },
    // The names behind the bridge are drawn in the context layer: how a Bot knows of the search.
    toolNames: TOOL_NAMES,
    openAccounts: openAccountsIn(TOOLS),
  });

/* ------------------------------------------------------------------------------------------ */
/* One turn of the real Bot                                                                   */
/* ------------------------------------------------------------------------------------------ */

type Spent = {
  requests: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  costUsd: number;
  seconds: number;
};

type BotTurn = {
  /** What it said after the last thing it called: the answer. */
  answer: string;
  /** Everything it said, the words before a call included. */
  said: string;
  calls: ObservedCall[];
  spent: Spent;
  problem: string | null;
};

let spentUsd = 0;

const pinned: CompletionProvider = (request, options) =>
  liveProvider(
    {
      ...request,
      ...(PROVIDER
        ? { provider: { only: [PROVIDER], allow_fallbacks: false } }
        : {}),
    } as typeof request,
    options,
  );

const within = <T>(work: Promise<T>): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timed out")), REQUEST_TIMEOUT_MS),
    ),
  ]);

/**
 * One owner message answered by the real agent-bot loop, with the client's half done the way the
 * product does it: a run that ends on calls is answered and started again with what the client
 * files (`./lib.ts` `clientMessagesOf`), a lookup the service answered itself is filed as it came.
 */
async function botTurn(input: {
  threadId: string;
  messages: readonly unknown[];
  answerTo: (call: ObservedCall) => Promise<string>;
}): Promise<BotTurn> {
  const started = performance.now();
  const messages = [...input.messages];
  const all: StreamEvent[] = [];
  const spent: Spent = {
    requests: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    seconds: 0,
  };
  let problem: string | null = null;
  try {
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      const response = await runAgent(
        {
          threadId: input.threadId,
          runId: `memdays_${randomUUID().slice(0, 8)}`,
          messages,
          tools: TOOLS,
          context: [],
          state: {},
          forwardedProps: {
            // What production sends: no effort unless the deployment opted in (`./lib.ts`).
            ...(evalEffort() ? { effort: evalEffort() } : {}),
            botId: EVAL_BOT.id,
            timeZone: EVAL_TIME_ZONE,
          },
        } as never,
        pinned,
      );
      const events = eventsOfSse(await within(response.text()));
      all.push(...events);
      for (const event of events) {
        if (event.type !== "CUSTOM" || event.name !== "laf.model.usage") {
          continue;
        }
        const count = (key: string) =>
          typeof event.value?.[key] === "number"
            ? (event.value[key] as number)
            : 0;
        spent.requests += 1;
        spent.promptTokens += count("promptTokens");
        spent.cachedPromptTokens += count("cachedPromptTokens");
        spent.completionTokens += count("completionTokens");
        spent.costUsd += count("costUsd");
        spentUsd += count("costUsd");
      }
      const error = events.find((event) => event.type === "RUN_ERROR");
      if (error) {
        problem = `RUN_ERROR: ${error.message ?? "unnamed"}`;
        break;
      }
      const answered = resultsOf(events);
      const open = callsOf(events).filter((call) => !answered.has(call.id));
      if (open.length === 0) break;
      messages.push(...clientMessagesOf(events));
      for (const call of open) {
        messages.push({
          id: `t_${call.id}`,
          role: "tool",
          toolCallId: call.id,
          content: await input.answerTo(call),
        });
      }
      if (round === MAX_ROUNDS) problem = "still calling after the last round";
    }
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  if (!problem && spent.requests === 0) problem = "no usage event";
  spent.seconds = (performance.now() - started) / 1000;
  return {
    answer: answerAfterTheLastCall(all).trim(),
    said: textOf(all).trim(),
    calls: callsOf(all),
    spent,
    problem,
  };
}

/** A turn that never reached the model (a provider's limit) is asked again, twice, then recorded. */
async function botTurnPatiently(
  input: Parameters<typeof botTurn>[0],
): Promise<BotTurn> {
  let turn = await botTurn(input);
  for (let again = 1; again <= 2; again += 1) {
    if (!turn.problem || turn.spent.requests > 0) break;
    await new Promise((resolve) => setTimeout(resolve, again * 8_000));
    turn = await botTurn(input);
  }
  return turn;
}

/* ------------------------------------------------------------------------------------------ */
/* What the surface answers a call with                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * `remember`, answered as the product answers it (`server/src/agents/routes.ts` `rememberFact`,
 * `turns/chat-tools.ts`): the same floors in the same order, the same sentence back. Nothing is
 * stored — what is measured is what the Bot tried to write.
 */
function rememberCodeOf(args: Record<string, unknown> | null): string {
  if (typeof args?.place === "string" && args.place.trim()) {
    return "laf:place_saved";
  }
  const fact = typeof args?.fact === "string" ? args.fact : "";
  if (looksLikeASecret(fact)) return "laf:memory_looks_like_a_secret";
  if (looksLikeAnInstruction(fact) || looksLikeAStandingOrder(fact)) {
    return "laf:memory_looks_like_instruction";
  }
  if (!fact.trim()) return "laf:memory_empty";
  if (fact.trim().length > MAX_MEMORY_LENGTH) return "laf:memory_too_long";
  return "laf:remembered";
}

const failed = () =>
  JSON.stringify({
    ok: false,
    code: "laf:tool_failed",
    reason: toolResultText("laf:tool_failed"),
  });

/**
 * This conversation's own past, searched the way `server/src/search/conversations.ts` searches it:
 * what a person or the Bot SAID (never a tool's result), every term in the message whatever its
 * case, newest first, the production snippet. In memory, because the eval has no database — so the
 * one thing it cannot hold is a project, and every hit is `here`.
 */
function searchOver(
  thread: () => readonly StampedMessage[],
): ConversationSearch {
  return async ({ terms, cursor, limit }) => {
    if (terms.length === 0) return { hits: [], next: null };
    const size =
      typeof limit === "number" && Number.isFinite(limit)
        ? Math.min(SEARCH_PAGE, Math.max(1, Math.floor(limit)))
        : SEARCH_PAGE;
    const rows = thread()
      .map((message, seq) => ({
        message,
        seq,
        text: storedTextOf(message.content),
      }))
      .filter(
        ({ message, seq, text }) =>
          (message.role === "user" || message.role === "assistant") &&
          text.trim() !== "" &&
          terms.every((term) =>
            text.toLowerCase().includes(term.toLowerCase()),
          ) &&
          (cursor ? seq < cursor.seq : true),
      )
      .reverse();
    const page = rows.slice(0, size);
    const last = page.at(-1);
    return {
      hits: page.map(({ message, text }) => ({
        at: message.lafAt ?? new Date(0).toISOString(),
        channelId: "eval_main",
        channelName: EVAL_BOT.name,
        kind: "main",
        messageId: message.id,
        role: message.role as "user" | "assistant",
        snippet: snippetOf(text, terms),
      })),
      next:
        rows.length > size && last
          ? `${(last.message.lafAt ?? "").replace(/(\.\d{3})Z$/, "$1000Z")}~eval_main~${last.seq}`
          : null,
    };
  };
}

/**
 * AN ACCOUNT WITH NOTHING ABOUT IT IN IT. A Bot that does not find the fact sometimes goes to the
 * owner's mail, drive or calendar (measured on the first run: one morning in 324). Answered with a
 * failure, it tells the owner the connection is broken, which is not what a real account would
 * have made it say. So the three Google readers are the product's own adapters, pointed at a local
 * address that answers every request with an empty object: the "nothing found" a Bot reads is the
 * adapter's own sentence.
 */
let listening: ReturnType<typeof Bun.serve> | null = null;
/** Opened by the first call that reads it: a run that never goes there opens no port. */
const emptyAccount = () => {
  listening ??= Bun.serve({ port: 0, fetch: () => Response.json({}) });
  return {
    url: `http://127.0.0.1:${listening.port}`,
    token: "eval",
    timeZone: EVAL_TIME_ZONE,
  };
};
type Reader = (args: Record<string, unknown>, now: Date) => Promise<string>;
const EMPTY_READERS: Readonly<Record<string, Reader>> = {
  [toolNameFor("gmail/search_messages")]: async (args) =>
    (await gmailCall(emptyAccount(), "search_messages", args)).text,
  [toolNameFor("google-drive/search_files")]: async (args) =>
    (await driveCall(emptyAccount(), "search_files", args)).text,
  [toolNameFor("google-drive/list_recent_files")]: async (args) =>
    (await driveCall(emptyAccount(), "list_recent_files", args)).text,
  [toolNameFor("google-calendar/list_events")]: async (args, now) =>
    (await calendarCall(emptyAccount(), "list_events", args, () => now)).text,
};

/**
 * A recall turn's call as it is recorded beside the searches of its own past (`Lookup`): null for
 * such a search, and for the projects' other readings the name with the reading in it —
 * `mcp__projects__read(list)`. Those went looking too, somewhere else: left as the bare name they
 * were dropped from both counts and the turn read as one that looked nowhere (review of pull
 * request 183).
 */
function calledAs(call: ObservedCall): string | null {
  if (call.name !== READ_PROJECTS) return call.name;
  const kind = readingOf(call.arguments ?? {});
  return kind === "search" ? null : `${READ_PROJECTS}(${kind ?? "invalid"})`;
}

/** A call that went looking somewhere other than this conversation's own past. */
const looksElsewhere = (name: string) =>
  name.startsWith("mcp__") ||
  name === "computer_list_files" ||
  name === "computer_read_file" ||
  name === "delegate";

type Lookup = { terms: string; hits: number; text: string };

/** The surface's answers for one conversation, and what the Bot looked up along the way. */
function surfaceFor(thread: () => readonly StampedMessage[], now: () => Date) {
  const lookups: Lookup[] = [];
  const projects = createProjectTools({
    // Never read: a search goes through `search`, and the other readings are answered below.
    database: null as never,
    search: searchOver(thread),
    summaries: createProjectSummaries(),
    timeZoneOf: async () => EVAL_TIME_ZONE,
  })({ userId: "eval_owner", agentId: EVAL_BOT.id });
  const answerTo = async (call: ObservedCall): Promise<string> => {
    const args = call.arguments ?? {};
    if (call.name === REMEMBER.name)
      return toolResultText(rememberCodeOf(args));
    if (call.name === UPDATE_PROFILE.name) {
      return toolResultText("laf:profile_updated");
    }
    if (call.name === "computer_list_files") {
      return JSON.stringify({ entries: [], note: "the workspace is empty" });
    }
    if (call.name === READ_PROJECTS) {
      const kind = readingOf(args);
      // The readings that open the database, answered as a person with no project is answered.
      if (kind === "list") return JSON.stringify({ ok: true, projects: [] });
      if (kind === "summary" || kind === "ask") {
        return JSON.stringify({
          ok: false,
          code: "laf:project_not_found",
          reason: toolResultText("laf:project_not_found"),
          projects: [],
        });
      }
      const outcome = await projects.execute(call.name, args, { id: call.id });
      const found = (outcome as { hits?: unknown }).hits;
      const hits = (Array.isArray(found) ? found : []) as Array<{
        text?: unknown;
      }>;
      if (kind === "search")
        lookups.push({
          terms: typeof args.terms === "string" ? args.terms : "",
          hits: hits.length,
          text: hits.map((hit) => String(hit.text ?? "")).join("\n"),
        });
      return JSON.stringify(outcome);
    }
    const reader = EMPTY_READERS[call.name];
    if (reader) return reader(args, now());
    return failed();
  };
  return { answerTo, lookups };
}

/* ------------------------------------------------------------------------------------------ */
/* The days                                                                                   */
/* ------------------------------------------------------------------------------------------ */

const stamped = (
  id: string,
  role: "user" | "assistant",
  content: string,
  when: Date,
) => ({ id, role, content, lafAt: when.toISOString() }) as StampedMessage;

/** The page read after a day's second turn, as the `days` case files it. */
function pageStep(day: number, when: Date): StampedMessage[] {
  const callId = `call_d${day}`;
  return [
    {
      id: `d${day}c`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: callId,
          type: "function",
          function: { name: "computer_read", arguments: JSON.stringify({}) },
        },
      ],
      lafAt: when.toISOString(),
    } as never,
    {
      id: `d${day}t`,
      role: "tool",
      toolCallId: callId,
      content: orderPage(day),
      lafAt: when.toISOString(),
    } as never,
  ];
}

/**
 * Day 1 up to the owner's message that carries the thing (`beforeTheFact`): the `days` case's
 * morning, or — in the busy arm — a busy day's.
 */
function untilSaid(item: Fact | MustNot, busy = false): StampedMessage[] {
  return [
    ...beforeTheFact(item, busy).flatMap((said) => {
      const when = at(0, said.hour);
      return [
        stamped(`d0u${said.key}`, "user", said.owner, when),
        ...(said.page ? pageStep(0, when) : []),
        stamped(`d0a${said.key}`, "assistant", said.bot, when),
      ];
    }),
    stamped("d0u2", "user", item.said, at(0, HOURS[SAID_TURN] ?? 15)),
  ];
}

const forTheBot = (thread: readonly StampedMessage[]) =>
  thread.map(({ lafAt: _stamp, ...message }) => message) as never;

const storeKey = () => ({
  harness: HARNESS_VERSION,
  model: MODEL,
  effort: evalEffort() ?? "none",
  tools: "eval-memory-days",
});

/* ------------------------------------------------------------------------------------------ */
/* Capture                                                                                    */
/* ------------------------------------------------------------------------------------------ */

type CaptureRun = {
  id: string;
  run: number;
  /** Every line the Bot tried to write, and what the product's floors answered. */
  remembered: Array<{ line: string; code: string }>;
  /** What else it called, by name; `update_profile` with what it wrote. */
  others: string[];
  profile: string[];
  answer: string;
  spent: Spent;
  problem: string | null;
};

async function captureOnce(
  item: Fact | MustNot,
  run: number,
): Promise<CaptureRun> {
  const thread = untilSaid(item);
  const now = at(0, HOURS[SAID_TURN] ?? 15);
  const store = createConversationStore({ now: () => now.getTime() });
  const threadId = `thread_memdays_capture_${randomUUID().slice(0, 8)}`;
  const prepared = store.prepare({
    threadId,
    botId: EVAL_BOT.id,
    mode: "chat",
    messages: forTheBot(thread),
    key: storeKey(),
    facts: factsAt(now, EVAL_MEMORIES),
    system: (told) => systemPromptText("chat", contextLayerText(told)),
    now,
  });
  const surface = surfaceFor(
    () => thread,
    () => now,
  );
  const turn = await botTurnPatiently({
    threadId,
    messages: [
      { id: "laf-prompt:eval_bot", role: "system", content: prepared.system },
      ...prepared.messages,
    ],
    answerTo: surface.answerTo,
  });
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    id: item.id,
    run,
    remembered: turn.calls
      .filter((call) => call.name === REMEMBER.name)
      .map((call) => ({
        line:
          text(call.arguments?.fact) || `place: ${text(call.arguments?.place)}`,
        code: rememberCodeOf(call.arguments),
      })),
    others: turn.calls
      .map((call) => call.name)
      .filter((name) => name !== REMEMBER.name),
    profile: turn.calls
      .filter((call) => call.name === UPDATE_PROFILE.name)
      .map((call) => text(call.arguments?.description)),
    answer: turn.answer || turn.said,
    spent: turn.spent,
    problem: turn.problem,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* The walk: survival and recall                                                              */
/* ------------------------------------------------------------------------------------------ */

type Morning = {
  /** How many closes stand between the fact and this morning. */
  closes: number;
  epochReason: string;
  /** The summary the last close wrote, or "" where none was made. */
  summary: string;
  /** Everything the Bot is given this morning: the frozen layer and the carried messages. */
  given: string;
  answer: string;
  lookups: Lookup[];
  others: string[];
  spent: Spent;
  problem: string | null;
};

type Night = {
  day: number;
  made: boolean;
  usd: number;
  seconds: number;
  /**
   * What the close wrote, from the long walks on (absent in a report saved before them): the
   * summary the conversation carries after this night, in characters; what the summariser sent
   * back before the bound was applied; whether that was over the bound, so that the oldest-first
   * cut ran (`boundedSummary`); and whether the summary still holds the fact.
   */
  summaryChars?: number;
  rawChars?: number;
  cut?: boolean;
  kept?: Survival;
};

type Walk = {
  id: string;
  arm: Arm;
  run: number;
  /** One per night: whether the store's tick made a close, and what the server side paid. */
  nights: Night[];
  mornings: Morning[];
  problem: string | null;
};

async function walkOnce(fact: Fact, arm: Arm, run: number): Promise<Walk> {
  let clock = at(0, 9).getTime();
  let nightUsd = 0;
  const paid = (usd: number) => {
    nightUsd += usd;
    spentUsd += usd;
  };
  const apiKey = async () => KEY;
  /*
   * WHAT THE SUMMARISER SENT BACK, BEFORE THE BOUND. `createDaySummarizer` hands on its answer
   * already cut to 3,000 characters, so whether the cut ran cannot be read off what it returns. The
   * answer is read where it arrives: a reply to a request whose instructions are the summariser's.
   */
  let rawChars = 0;
  const priced = pricedFetch(paid);
  const watched = (async (
    url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const response = await priced(url, init);
    try {
      const sent =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as {
              messages?: Array<{ content?: unknown }>;
            })
          : null;
      const instructions = sent?.messages?.[0]?.content;
      if (
        typeof instructions === "string" &&
        instructions.startsWith(DAY_SUMMARY_SYSTEM.slice(0, 80))
      ) {
        const read = (await response.clone().json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const text = read.choices?.[0]?.message?.content;
        if (typeof text === "string") rawChars = text.trim().length;
      }
    } catch {
      // Not JSON: nothing to read.
    }
    return response;
  }) as typeof fetch;
  const serverCall = {
    baseUrl: BASE_URL,
    model: SERVER_MODEL,
    apiKey,
    supportsEffort: process.env.SERVER_MODEL_EFFORT !== "false",
    fetch: watched,
  };
  // The production compactor, as the `days` case builds it: Jev, the server model behind it.
  const standIn = modelAsker(serverCall, { timeoutMs: 120_000 });
  const compactor = createCompactor({
    mode: "decisions",
    // Jev where production would ask it, the server model behind it; the server model alone
    // where it would not (an endpoint that is not OpenRouter, or `JEV_ENABLED=off`).
    asker: JEV_BASE_URL
      ? withFallback(
          jevAsker(
            {
              baseUrl: JEV_BASE_URL,
              model: JEV_MODEL,
              apiKey,
              onUsage: (usage) => paid(usage.costUsd ?? 0),
            },
            { timeoutMs: 20_000, purpose: "eval-memory-days" },
          ),
          standIn,
        )
      : standIn,
    excerpts: true,
  });
  const summarize = createDaySummarizer(serverCall, { timeoutMs: 120_000 });
  const written: string[] = [];
  const thread: StampedMessage[] = [];
  const store = createConversationStore({
    now: () => clock,
    compaction: {
      thresholdTokens: 30_000,
      compact: compactor
        ? (messages) => compactor(messages)
        : async () => ({ plan: {}, arm: "latest-snapshot" }),
    },
    days: {
      summarize: async (request) => {
        const summary = await summarize(request);
        written.push(summary);
        return summary;
      },
      history: async () => thread,
      busy: async () => false,
      fallbackTimeZone: EVAL_TIME_ZONE,
    },
  });
  const threadId = `thread_memdays_${arm}_${randomUUID().slice(0, 8)}`;
  let memories: readonly string[] = EVAL_MEMORIES;
  /** The owner's message has arrived: the store's half of a request, with no model asked. */
  const arrive = () => {
    const now = new Date(clock);
    return store.prepare({
      threadId,
      botId: EVAL_BOT.id,
      mode: "chat",
      messages: forTheBot(thread),
      key: storeKey(),
      facts: factsAt(now, memories),
      system: (told) => systemPromptText("chat", contextLayerText(told)),
      now,
    });
  };

  /** A filler turn: the `days` case's own, or a busy day's. */
  const turnOf = (day: number, turn: number) =>
    arm === "passing-busy"
      ? busyTurn(day, turn)
      : { owner: DAY_TURNS[turn] ?? "", bot: answerText(day, turn) };

  const walk: Walk = {
    id: fact.id,
    arm,
    run,
    nights: [],
    mornings: [],
    problem: null,
  };
  try {
    // Day 1, up to the fact.
    const opening = untilSaid(fact, arm === "passing-busy");
    for (const message of opening) {
      thread.push(message);
      if (message.role === "user") {
        clock = new Date(message.lafAt ?? clock).getTime();
        arrive();
      }
    }
    const saidAt = new Date(clock);
    if (arm === "notebook") {
      // The Bot wrote it down: the call and its answer are in the thread, the line in 수첩.
      const callId = `call_remember_${randomUUID().slice(0, 6)}`;
      thread.push(
        {
          id: "d0r",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: callId,
              type: "function",
              function: {
                name: REMEMBER.name,
                arguments: JSON.stringify({ fact: fact.note }),
              },
            },
          ],
          lafAt: saidAt.toISOString(),
        } as never,
        {
          id: "d0rt",
          role: "tool",
          toolCallId: callId,
          content: toolResultText("laf:remembered"),
          lafAt: saidAt.toISOString(),
        } as never,
      );
      memories = [...EVAL_MEMORIES, fact.note];
    }
    thread.push(stamped("d0a2", "assistant", fact.reply, saidAt));
    clock = at(0, 19).getTime();
    const evening = turnOf(0, 3);
    thread.push(stamped("d0u3", "user", evening.owner, at(0, 19)));
    arrive();
    thread.push(stamped("d0a3", "assistant", evening.bot, at(0, 19)));

    for (let day = 1; day <= LAST_DAY; day += 1) {
      // The night: the store's own tick, at 03:00.
      clock = at(day, 3).getTime();
      nightUsd = 0;
      rawChars = 0;
      const started = performance.now();
      const made = (await store.tick()) > 0;
      const carried = written.at(-1) ?? "";
      walk.nights.push({
        day,
        made,
        usd: nightUsd,
        seconds: (performance.now() - started) / 1000,
        summaryChars: carried.length,
        rawChars: made ? rawChars : 0,
        cut: made && rawChars > SUMMARY_MAX_CHARS,
        kept: survivalIn(fact, carried),
      });
      for (let turn = 0; turn < DAY_TURNS.length; turn += 1) {
        clock = at(day, HOURS[turn] ?? 9).getTime();
        const when = new Date(clock);
        const filler = turnOf(day, turn);
        thread.push(stamped(`d${day}u${turn}`, "user", filler.owner, when));
        const prepared = arrive();
        const answer = stamped(
          `d${day}a${turn}`,
          "assistant",
          filler.bot,
          when,
        );
        if (turn === 0 && CLOSES.includes(day)) {
          /*
           * THE QUESTION, ON A COPY. Asked in the walked thread it would put the fact back into
           * the transcript for every later night. So the morning's first turn is answered as
           * scripted, the question follows it, and the store is only read (`peek`): what comes
           * back is what the conversation's own next request would carry.
           */
          const question = stamped(
            `d${day}q`,
            "user",
            fact.ask,
            new Date(clock + 5 * 60_000),
          );
          const peeked = store.peek(
            threadId,
            forTheBot([...thread, answer, question]),
          );
          const system = peeked?.system ?? prepared.system;
          const carried = peeked?.messages ?? [];
          const surface = surfaceFor(
            () => thread,
            () => new Date(clock),
          );
          const asked = await botTurnPatiently({
            threadId,
            messages: [
              { id: "laf-prompt:eval_bot", role: "system", content: system },
              ...carried,
            ],
            answerTo: surface.answerTo,
          });
          walk.mornings.push({
            closes: day,
            epochReason: prepared.epoch.reason,
            // The newest summary written: the one the morning's epoch carries.
            summary: written.at(-1) ?? "",
            given: [
              system,
              // Without the question itself, which names the thing it asks about.
              ...carried
                .filter((message) => message.id !== question.id)
                .map((message) => storedTextOf(message.content)),
            ].join("\n"),
            answer: asked.answer || asked.said,
            lookups: surface.lookups,
            others: asked.calls.flatMap((call) => {
              const name = calledAs(call);
              return name ? [name] : [];
            }),
            spent: asked.spent,
            problem: asked.problem,
          });
        }
        if (day === LAST_DAY) break;
        if (turn === 1) thread.push(...pageStep(day, when));
        thread.push(answer);
      }
    }
  } catch (error) {
    walk.problem = error instanceof Error ? error.message : String(error);
  }
  return walk;
}

/* ------------------------------------------------------------------------------------------ */
/* The tables                                                                                 */
/* ------------------------------------------------------------------------------------------ */

type Report = {
  model: string;
  provider: string | null;
  serverModel: string;
  baseUrl: string;
  harness: string;
  prompt: string;
  catalogue: string;
  ranAt: string;
  runs: number;
  /** The mornings asked on: how many closes after the fact. */
  closes: readonly number[];
  spentUsd: number;
  captures: CaptureRun[];
  walks: Walk[];
};

const pad = (text: string, width: number) => text.padEnd(width);
const factOf = (id: string) => FACTS.find((fact) => fact.id === id);

function printCapture(report: Report) {
  if (report.captures.length === 0) return;
  console.log(
    "\ncapture — said in passing, one turn (called remember · the line holds the fact whole)\n",
  );
  for (const fact of FACTS) {
    const runs = report.captures.filter(
      (row) => row.id === fact.id && !row.problem,
    );
    if (runs.length === 0) continue;
    const called = runs.filter((row) => row.remembered.length > 0);
    const kinds = runs.map((row) =>
      row.remembered.map((line) => writtenOf(fact, line.line)),
    );
    const whole = kinds.filter((row) => row.includes("whole")).length;
    const part = kinds.filter(
      (row) => !row.includes("whole") && row.includes("part"),
    ).length;
    const stale = kinds.filter((row) => row.includes("stale")).length;
    const refused = runs
      .flatMap((row) => row.remembered)
      .filter((line) => line.code !== "laf:remembered").length;
    // The fact written into the Bot's standing role instead: carried too, by another road.
    const asDuty = runs.filter((row) =>
      row.profile.some((line) => writtenOf(fact, line) === "whole"),
    ).length;
    console.log(
      `  ${pad(fact.id, 30)} remember ${outOf(called.length, runs.length)}` +
        `  whole ${outOf(whole, runs.length)}` +
        (part ? `  part ${part}` : "") +
        (stale ? `  old value written ${stale}` : "") +
        (refused ? `  refused by a floor ${refused}` : "") +
        (asDuty ? `  written into update_profile instead ${asDuty}` : ""),
    );
  }
  console.log(
    "\ncapture — what must not be written (any remember · carrying it · refused by a floor)\n",
  );
  for (const item of MUST_NOTS) {
    const runs = report.captures.filter(
      (row) => row.id === item.id && !row.problem,
    );
    if (runs.length === 0) continue;
    const lines = runs.flatMap((row) => row.remembered);
    const carrying = runs.filter((row) =>
      row.remembered.some((line) => item.carries.test(line.line)),
    ).length;
    const profile = runs.filter((row) => row.profile.length > 0).length;
    console.log(
      `  ${pad(item.id, 30)} remember ${outOf(runs.filter((row) => row.remembered.length > 0).length, runs.length)}` +
        `  carrying it ${outOf(carrying, runs.length)}` +
        `  refused ${outOf(lines.filter((line) => line.code !== "laf:remembered").length, lines.length)} lines` +
        `  update_profile ${outOf(profile, runs.length)}`,
    );
  }
  const problems = report.captures.filter((row) => row.problem);
  if (problems.length > 0) {
    console.log(
      `\n  not measured (${problems.length}): ${[...new Set(problems.map((row) => `${row.id} — ${row.problem}`))].join("; ")}`,
    );
  }
}

/** A correction whose new value is gone and whose old one is still there, on a line about it. */
const onlyTheOldValue = (fact: Fact, text: string) =>
  text
    .split("\n")
    .some(
      (line) => fact.entity.test(line) && (fact.stale?.test(line) ?? false),
    );

/** What a morning's notebook arm is given beside the summary: the line itself. */
const inNotebook = (fact: Fact, morning: Morning) =>
  morning.given.includes(fact.note);

/**
 * Night by night, where a report holds it: how long the carried summary was, how often the
 * summariser wrote past the bound (and the oldest-first cut ran), and through which night each
 * walk's summary still held the fact whole.
 */
function printNights(walks: readonly Walk[]) {
  const nights = walks.flatMap((walk) => walk.nights);
  const measured = nights.filter((night) => night.summaryChars !== undefined);
  if (measured.length === 0) return;
  const closes = measured.filter((night) => night.made);
  const over = closes.filter((night) => night.cut);
  const raws = closes.map((night) => night.rawChars ?? 0);
  console.log(
    `\n  the bound: of ${closes.length} closes the summariser wrote past ${SUMMARY_MAX_CHARS} characters on ${over.length} (the oldest-first cut ran) · longest written ${Math.max(0, ...raws)} · written at 2,700 or more ${raws.filter((chars) => chars >= 2_700).length}`,
  );
  const last = Math.max(0, ...measured.map((night) => night.day));
  const marks = [1, 3, 7, 14, 21, 30, 45, 60].filter((day) => day <= last);
  const at = (day: number) =>
    measured
      .filter((night) => night.day === day)
      .map((night) => night.summaryChars ?? 0);
  console.log(
    `  the summary carried after night: ${marks.map((day) => `${day} mean ${(meanOf(at(day)) ?? 0).toFixed(0)} max ${Math.max(0, ...at(day))}`).join(" · ")}`,
  );
  console.log(
    `  walks whose summary holds the fact whole after night: ${marks.map((day) => `${day}: ${outOf(measured.filter((night) => night.day === day && night.kept === "whole").length, at(day).length)}`).join(" · ")}`,
  );
  console.log(
    "\n  the last night each walk's summary held the fact whole (— never; ✓ through the last night)\n",
  );
  for (const fact of FACTS) {
    const mine = walks.filter((walk) => walk.id === fact.id);
    if (mine.length === 0) continue;
    const through = mine.map((walk) => {
      const held = walk.nights.filter((night) => night.kept === "whole");
      const lastHeld = Math.max(0, ...held.map((night) => night.day));
      const end = Math.max(0, ...walk.nights.map((night) => night.day));
      return lastHeld === 0 ? "—" : lastHeld === end ? "✓" : String(lastHeld);
    });
    console.log(`  ${pad(fact.id, 30)} ${through.join(" · ")}`);
  }
}

function printWalks(report: Report) {
  for (const arm of ARMS) {
    const walks = report.walks.filter((walk) => walk.arm === arm);
    if (walks.length === 0) continue;
    console.log(
      arm === "notebook"
        ? "\nsurvival — notebook (written down): the line in the frozen layer, and the fact in the summary beside it (whole)\n"
        : `\nsurvival — ${arm} (NOT written down): the fact in what the Bot is given the morning after N nights (whole · part · only the corrected-away value)\n`,
    );
    for (const fact of FACTS) {
      const mine = walks.filter((walk) => walk.id === fact.id);
      if (mine.length === 0) continue;
      const cells = CLOSES.map((closes) => {
        const mornings = mine.flatMap((walk) =>
          walk.mornings.filter((morning) => morning.closes === closes),
        );
        const state = (morning: Morning): Survival =>
          survivalIn(
            fact,
            arm === "notebook" ? morning.summary : morning.given,
          );
        const whole = mornings.filter((m) => state(m) === "whole").length;
        const part = mornings.filter((m) => state(m) === "part").length;
        const noted = mornings.filter((m) => inNotebook(fact, m)).length;
        const old = mornings.filter(
          (m) => state(m) === "gone" && onlyTheOldValue(fact, m.given),
        ).length;
        return arm === "notebook"
          ? `${closes}: 수첩 ${outOf(noted, mornings.length)} · summary ${outOf(whole, mornings.length)}`
          : `${closes}: ${outOf(whole, mornings.length)}${part ? ` (+${part} part)` : ""}${old ? ` (${old} old value)` : ""}`;
      });
      const nights = mine.flatMap((walk) => walk.nights);
      console.log(
        `  ${pad(fact.id, 30)} ${cells.join("   ")}   closes made ${outOf(nights.filter((night) => night.made).length, nights.length)}`,
      );
    }
    const sizes = (closes: number) =>
      walks
        .flatMap((walk) => walk.mornings)
        .filter((morning) => morning.closes === closes)
        .map((morning) => morning.summary.length);
    console.log(
      `\n  summary characters (bound ${SUMMARY_MAX_CHARS}): ${CLOSES.map((closes) => `after ${closes} mean ${(meanOf(sizes(closes)) ?? 0).toFixed(0)} max ${Math.max(0, ...sizes(closes))}`).join(" · ")}`,
    );
    printNights(walks);
    console.log(
      `\nrecall — ${arm}${arm === "notebook" ? " (written down)" : " (NOT written down)"}: the answer the morning after N nights (${RECALLS.join(" · ")}), lookups, mean cost of the turn\n`,
    );
    for (const fact of FACTS) {
      const mine = walks.filter((walk) => walk.id === fact.id);
      for (const closes of CLOSES) {
        const mornings = mine
          .flatMap((walk) => walk.mornings)
          .filter((morning) => morning.closes === closes && !morning.problem);
        if (mornings.length === 0) continue;
        const classes = mornings.map((morning) =>
          recallOf(fact, morning.answer),
        );
        const counts = RECALLS.map(
          (name) => classes.filter((value) => value === name).length,
        );
        const looked = mornings.filter((m) => m.lookups.length > 0);
        const found = looked.filter((m) =>
          m.lookups.some((lookup) => survivalIn(fact, lookup.text) === "whole"),
        );
        const elsewhere = mornings.filter((m) => m.others.some(looksElsewhere));
        const mean = (pick: (spent: Spent) => number, digits: number) =>
          (meanOf(mornings.map((m) => pick(m.spent))) ?? 0).toFixed(digits);
        console.log(
          `  ${pad(fact.id, 30)} after ${closes}  ${counts.join(" · ")}` +
            `   searched its past ${outOf(looked.length, mornings.length)}${looked.length ? ` (found it ${outOf(found.length, looked.length)})` : ""}` +
            ` · looked elsewhere ${outOf(elsewhere.length, mornings.length)}` +
            `   ${mean((s) => s.requests, 1)} req  ${mean((s) => s.promptTokens, 0)} tok  $${mean((s) => s.costUsd, 5)}  ${mean((s) => s.seconds, 1)}s`,
        );
      }
    }
    const lost = walks.flatMap((walk) => [
      ...(walk.problem ? [`${walk.id} run ${walk.run} — ${walk.problem}`] : []),
      ...walk.mornings
        .filter((morning) => morning.problem)
        .map((m) => `${walk.id} after ${m.closes} — ${m.problem}`),
    ]);
    if (lost.length > 0)
      console.log(`\n  not measured (${lost.length}): ${lost.join("; ")}`);
  }
  const totals = (arm: Arm) => {
    const mornings = report.walks
      .filter((walk) => walk.arm === arm)
      .flatMap((walk) =>
        walk.mornings
          .filter((morning) => !morning.problem)
          .map((morning) => ({ walk, morning })),
      );
    if (mornings.length === 0) return;
    const classes = mornings.map(({ walk, morning }) => {
      const fact = factOf(walk.id);
      return fact ? recallOf(fact, morning.answer) : ("other" as Recall);
    });
    for (const closes of CLOSES) {
      const at = mornings
        .map((row, index) => ({ row, kind: classes[index] }))
        .filter(({ row }) => row.morning.closes === closes);
      if (at.length === 0) continue;
      console.log(
        `  ${pad(arm, 12)} after ${closes}: ${RECALLS.map((name) => `${name} ${at.filter(({ kind }) => kind === name).length}`).join(" · ")}  of ${at.length}`,
      );
    }
    const looked = mornings.filter(
      ({ morning }) =>
        morning.lookups.length > 0 || morning.others.some(looksElsewhere),
    );
    // Each count on its own: a turn that did both is one of each (`lookupsOf`).
    const counts = lookupsOf(
      mornings.map(({ morning }) => ({
        ownPast: morning.lookups.length > 0,
        elsewhere: morning.others.some(looksElsewhere),
      })),
    );
    const where = new Map<string, number>();
    for (const { morning } of mornings) {
      for (const name of new Set(morning.others.filter(looksElsewhere))) {
        where.set(name, (where.get(name) ?? 0) + 1);
      }
    }
    const wrote = mornings.filter(({ morning }) =>
      morning.others.includes(REMEMBER.name),
    );
    const cost = (rows: typeof mornings) =>
      rows.length === 0
        ? "—"
        : `${(meanOf(rows.map(({ morning }) => morning.spent.requests)) ?? 0).toFixed(1)} req · ${(meanOf(rows.map(({ morning }) => morning.spent.promptTokens)) ?? 0).toFixed(0)} prompt tok · $${(meanOf(rows.map(({ morning }) => morning.spent.costUsd)) ?? 0).toFixed(5)} · ${(meanOf(rows.map(({ morning }) => morning.spent.seconds)) ?? 0).toFixed(1)}s`;
    console.log(
      `  ${pad(arm, 12)} searched its own past ${outOf(counts.ownPast, mornings.length)} · looked elsewhere ${outOf(counts.elsewhere, mornings.length)}${where.size ? ` (${[...where].map(([name, count]) => `${name} ${count}`).join(", ")})` : ""} · wrote it down when asked ${outOf(wrote.length, mornings.length)}`,
    );
    console.log(
      `  ${pad(arm, 12)} a turn that looked something up (${looked.length}): ${cost(looked)}`,
    );
    console.log(
      `  ${pad(arm, 12)} a turn that did not (${mornings.length - looked.length}): ${cost(mornings.filter((row) => !looked.includes(row)))}`,
    );
  };
  if (report.walks.length > 0) {
    console.log("\nsurvival — every fact together (whole · part · gone)\n");
    for (const arm of ARMS) {
      for (const closes of CLOSES) {
        const states = report.walks
          .filter((walk) => walk.arm === arm)
          .flatMap((walk) => {
            const fact = factOf(walk.id);
            return fact
              ? walk.mornings
                  .filter((morning) => morning.closes === closes)
                  .map((morning) =>
                    survivalIn(
                      fact,
                      arm === "notebook" ? morning.summary : morning.given,
                    ),
                  )
              : [];
          });
        if (states.length === 0) continue;
        const count = (state: Survival) =>
          states.filter((value) => value === state).length;
        console.log(
          `  ${pad(arm, 12)} after ${closes}: ${count("whole")} · ${count("part")} · ${count("gone")}  of ${states.length}${arm === "notebook" ? "  (in the summary; the line is in 수첩 on every one)" : ""}`,
        );
      }
    }
    console.log("\nrecall — every fact together\n");
    for (const arm of ARMS) totals(arm);
    const nights = report.walks.flatMap((walk) => walk.nights);
    const made = nights.filter((night) => night.made);
    console.log(
      `\n  nights: a close was made on ${outOf(made.length, nights.length)} · mean $${(meanOf(made.map((night) => night.usd)) ?? 0).toFixed(5)} · mean ${(meanOf(made.map((night) => night.seconds)) ?? 0).toFixed(1)}s`,
    );
  }
}

function print(report: Report) {
  CLOSES = report.closes ?? CLOSES;
  console.log(
    `\nmemory after days · model ${report.model} · provider ${report.provider ?? "routed"} · server model ${report.serverModel} · ${report.baseUrl}` +
      `\nran ${report.ranAt} · ${report.runs} run(s) a cell · prompt ${report.prompt} · catalogue ${report.catalogue}`,
  );
  printCapture(report);
  printWalks(report);
  console.log(
    `\nspent: $${report.spentUsd.toFixed(4)} (the Bot's requests and the closes' own calls)\n`,
  );
}

/* ------------------------------------------------------------------------------------------ */
/* The run                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** Jobs a few at a time, in order; none starts once the budget is spent. */
async function pooled<T>(jobs: Array<() => Promise<T>>): Promise<T[]> {
  const done: T[] = [];
  let next = 0;
  let skipped = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      if (!job) continue;
      if (spentUsd >= BUDGET_USD) {
        skipped += 1;
        continue;
      }
      done.push(await job());
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (skipped > 0) {
    console.log(
      `  budget of $${BUDGET_USD} reached: ${skipped} job(s) not started`,
    );
  }
  return done;
}

const saved = process.env.EVAL_MEMORY_REPORT?.trim();
if (saved) {
  print((await Bun.file(saved).json()) as Report);
  process.exit(0);
}

/*
 * THE MODEL'S CLIENT, ONLY FOR A RUN THAT ASKS A MODEL. `agent-bot/src/provider.ts` builds its
 * client when it is imported and throws without `OPENAI_API_KEY`, and `./cache-days.ts` imports
 * it. Imported at the head of this file like the rest, they made the branch above — which reads a
 * saved report and asks nobody — fail on a machine with no key, before it ran (review of pull
 * request 183). Everything that uses them is called below this line.
 */
const { runAgent } = await import("../agent-bot/src/index");
const { liveProvider } = await import("../agent-bot/src/provider");
const { at, orderPage, pricedFetch } = await import("./cache-days");

if (!KEY) {
  console.error(
    "OPENAI_API_KEY is not set. This measures a real model's turns and a real close; there is nothing to measure without one.",
  );
  process.exit(1);
}
if (!MODEL) {
  console.error(
    "BOT_MODEL is not set. What a Bot writes down and what it says days later are the model's, so there is no default: BOT_MODEL=name bun run eval:memory-days.",
  );
  process.exit(1);
}

const report: Report = {
  model: MODEL,
  provider: PROVIDER,
  serverModel: SERVER_MODEL,
  baseUrl: new URL(BASE_URL).host,
  harness: HARNESS_VERSION,
  prompt: PROMPT_HASH,
  catalogue: CATALOGUE_HASH,
  ranAt: new Date().toISOString(),
  runs: RUNS,
  closes: CLOSES,
  spentUsd: 0,
  captures: [],
  walks: [],
};
console.log(
  `\nmemory after days · model ${MODEL} · provider ${PROVIDER ?? "routed"} · server model ${SERVER_MODEL} · decisions ${JEV_BASE_URL ? JEV_MODEL : "the server model alone (no Jev here)"}` +
    `\n${TOOLS.length} tools · ${RUNS} run(s) a cell · parts ${PARTS.join(", ")} · arms ${CHOSEN_ARMS.join(", ")}\n`,
);

if (PARTS.includes("capture")) {
  const items = [...FACTS, ...MUST_NOTS].filter((item) => wanted(item.id));
  report.captures = await pooled(
    items.flatMap((item) =>
      Array.from({ length: RUNS }, (_, run) => async () => {
        const row = await captureOnce(item, run + 1);
        console.log(
          `  capture ${pad(row.id, 30)} run ${row.run}  remember ${row.remembered.length}` +
            `  ${row.spent.requests} req  $${row.spent.costUsd.toFixed(5)}` +
            (row.problem ? `  · ${row.problem}` : ""),
        );
        return row;
      }),
    ),
  );
}

if (PARTS.includes("days")) {
  const facts = FACTS.filter((fact) => wanted(fact.id));
  report.walks = await pooled(
    CHOSEN_ARMS.flatMap((arm) =>
      facts.flatMap((fact) =>
        Array.from({ length: RUNS }, (_, run) => async () => {
          const walk = await walkOnce(fact, arm, run + 1);
          console.log(
            `  walk ${pad(arm, 9)} ${pad(walk.id, 30)} run ${walk.run}` +
              `  closes ${outOf(walk.nights.filter((night) => night.made).length, walk.nights.length)}` +
              `  ${walk.mornings.map((morning) => `${morning.closes}:${recallOf(fact, morning.answer)}${morning.lookups.length ? "*" : ""}`).join(" ")}` +
              (walk.problem ? `  · ${walk.problem}` : ""),
          );
          return walk;
        }),
      ),
    ),
  );
}

report.spentUsd = spentUsd;
print(report);
mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
const reportPath = new URL(
  `./reports/memory-days-${MODEL.replace(/[^a-zA-Z0-9.-]/g, "_")}-${report.ranAt.replace(/[:.]/g, "-")}.json`,
  import.meta.url,
);
await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`report: ${reportPath.pathname}\n`);
process.exit(0);
