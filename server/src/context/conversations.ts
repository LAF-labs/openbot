/**
 * Epochs and reminders: what each Bot conversation has been told, and what changed since.
 *
 * FOLLOWING CLAUDE CODE (`~/laf/docs/agent-harness-design.md`, "Epochs"). Claude Code loads the
 * project context — CLAUDE.md, memory, the environment with the date — once, when a session
 * starts; anything that changes during the session arrives as a `<system-reminder>` appended to
 * the person's next message, and the context itself is reloaded only after `/compact` or `/clear`.
 * The reason is the prefix cache: a provider serves a prompt from its cache only as far as it is
 * byte-identical to the last one, and a system message rebuilt from the database on every request
 * — with the minute as its last line — re-billed the whole conversation behind it. Measured on a
 * week-old conversation (~39K tokens, two minutes between messages): 0% served from cache on
 * Wafer, 10% on Z.AI (agent-harness-review §4.3).
 *
 * So, per Bot conversation (one AG-UI thread):
 *
 *  - An EPOCH freezes the context layer — name, job, shop, place, home zone, today's date,
 *    memories, skills index — into the system message, once. Every request in the epoch sends it
 *    byte for byte. A new epoch starts when the conversation starts, when the model, the effort,
 *    the harness (`HARNESS_VERSION`) or the tool list changes — each of which breaks the cache at
 *    the head of the prompt anyway, so re-freezing then costs nothing — and on compaction: when a
 *    request's prompt crosses the threshold, what the conversation no longer carries is decided
 *    once behind it (`./compaction`), stored with the conversation, applied to every request
 *    after, and the next run starts a new epoch.
 *  - At the owner's local DAY BOUNDARY (`./day-close`): once the day has turned and nothing is
 *    running or waiting on the owner, the days before are summarised behind the conversation, and
 *    the owner's next message starts an epoch whose frozen layer carries today's date and that
 *    summary, with the history cut after it. The client still sends the whole thread; the cut is
 *    made here, and it goes with every later epoch until the next day's close replaces it.
 *  - A change during the epoch — a new local day, a place or zone, a rename, a memory written
 *    outside the Bot's own `remember` — is appended to the person's NEW message as `<알림>`, once,
 *    and stored with that message's id, so every later request carries the same bytes in the same
 *    place. The frozen layer picks the change up at the next epoch.
 *  - A routine run is a conversation of its own; its instruction carries a reminder with the time
 *    it was scheduled for and the time it started.
 *
 * IN MEMORY, ON PURPOSE, AND WRITTEN THROUGH. One API process per VM (docs/laf/deployment-model.md),
 * and the middleware that reads this answers synchronously — so the state lives here, is loaded
 * whole at boot (`load`), and every change to a chat conversation is written to
 * `laf_conversation_contexts` behind it. A reminder a restart forgot would be a history rewritten
 * under the cache, and the Bot would lose the dates its person's messages carried. A routine run
 * lasts minutes and is not written; it is dropped from memory a few hours after it was last used.
 *
 * It also keeps, per conversation and in memory only, what the current QUESTION has cost (the
 * dollars on the usage rows since the person last spoke), which the middleware forwards so
 * `agent-bot` can bound a question by cost as well as steps; and when the conversation last made a
 * request, which is what says whether a cache miss was a break or just a cold cache.
 */
import { randomUUID } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { PromptMode } from "../../../shared/prompt";
import {
  type ContextFacts,
  earlierSummaryText,
  knownFacts,
  REMINDER_CLOSE,
  REMINDER_OPEN,
  reminderBlock,
  reminderLines,
  routineRunLine,
  withReminder,
} from "../../../shared/prompt";
import { dayLabel } from "../../../shared/prompt/zone";
import type { Database } from "../db/client";
import { lafConversationContexts, lafThreadRuns } from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import {
  applyCompaction,
  attachmentPlan,
  attachmentsKey,
  type CompactionPlan,
  type Compactor,
  mergePlans,
  SETTLED_ATTACHMENT_CHARS,
  settledAttachments,
} from "./compaction";
import {
  afterCut,
  closePoint,
  type DayCut,
  type DaySummarizer,
  dayKey,
  dialogueOf,
  MIN_DAY_CLOSE_CHARS,
  type StampedMessage,
  transcriptOf,
} from "./day-close";
import { type SummaryScrubber, scrubByRule } from "./forget-scrub";

type AgentMessage = Parameters<AbstractAgent["run"]>[0]["messages"][number];

/** Why an epoch began. Recorded on every usage row, so a cache miss can be read against it. */
export type EpochReason =
  | "conversation_start"
  /** A conversation with history this process holds no record of: the first run under this code. */
  | "resumed"
  | "harness_changed"
  | "model_changed"
  | "effort_changed"
  | "tools_changed"
  | "mode_changed"
  /** The person had a memory forgotten: its words must stop reaching the model. */
  | "memory_forgotten"
  | "compaction"
  /** The owner's local day turned: the history before it became a summary (`./day-close`). */
  | "day_boundary";

/** What an epoch is frozen against. Any of them changing starts a new one. */
export type EpochKey = {
  harness: string;
  model: string;
  effort: string;
  tools: string;
  mode: PromptMode;
};

type Epoch = EpochKey & {
  id: string;
  reason: EpochReason;
  startedAt: string;
  /** The whole system message, frozen. */
  system: string;
  /**
   * Where the history the next request carries begins, and the summary standing for what came
   * before it. Carried from epoch to epoch until the next day's close replaces it; stored with the
   * epoch (`laf_conversation_contexts.epoch`, jsonb), so no migration and a restart keeps the cut.
   */
  cut?: DayCut;
};

type Conversation = {
  threadId: string;
  botId: string;
  /** Chat conversations are written through; a routine run lives in memory for its minutes. */
  kept: boolean;
  epoch: Epoch;
  /** What the conversation has been told: the epoch's facts, and every reminder since. */
  known: ContextFacts;
  /** A person message's id → the reminder it carries. */
  reminders: Record<string, string>;
  lastUserMessageId: string | null;
  /** A new epoch asked for from outside — compaction. Taken by the next `prepare`. */
  pending: EpochReason | null;
  /** What compaction has decided this conversation no longer carries (`./compaction`). */
  compaction: CompactionPlan;
  // ------------------------------------------------------------------ memory only
  /** The conversation as the last run carried it, before compaction: what the next one judges. */
  raw: readonly AgentMessage[] | null;
  /** A compaction is being decided. One at a time. */
  compacting: boolean;
  /**
   * The prompt size the last compaction attempt was made at. The next attempt waits until the
   * prompt has grown by a quarter of the threshold past it, whatever the last one decided — a
   * history long in TEXT (which is never dropped) would otherwise ask the judge on every request,
   * and one that found a little each time would break the cache each time (measured, 2026-09-25).
   */
  triedAtTokens: number | null;
  /** A day's close, prepared behind the conversation and waiting for the owner's next message. */
  close: DayCut | null;
  /** A close is being prepared. One at a time. */
  closing: boolean;
  /** When the last close failed, ms: the next attempt waits `CLOSE_RETRY_MS`. */
  closeFailedAt: number | null;
  /** What the last look for a close was made against; nothing changed, nothing to look at again. */
  closeCheckedKey: string | null;
  /** Said once per cut: the thread the run carried did not hold the message the cut is after. */
  cutMissingLogged: boolean;
  /** Usage rows recorded in this epoch. The first is the epoch's cold request. */
  requests: number;
  /** When this conversation last made a model request, ms. */
  lastRequestAt: number | null;
  /** The question now being answered: the person message it began with, and its dollars. */
  question: { messageId: string | null; costUsd: number };
  touchedAt: number;
};

export type PrepareInput = {
  threadId: string;
  botId: string;
  mode: PromptMode;
  /** The conversation as the run carries it, without any system message of ours. */
  messages: readonly AgentMessage[];
  key: Omit<EpochKey, "mode">;
  /** What is true now, drawn (`contextFactsFor`). */
  facts: ContextFacts;
  /** Builds the system message for a new epoch from the facts it freezes. */
  system: (facts: ContextFacts) => string;
  /** A routine run's times, as the routine forwarded them. */
  routine?: { scheduledFor: Date | null } | null;
  now: Date;
};

export type Prepared = {
  system: string;
  messages: AgentMessage[];
  epoch: { id: string; reason: EpochReason; fresh: boolean };
  /** What this question has cost so far, for `agent-bot`'s bound. */
  question: { costUsd: number };
};

/** What one usage row learns about the request it records. */
export type UsageContext = {
  epochId: string;
  epochReason: EpochReason;
  /** The first request of its epoch — cold for the context layer, whatever the provider does. */
  epochStart: boolean;
  /** Seconds since this conversation's previous request. Null for its first. */
  idleSeconds: number | null;
};

export type ConversationStore = {
  /** The system message and the messages for one run, with the epoch decided. */
  prepare(input: PrepareInput): Prepared;
  /** A usage row of `threadId`'s run: its dollars go on the question, its time on the idle clock. */
  recordUsage(
    threadId: string,
    usage: { costUsd?: number; promptTokens?: number },
    at?: Date,
  ): UsageContext | null;
  /** Start a new epoch on the conversation's next run. The compaction hook. */
  beginEpoch(threadId: string, reason: EpochReason): void;
  /**
   * Decide a compaction for the conversation now, whatever its size, and wait for it. What the
   * threshold does on its own; exposed for the eval and the tests. Resolves to whether anything new
   * was dropped (and so whether the next run starts a new epoch).
   */
  compactNow(threadId: string): Promise<boolean>;
  /**
   * Look for conversations whose day has turned and prepare their close, behind them. Called on a
   * minute's clock (`boot/background.ts`); resolves to how many closes it made.
   */
  tick(): Promise<number>;
  /**
   * Prepare the conversation's day close now, whatever the idle clock says, and wait for it. For
   * the eval and the tests. Resolves to whether a close is ready for the next person message.
   */
  closeNow(threadId: string): Promise<boolean>;
  /** The store's clock: what the middleware dates a run by. Injected in tests and the eval. */
  now(): Date;
  /**
   * The owner message a Bot is answering now, in its kept conversation: where a `remember` it makes
   * was learned (`agents/memory-evidence.ts`). Null when the Bot has no conversation this process
   * has seen a person message in. The text is the message's own words, unredacted — the caller
   * redacts what it keeps.
   */
  questionOf(
    botId: string,
  ): { threadId: string; messageId: string; text: string } | null;
  /**
   * The owner forgot these lines on 수첩: take them out of every day summary this Bot's
   * conversations carry or are about to carry, and start a new epoch on each one whose summary
   * changed. Resolves once the model's scrub has landed, or the rule's when the model cannot
   * answer; how many summary lines went, and who decided.
   */
  forget(
    botId: string,
    lines: readonly string[],
  ): Promise<{ scrubbed: number; arm: string }>;
  /** Read every kept conversation into memory. Called once, at boot, before any run. */
  load(): Promise<number>;
  /** Every write asked for so far, landed. For tests and for a clean shutdown. */
  settled(): Promise<void>;
};

/** Where kept conversations live. Absent in tests that need no database. */
export type ConversationPersistence = {
  loadAll(): Promise<
    Array<{
      threadId: string;
      agentId: string;
      epoch: unknown;
      known: unknown;
      reminders: Record<string, string>;
      lastUserMessageId: string | null;
      compaction?: Record<string, string>;
    }>
  >;
  save(conversation: {
    threadId: string;
    agentId: string;
    epoch: Epoch;
    known: ContextFacts;
    reminders: Record<string, string>;
    lastUserMessageId: string | null;
    compaction: CompactionPlan;
  }): Promise<void>;
};

/** When and how a conversation is compacted. Absent: never. */
export type CompactionSetting = {
  /** Prompt tokens at which a compaction is decided. */
  thresholdTokens: number;
  compact: Compactor;
};

/** The day's close (`./day-close`). Absent: a conversation's history is never cut by day. */
export type DayEpochSetting = {
  summarize: DaySummarizer;
  /** The thread as the store holds it, stamped (`runner/thread-store.ts messagesFor`). */
  history: (threadId: string) => Promise<readonly StampedMessage[]>;
  /**
   * Whether the Bot has anything running or waiting on its owner (package A's `waiting`). A close is
   * never prepared then: the task's messages would be cut out from under it.
   */
  busy?: (botId: string) => Promise<boolean>;
  /**
   * The lines the owner forgot on 수첩 (`ownerForgottenLines`): told to the summariser and scrubbed
   * out of what it writes, so a forgotten fact the owner once said is never summarised again.
   */
  forgotten?: (botId: string) => Promise<readonly string[]>;
  /**
   * The nightly dream (`agents/dream.ts`), run after the close's summary and before the close can be
   * taken, so what it writes is in the frozen layer of the epoch the close begins. Reads the day's
   * dialogue only. Its failure never fails the close.
   */
  dream?: (input: {
    botId: string;
    dialogue: string;
    day: string;
  }) => Promise<void>;
  /** The zone a conversation that never said its own is dated in. */
  fallbackTimeZone?: string;
  /** How long since the conversation's last request before a close may be prepared. */
  idleMs?: number;
  minChars?: number;
};

/** A close is not prepared within two minutes of a request: the turn may still be going. */
const DEFAULT_CLOSE_IDLE_MS = 2 * 60_000;
/** After a failed close (the summariser down), the next attempt waits this long. */
const CLOSE_RETRY_MS = 30 * 60_000;

/** The frozen system message, with the summary of what the cut replaced at its end. */
function withSummary(system: string, cut: DayCut | undefined): string {
  const summary = cut ? earlierSummaryText(cut.summary, cut.day) : "";
  return summary ? `${system}\n\n${summary}` : system;
}

/**
 * What a compaction must save to be taken: a floor in characters and a share of the conversation.
 * Below either, the cache miss it causes costs more than the tokens it saves.
 */
const MIN_SAVED_CHARS = 4_000;
const MIN_SAVED_SHARE = 0.1;

/** A stored plan, read back: only the two actions there are. */
function planOf(value: unknown): CompactionPlan {
  if (!value || typeof value !== "object") return {};
  const plan: CompactionPlan = {};
  for (const [id, action] of Object.entries(value as Record<string, unknown>)) {
    if (
      action === "drop_call" ||
      action === "drop_result" ||
      action === "settle_attachments"
    ) {
      plan[id] = action;
    }
  }
  return plan;
}

/** How long a routine run's conversation is held after it was last used. */
const UNKEPT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * The key in the order its changes are reported. The first difference names the epoch: the harness
 * changing usually changes the tools too, and "harness" is the truer word for that deploy.
 */
const KEY_REASONS: ReadonlyArray<[keyof EpochKey, EpochReason]> = [
  ["harness", "harness_changed"],
  ["model", "model_changed"],
  ["effort", "effort_changed"],
  ["mode", "mode_changed"],
  ["tools", "tools_changed"],
];

/** The newest person message in the run, with where it sits. */
function newestUser(
  messages: readonly AgentMessage[],
): { message: AgentMessage; at: number } | null {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (message?.role === "user") return { message, at };
  }
  return null;
}

/** The facts the Bot wrote itself through `remember` in this conversation, as it wrote them. */
function ownMemories(messages: readonly AgentMessage[]): Set<string> {
  const own = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (call.function.name !== "remember") continue;
      try {
        const args = JSON.parse(call.function.arguments || "{}") as {
          fact?: unknown;
        };
        if (typeof args.fact === "string" && args.fact.trim()) {
          own.add(args.fact);
        }
      } catch {
        // Arguments that were not JSON wrote nothing.
      }
    }
  }
  return own;
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The memories the conversation was told of that are no longer there.
 *
 * One corrected on 수첩 is not among them: its replacement is carried now, and the correction
 * reaches the Bot as a reminder (`reminderLines`) with the frozen layer left as it is until the
 * next epoch. Only a line nothing replaced has to stop reaching the model at once.
 */
function forgottenMemories(known: ContextFacts, now: ContextFacts): string[] {
  const kept = new Set(now.memories.map(flat));
  const corrected = new Set(
    Object.entries(now.superseded)
      .filter(([, replacement]) => kept.has(flat(replacement)))
      .map(([old]) => flat(old)),
  );
  /*
   * NOR ONE THE HOURLY CURATION RETIRED (`agents/memory-curation.ts`). That is the Bot's own
   * unsupported line leaving on the Bot's schedule, not the owner saying "잊어": it stops being drawn
   * at the next epoch, and breaking this conversation's cache for it now would make a background job
   * cost the owner a re-read of the whole day, every hour it found something.
   */
  const retired = new Set(now.retired.map(flat));
  return known.memories.filter(
    (memory) =>
      !kept.has(flat(memory)) &&
      !corrected.has(flat(memory)) &&
      !retired.has(flat(memory)),
  );
}

/**
 * The reminders with every line naming a forgotten memory taken out — and a heading left with
 * nothing under it, and a block left with nothing in it, with them.
 */
function scrubbed(
  reminders: Record<string, string>,
  forgotten: readonly string[],
): Record<string, string> {
  const gone = new Set(forgotten.map((memory) => `- ${flat(memory)}`));
  const out: Record<string, string> = {};
  for (const [id, block] of Object.entries(reminders)) {
    const lines = block.split("\n").filter((line) => !gone.has(flat(line)));
    const kept = lines.filter(
      (line, at) =>
        !(line.endsWith(":") && !(lines[at + 1] ?? "").startsWith("- ")),
    );
    const body = kept.filter(
      (line) => line !== REMINDER_OPEN && line !== REMINDER_CLOSE,
    );
    if (body.length > 0) out[id] = kept.join("\n");
  }
  return out;
}

/** A message's words, whatever shape its content has. */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text"
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

/** A person message with its reminder appended — to the text, or as one more text part. */
function carrying(message: AgentMessage, block: string): AgentMessage {
  if (message.role !== "user" || !block) return message;
  const content = message.content as unknown;
  if (Array.isArray(content)) {
    return {
      ...message,
      content: [...content, { type: "text", text: `\n\n${block}` }],
    } as AgentMessage;
  }
  return {
    ...message,
    content: withReminder(typeof content === "string" ? content : "", block),
  } as AgentMessage;
}

export function createConversationStore(
  options: {
    persistence?: ConversationPersistence;
    now?: () => number;
    compaction?: CompactionSetting;
    days?: DayEpochSetting;
    /** Takes what the owner forgot out of a day summary (`./forget-scrub`). Absent: the rule alone. */
    scrub?: SummaryScrubber;
  } = {},
): ConversationStore {
  const { persistence } = options;
  const scrub: SummaryScrubber =
    options.scrub ??
    (async ({ summary, forgotten }) => ({
      ...scrubByRule(summary, forgotten),
      arm: "rule",
    }));
  const setting = options.compaction;
  const days = options.days;
  const clock = options.now ?? (() => Date.now());
  const conversations = new Map<string, Conversation>();
  let sweptAt = 0;

  /**
   * Written behind the run, one write at a time per conversation: two runs a moment apart would
   * otherwise race, and the older state landing last would un-say a reminder the provider has
   * already cached. Each write is the whole state as it was when it was asked for.
   */
  const writes = new Map<string, Promise<void>>();
  const keep = (conversation: Conversation) => {
    if (!conversation.kept || !persistence) return;
    const state = {
      threadId: conversation.threadId,
      agentId: conversation.botId,
      epoch: conversation.epoch,
      known: conversation.known,
      reminders: { ...conversation.reminders },
      lastUserMessageId: conversation.lastUserMessageId,
      compaction: { ...conversation.compaction },
    };
    const previous = writes.get(state.threadId) ?? Promise.resolve();
    const next = previous
      .then(() => persistence.save(state))
      .catch((error) => {
        // The conversation goes on from memory; a restart before the next write starts it again.
        log.warn("conversation_context_unsaved", {
          reason: describeFailure(error),
        });
      })
      .finally(() => {
        if (writes.get(state.threadId) === next) writes.delete(state.threadId);
      });
    writes.set(state.threadId, next);
  };

  /** Compactions being decided, by thread. For `settled` and `compactNow`. */
  const compactions = new Map<string, Promise<boolean>>();

  /**
   * One compaction: judged on the conversation as the last run carried it, with what was already
   * decided applied; added to the plan; and, when it dropped anything new, a new epoch on the next
   * run. A compactor that throws decides nothing — the conversation goes on as it was.
   */
  const compactConversation = (
    conversation: Conversation,
    promptTokens: number | null,
  ): Promise<boolean> => {
    const compact = setting?.compact;
    const raw = conversation.raw;
    if (!compact || !raw || conversation.compacting) {
      return Promise.resolve(false);
    }
    conversation.compacting = true;
    const started = Date.now();
    const view = applyCompaction(raw, conversation.compaction);
    const work = compact(view)
      .then(({ plan: decided, arm }) => {
        // Old attachments go with whichever rule decided the rest (`attachmentPlan`).
        const plan = { ...decided, ...attachmentPlan(view) };
        const fresh = Object.entries(plan).filter(
          ([id, action]) => conversation.compaction[id] !== action,
        );
        const merged = mergePlans(conversation.compaction, plan);
        const before = JSON.stringify(view).length;
        /*
         * An attachment is a small reference here and a photo or a file's text on the wire, so what
         * settling one saves is counted at its weight, not at the reference's length.
         */
        const settled =
          settledAttachments(raw, merged) -
          settledAttachments(raw, conversation.compaction);
        const saved =
          before -
          JSON.stringify(applyCompaction(raw, merged)).length +
          settled * SETTLED_ATTACHMENT_CHARS;
        /*
         * WORTH A MISS, OR NOT TAKEN. Applying a plan breaks the prefix from the first message it
         * touches, so a plan that saves a click's `{ok:true}` costs the whole conversation behind it
         * for nothing. Measured on the real stack (2026-09-25): Jev dropping one small result per
         * request re-billed the history each time.
         */
        const worth =
          saved >= Math.max(MIN_SAVED_CHARS, before * MIN_SAVED_SHARE);
        // Counts and the rule that decided. Never a message, never a result.
        log.info("conversation_compacted", {
          bot: conversation.botId,
          arm,
          dropped: fresh.length,
          savedChars: saved,
          taken: fresh.length > 0 && worth,
          promptTokens,
          ms: Date.now() - started,
        });
        conversation.triedAtTokens = promptTokens;
        if (fresh.length === 0 || !worth) return false;
        conversation.compaction = merged;
        conversation.pending = "compaction";
        keep(conversation);
        return true;
      })
      .catch((error: unknown) => {
        conversation.triedAtTokens = promptTokens;
        log.warn("conversation_compaction_failed", {
          bot: conversation.botId,
          reason: describeFailure(error),
        });
        return false;
      })
      .finally(() => {
        conversation.compacting = false;
        if (compactions.get(conversation.threadId) === work) {
          compactions.delete(conversation.threadId);
        }
      });
    compactions.set(conversation.threadId, work);
    return work;
  };

  const sweep = (now: number) => {
    if (now - sweptAt < 60_000) return;
    sweptAt = now;
    for (const [id, conversation] of conversations) {
      if (!conversation.kept && now - conversation.touchedAt > UNKEPT_TTL_MS) {
        conversations.delete(id);
      }
    }
  };

  /**
   * A new epoch's frozen layer. The cut goes with it — the one it replaces, or the day's close it
   * takes — so no epoch ever carries again what a close already summarised.
   */
  const freeze = (
    input: PrepareInput,
    reason: EpochReason,
    cut?: DayCut,
  ): Pick<Conversation, "epoch" | "known"> => ({
    epoch: {
      ...input.key,
      mode: input.mode,
      id: randomUUID(),
      reason,
      startedAt: input.now.toISOString(),
      system: withSummary(input.system(input.facts), cut),
      ...(cut ? { cut } : {}),
    },
    known: input.facts,
  });

  /** The per-conversation state that lives in memory only, fresh. */
  const unkept = () => ({
    pending: null,
    raw: null,
    compacting: false,
    triedAtTokens: null,
    close: null,
    closing: false,
    closeFailedAt: null,
    closeCheckedKey: null,
    cutMissingLogged: false,
    requests: 0,
    lastRequestAt: null,
  });

  /**
   * One day's close: the span from the current cut to the last message before today, through the
   * existing compaction, then summarised with what the last close said. Stored in memory for the
   * owner's next message to take; a failure leaves the conversation exactly as it was.
   */
  const closeConversation = async (
    conversation: Conversation,
    options: { force: boolean },
  ): Promise<boolean> => {
    if (!days || conversation.closing) return false;
    const now = clock();
    const zone =
      conversation.known.timeZone || days.fallbackTimeZone || "Asia/Seoul";
    const today = dayLabel(new Date(now), zone);
    const key = `${dayKey(today)}|${conversation.lastUserMessageId}|${conversation.epoch.cut?.through ?? ""}`;
    if (!options.force && conversation.closeCheckedKey === key) return false;
    conversation.closing = true;
    const started = Date.now();
    try {
      /*
       * NEVER MID-TASK. A run going on, or a step waiting on the owner's answer, would have its own
       * messages cut out from under it by the time it carries on. Asked again on the next tick.
       */
      if (days.busy && (await days.busy(conversation.botId))) return false;
      const stored = await days.history(conversation.threadId);
      conversation.closeCheckedKey = key;
      const point = closePoint(stored, {
        today,
        timeZone: zone,
        after: conversation.epoch.cut?.through ?? null,
      });
      if (!point) return conversation.close !== null;
      if (conversation.close?.through === point.through) return true;
      const chars = JSON.stringify(point.span).length;
      if (chars < (days.minChars ?? MIN_DAY_CLOSE_CHARS)) return false;
      /*
       * THE EXISTING COMPACTION FIRST (`./compaction`: Jev, the server model behind it, the rule
       * below both), so what the summariser reads has lost the page reads nobody needs and kept the
       * ones Jev judged still matter — with the same redacted excerpts.
       */
      let span: readonly StampedMessage[] = point.span;
      let arm = "none";
      if (setting?.compact) {
        try {
          const decided = await setting.compact(span);
          span = applyCompaction(span, decided.plan) as StampedMessage[];
          arm = decided.arm;
        } catch {
          arm = "failed";
        }
      }
      const transcript = transcriptOf(span, zone);
      const forgotten = days.forgotten
        ? await days.forgotten(conversation.botId)
        : [];
      const written = await days.summarize({
        previous: conversation.epoch.cut?.summary ?? null,
        transcript,
        day: today,
        forgotten,
      });
      /*
       * TOLD, AND CHECKED. The owner's message saying a fact they later forgot is in the transcript
       * the summariser read, and a model told not to write something sometimes writes it anyway.
       */
      const summary =
        forgotten.length > 0
          ? (await scrub({ summary: written, forgotten })).summary
          : written;
      /*
       * THE DREAM, BEFORE THE CLOSE CAN BE TAKEN, so the standing guidance it writes is in the frozen
       * layer of the epoch this close begins — never a change in the middle of one. The dialogue
       * only: a page's words are no source of how the owner likes to work.
       */
      if (days.dream) {
        try {
          await days.dream({
            botId: conversation.botId,
            dialogue: dialogueOf(transcriptOf(point.span, zone)),
            day: today,
          });
        } catch (error) {
          log.warn("dream_failed", {
            bot: conversation.botId,
            reason: describeFailure(error),
          });
        }
      }
      conversation.close = { through: point.through, summary, day: today };
      conversation.closeFailedAt = null;
      // Counts only. Never a message, never the summary.
      log.info("day_closed", {
        bot: conversation.botId,
        messages: point.span.length,
        spanChars: chars,
        transcriptChars: transcript.length,
        summaryChars: summary.length,
        arm,
        ms: Date.now() - started,
      });
      return true;
    } catch (error) {
      conversation.closeFailedAt = now;
      log.warn("day_close_failed", {
        bot: conversation.botId,
        reason: describeFailure(error),
      });
      return false;
    } finally {
      conversation.closing = false;
    }
  };

  /** Closes being prepared, by thread. For `settled`. */
  const closes = new Map<string, Promise<boolean>>();
  const startClose = (conversation: Conversation, force: boolean) => {
    const running = closes.get(conversation.threadId);
    if (running) return running;
    const work = closeConversation(conversation, { force }).finally(() => {
      if (closes.get(conversation.threadId) === work) {
        closes.delete(conversation.threadId);
      }
    });
    closes.set(conversation.threadId, work);
    return work;
  };

  return {
    prepare(input) {
      const now = clock();
      sweep(now);
      const newest = newestUser(input.messages);
      let conversation = conversations.get(input.threadId);
      let fresh = false;
      let changed = false;

      if (!conversation) {
        const reason: EpochReason = input.messages.some(
          (message) => message.role === "assistant",
        )
          ? "resumed"
          : "conversation_start";
        conversation = {
          threadId: input.threadId,
          botId: input.botId,
          kept: input.mode === "chat",
          ...freeze(input, reason),
          reminders: {},
          lastUserMessageId: null,
          compaction: {},
          ...unkept(),
          question: { messageId: null, costUsd: 0 },
          touchedAt: now,
        };
        conversations.set(input.threadId, conversation);
        fresh = true;
        changed = true;
      } else {
        const key: EpochKey = { ...input.key, mode: input.mode };
        /*
         * A FORGOTTEN MEMORY IS A NEW EPOCH, not a reminder. "잊어" has to mean the words stop
         * reaching the model (docs/laf/data-lifecycle.md: a memory is kept until the person says
         * to forget it), and a frozen layer — or an earlier reminder — would go on sending them
         * with every request until the next epoch. So the layer is drawn again without it, and
         * the reminders that carried it lose that line. It costs one cache miss, on a request
         * that is rare and that the person asked for.
         */
        const forgotten = forgottenMemories(conversation.known, input.facts);
        /*
         * THE DAY'S CLOSE IS TAKEN BY A PERSON'S NEW MESSAGE, and only by one: never by the next
         * step of a task, which is still working on the history the close would cut. And only on
         * the day it was made for or later, and only when the thread still holds where it cuts.
         */
        const close = conversation.close;
        const takeClose =
          close !== null &&
          newest !== null &&
          newest.message.id !== conversation.lastUserMessageId &&
          dayKey(input.facts.day) >= dayKey(close.day) &&
          input.messages.some((message) => message.id === close.through);
        const moved =
          conversation.pending ??
          KEY_REASONS.find(
            ([field]) => conversation?.epoch[field] !== key[field],
          )?.[1] ??
          (forgotten.length > 0 ? "memory_forgotten" : null) ??
          (takeClose ? "day_boundary" : null);
        if (moved) {
          const cut = takeClose && close ? close : conversation.epoch.cut;
          Object.assign(conversation, freeze(input, moved, cut), {
            pending: null,
            requests: 0,
          });
          if (takeClose) {
            /*
             * What the cut took is no longer sent, so nothing about it is kept: the reminders its
             * person messages carried and the compaction decisions about its calls.
             */
            const carried = new Set(
              afterCut(input.messages, cut).carried.map(
                (message) => message.id,
              ),
            );
            conversation.reminders = Object.fromEntries(
              Object.entries(conversation.reminders).filter(([id]) =>
                carried.has(id),
              ),
            );
            const calls = new Set<string>();
            for (const message of input.messages) {
              if (!carried.has(message.id)) continue;
              calls.add(attachmentsKey(message.id));
              const id = (message as { toolCallId?: string }).toolCallId;
              if (id) calls.add(id);
              for (const call of (
                message as { toolCalls?: Array<{ id: string }> }
              ).toolCalls ?? []) {
                calls.add(call.id);
              }
            }
            conversation.compaction = Object.fromEntries(
              Object.entries(conversation.compaction).filter(([id]) =>
                calls.has(id),
              ),
            );
            conversation.close = null;
            conversation.cutMissingLogged = false;
            conversation.triedAtTokens = null;
          }
          if (forgotten.length > 0) {
            conversation.reminders = scrubbed(
              conversation.reminders,
              forgotten,
            );
          }
          fresh = true;
          changed = true;
        }
      }
      conversation.touchedAt = now;

      /*
       * A PERSON MESSAGE THIS CONVERSATION HAS NOT SEEN is the one place a reminder may go. A
       * continuation — the next step of a browsing task, a retry — carries the same newest message
       * and adds nothing; an older message never gains one after the fact, because that would
       * change bytes the provider already cached.
       */
      if (newest && newest.message.id !== conversation.lastUserMessageId) {
        const lines = fresh
          ? []
          : reminderLines(
              conversation.known,
              input.facts,
              ownMemories(input.messages),
            );
        if (input.mode === "routine" && input.routine) {
          lines.push(
            routineRunLine({
              startedAt: input.now,
              scheduledFor: input.routine.scheduledFor,
              timeZone: input.facts.timeZone,
            }),
          );
        }
        const block = reminderBlock(lines);
        if (block) conversation.reminders[newest.message.id] = block;
        // Told now: the next message is compared against this, not against the frozen layer.
        conversation.known = input.facts;
        conversation.lastUserMessageId = newest.message.id;
        conversation.question = { messageId: newest.message.id, costUsd: 0 };
        changed = true;
      }

      if (changed) keep(conversation);

      /*
       * COMPACTED, BY WHAT WAS DECIDED — never by what is true now. The plan names tool calls; every
       * message it does not name goes through as the very object the run carried, so the history
       * behind the new epoch's head is the provider's cached prefix from the next request on.
       */
      /*
       * CUT AT THE DAY'S CLOSE, then compacted. Everything before the cut is in the frozen layer's
       * summary; the client still sends the whole thread and the transcript stays whole — the cut
       * is made here, at the seam. A thread that no longer holds the message the cut is after (an
       * edited or restored conversation) is carried whole: longer, never missing anything.
       */
      const { carried: current, found } = afterCut(
        input.messages,
        conversation.epoch.cut,
      );
      if (!found && !conversation.cutMissingLogged) {
        conversation.cutMissingLogged = true;
        log.warn("day_cut_not_found", { bot: conversation.botId });
      }
      conversation.raw = current;
      const carried = applyCompaction(current, conversation.compaction);
      const reminders = conversation.reminders;
      return {
        system: conversation.epoch.system,
        messages: carried.map((message) =>
          message.role === "user" && reminders[message.id]
            ? carrying(message, reminders[message.id] ?? "")
            : message,
        ),
        epoch: {
          id: conversation.epoch.id,
          reason: conversation.epoch.reason,
          fresh,
        },
        question: { costUsd: conversation.question.costUsd },
      };
    },

    recordUsage(threadId, usage, at = new Date(clock())) {
      const conversation = conversations.get(threadId);
      if (!conversation) return null;
      const now = at.getTime();
      const idle =
        conversation.lastRequestAt === null
          ? null
          : Math.max(0, Math.round((now - conversation.lastRequestAt) / 1000));
      const context: UsageContext = {
        epochId: conversation.epoch.id,
        epochReason: conversation.epoch.reason,
        epochStart: conversation.requests === 0,
        idleSeconds: idle,
      };
      conversation.requests += 1;
      conversation.lastRequestAt = now;
      conversation.touchedAt = now;
      if (typeof usage.costUsd === "number" && usage.costUsd > 0) {
        conversation.question.costUsd += usage.costUsd;
      }
      /*
       * AT THE THRESHOLD, AND ONLY THERE. The request that crossed it has already been answered; the
       * decision is made behind it and lands on a later run as a new epoch — never per request, and
       * never on the request that is waiting.
       */
      const prompt = usage.promptTokens ?? 0;
      if (
        setting &&
        prompt >= setting.thresholdTokens &&
        (conversation.triedAtTokens === null ||
          prompt >= conversation.triedAtTokens + setting.thresholdTokens / 4) &&
        !conversation.compacting
      ) {
        void compactConversation(conversation, prompt);
      }
      return context;
    },

    async settled() {
      await Promise.all([
        ...writes.values(),
        ...compactions.values(),
        ...closes.values(),
      ]);
    },

    beginEpoch(threadId, reason) {
      const conversation = conversations.get(threadId);
      if (conversation) conversation.pending = reason;
    },

    async tick() {
      if (!days) return 0;
      const now = clock();
      const idle = days.idleMs ?? DEFAULT_CLOSE_IDLE_MS;
      const work: Array<Promise<boolean>> = [];
      for (const conversation of conversations.values()) {
        if (!conversation.kept || conversation.closing) continue;
        if (conversation.compacting) continue;
        if (
          conversation.lastRequestAt !== null &&
          now - conversation.lastRequestAt < idle
        ) {
          continue;
        }
        if (
          conversation.closeFailedAt !== null &&
          now - conversation.closeFailedAt < CLOSE_RETRY_MS
        ) {
          continue;
        }
        const zone =
          conversation.known.timeZone || days.fallbackTimeZone || "Asia/Seoul";
        const today = dayKey(dayLabel(new Date(now), zone));
        // Closed today already: the rest of the day is today's, and waits for tomorrow.
        if (
          conversation.epoch.cut &&
          dayKey(conversation.epoch.cut.day) >= today
        ) {
          continue;
        }
        work.push(startClose(conversation, false));
      }
      const made = await Promise.all(work);
      return made.filter(Boolean).length;
    },

    async closeNow(threadId) {
      const conversation = conversations.get(threadId);
      if (!conversation) return false;
      const running = closes.get(threadId);
      if (running) await running;
      return startClose(conversation, true);
    },

    now() {
      return new Date(clock());
    },

    questionOf(botId) {
      let found: Conversation | null = null;
      for (const conversation of conversations.values()) {
        if (!conversation.kept || conversation.botId !== botId) continue;
        if (!conversation.lastUserMessageId) continue;
        if (!found || conversation.touchedAt > found.touchedAt) {
          found = conversation;
        }
      }
      if (!found?.lastUserMessageId) return null;
      const message = (found.raw ?? []).find(
        (one) => one.id === found?.lastUserMessageId,
      );
      return {
        threadId: found.threadId,
        messageId: found.lastUserMessageId,
        text: message ? textOfContent(message.content) : "",
      };
    },

    async forget(botId, lines) {
      const facts = lines.map((line) => line.trim()).filter(Boolean);
      let scrubbed = 0;
      let arm = "rule";
      if (facts.length === 0) return { scrubbed, arm };
      for (const conversation of conversations.values()) {
        if (conversation.botId !== botId) continue;
        // A close being prepared read the old summary; scrub what it wrote, not what it read.
        const running = closes.get(conversation.threadId);
        if (running) await running;
        /*
         * The cut the conversation carries, with a new summary: a new epoch, and the frozen text
         * rewritten too — `pending` lives in memory, and a restart before the next message must not
         * bring back a layer that still says it.
         */
        const replaceCut = (summary: string) => {
          const cut = conversation.epoch.cut;
          if (!cut) return;
          const before = withSummary("", cut).trim();
          const clean = { ...cut, summary };
          conversation.epoch = {
            ...conversation.epoch,
            cut: clean,
            system: before
              ? conversation.epoch.system.replace(
                  before,
                  withSummary("", clean).trim(),
                )
              : conversation.epoch.system,
          };
          conversation.pending = "memory_forgotten";
          keep(conversation);
        };
        /*
         * THE RULE FIRST, AT ONCE: `prepare` answers synchronously and may run before the model's
         * scrub lands, and a message sent then must already be without the fact's own words. Then
         * the model's, over what the rule left, for what the rule cannot see.
         */
        const cut = conversation.epoch.cut;
        if (cut) {
          const ruled = scrubByRule(cut.summary, facts);
          if (ruled.removed > 0) {
            scrubbed += ruled.removed;
            replaceCut(ruled.summary);
          }
        }
        const close = conversation.close;
        if (close) {
          const ruled = scrubByRule(close.summary, facts);
          if (ruled.removed > 0) {
            scrubbed += ruled.removed;
            conversation.close = { ...close, summary: ruled.summary };
          }
        }
        const carried = conversation.epoch.cut;
        if (carried) {
          const judged = await scrub({
            summary: carried.summary,
            forgotten: facts,
          });
          arm = judged.arm;
          if (judged.removed > 0 && conversation.epoch.cut === carried) {
            scrubbed += judged.removed;
            replaceCut(judged.summary);
          }
        }
        const waiting = conversation.close;
        if (waiting) {
          const judged = await scrub({
            summary: waiting.summary,
            forgotten: facts,
          });
          arm = judged.arm;
          if (judged.removed > 0 && conversation.close === waiting) {
            scrubbed += judged.removed;
            conversation.close = { ...waiting, summary: judged.summary };
          }
        }
      }
      // Counts only. Never the lines, never the summary.
      log.info("memory_forgotten_scrubbed", {
        bot: botId,
        lines: facts.length,
        scrubbed,
        arm,
      });
      return { scrubbed, arm };
    },

    async compactNow(threadId) {
      const conversation = conversations.get(threadId);
      if (!conversation) return false;
      const running = compactions.get(threadId);
      if (running) await running;
      return compactConversation(conversation, null);
    },

    async load() {
      if (!persistence) return 0;
      const rows = await persistence.loadAll();
      for (const row of rows) {
        const epoch = row.epoch as Epoch;
        if (!epoch || typeof epoch.system !== "string") continue;
        conversations.set(row.threadId, {
          threadId: row.threadId,
          botId: row.agentId,
          kept: true,
          epoch,
          known: knownFacts(row.known),
          reminders: row.reminders ?? {},
          lastUserMessageId: row.lastUserMessageId,
          compaction: planOf(row.compaction),
          ...unkept(),
          question: { messageId: row.lastUserMessageId, costUsd: 0 },
          touchedAt: clock(),
        });
      }
      return rows.length;
    },
  };
}

/** The kept conversations, in Postgres. */
export function conversationPersistence(
  database: Database,
): ConversationPersistence {
  return {
    async loadAll() {
      return database
        .select({
          threadId: lafConversationContexts.threadId,
          agentId: lafConversationContexts.agentId,
          epoch: lafConversationContexts.epoch,
          known: lafConversationContexts.known,
          reminders: lafConversationContexts.reminders,
          lastUserMessageId: lafConversationContexts.lastUserMessageId,
          compaction: lafConversationContexts.compaction,
        })
        .from(lafConversationContexts);
    },
    async save(conversation) {
      await database
        .insert(lafConversationContexts)
        .values({ ...conversation, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: lafConversationContexts.threadId,
          set: {
            epoch: conversation.epoch,
            known: conversation.known,
            reminders: conversation.reminders,
            lastUserMessageId: conversation.lastUserMessageId,
            compaction: conversation.compaction,
            updatedAt: sql`now()`,
          },
        });
    },
  };
}

/**
 * How long a `running` or `waiting` run is believed. A step can wait on its owner's answer for a
 * long time (package A: work survives the window), but a row a crash left behind is reconciled only
 * at the next boot, and a day's close must not wait on it forever.
 */
const BUSY_STALE_MS = 12 * 60 * 60_000;

/** Whether a Bot has a run going on or a step waiting on its owner, from the run ledger. */
export function botBusyReader(database: Database) {
  return async (botId: string): Promise<boolean> => {
    const rows = await database
      .select({ runId: lafThreadRuns.runId })
      .from(lafThreadRuns)
      .where(
        and(
          eq(lafThreadRuns.agentId, botId),
          inArray(lafThreadRuns.status, ["running", "waiting"]),
          gt(lafThreadRuns.startedAt, new Date(Date.now() - BUSY_STALE_MS)),
        ),
      )
      .limit(1);
    return rows.length > 0;
  };
}
