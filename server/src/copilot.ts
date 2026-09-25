import { createHash } from "node:crypto";
import { AbstractAgent, HttpAgent } from "@ag-ui/client";
import type { AgentRunner } from "@copilotkit/runtime/v2";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotHonoHandler } from "@copilotkit/runtime/v2/hono";
import { textOf } from "../../shared/message-content";
import {
  type ComposePromptInput,
  composePrompt,
  contextFactsFor,
  contextLayerText,
  DEFAULT_TIME_ZONE,
  notepadLayerText,
  notepadOf,
  type PromptMode,
  type PromptPerson,
  type PromptSkill,
  promptModeOf,
  type RoutineNote,
  systemPromptText,
} from "../../shared/prompt";
import { HARNESS_VERSION } from "../../shared/prompt/harness";
import type { ShopProfile } from "../../shared/shop/catalogue";
import { isDeferredToolName } from "../../shared/tools/bridge";
import { deviceOf } from "../../shared/whereabouts";
import type { AgentActor, AgentEffort } from "./agents/profile-types";
import { type AuditStore, auditRowLost, recordAuditEvent } from "./audit";
import type { AgentFetch, StallGuard } from "./channels/stall-guard";
import type { ResultSpill } from "./computer/spillover";
import type { ConversationStore } from "./context/conversations";
import { log } from "./log";
import { type DailyBudget, withDailyBudget } from "./usage/daily-budget";
import {
  CACHE_LOW_SHARE,
  CACHE_WARM_SECONDS,
  CACHE_WATCH_MIN_PROMPT,
  cacheReadOf,
  modelUsageOf,
} from "./usage/model-usage";

/**
 * The CopilotKit runtime, in the one mode this product has.
 *
 * Every Bot is reached over AG-UI as an `HttpAgent`, so anything that speaks the protocol is a Bot
 * with no framework adapter here: LangGraph, Pydantic-AI, CrewAI, Mastra, ADK, or a hand-written
 * server. This deployment's own `agent-bot` is one of those endpoints and nothing more.
 *
 * THE SECOND BRANCH IS GONE. CopilotKit's `BuiltInAgent` — the Responses API, a package's own
 * system prompt, `forceReasoning` — was unreachable: the package ships `agents: []`, and after
 * migration 0024 released the packaged Bots there is no `built_in` row anywhere to construct one
 * from. It carried a whole second way for a Bot's prompt and effort to reach a model, which is the
 * shape that hides a setting going nowhere. Git has it.
 *
 * Upstream had no SSE branch: Intelligence owned durable threads, and a deployment without it
 * silently forgot every conversation. This fork runs the SSE branch on a runner that does not
 * forget — LafPostgresRunner keeps every thread in our own Postgres — and there is no second
 * branch to choose between.
 */

type RegisteredRemoteAgent = {
  id: string;
  name: string;
  type: "remote_ag_ui";
  endpoint: string;
  /**
   * Who this Bot is, as the prompt composer needs it — read fresh per request.
   *
   * What the Bot is TOLD is decided per conversation, not per load: the context layer is frozen
   * when an epoch starts and what changed since arrives as a reminder (`context/conversations.ts`).
   * The profile here is what is true now, which the store compares against what was told.
   */
  profile: AgentStandingProfile;
  /**
   * How hard it thinks, sent to the endpoint on every run.
   *
   * REMOTE IS NOT THE EXOTIC CASE, IT IS EVERY CASE. Only the Bots a package shipped are
   * `built_in`; every Bot anybody creates is `remote_ag_ui`, pointed at this deployment's own
   * `agent-bot`. A setting wired into the built-in configuration alone therefore reaches nothing
   * anybody will ever make — which is what shipped, and was mistaken for working because the Bot it
   * was tried on answered perfectly well with the setting going nowhere at all.
   */
  effort: AgentEffort;
  /** The key this agent sits behind, resolved from the vault at load time. Never logged. */
  headers?: Record<string, string>;
};

/**
 * A coworker the caller may see but may not run: its profile was deleted while a channel it worked
 * in still exists. It is registered so the runtime can restore that thread and the person can read
 * what was said; every run is refused here, without contacting the endpoint.
 */
type RegisteredUnavailableAgent = {
  id: string;
  name: string;
  type: "unavailable";
  reason: string;
};

export type RegisteredAgent =
  | RegisteredRemoteAgent
  | RegisteredUnavailableAgent;

type AgentRunInput = Parameters<AbstractAgent["run"]>[0];
type AgentMessage = AgentRunInput["messages"][number];
export type StandingRoleMessage = Extract<AgentMessage, { role: "system" }>;

/**
 * The durable part of a Bot: who it is and what it has been asked to keep doing.
 *
 * No `title` since 2026-09-24: a Bot's profile is its name and its face, and a column nobody can see
 * or edit must not tell the Bot what it is (shared/prompt/index.ts, `PromptBot`).
 */
export type AgentStandingProfile = {
  id: string;
  name: string;
  roleDescription: string;
  /**
   * What this Bot has learned about the person it is answering, oldest first.
   *
   * On the profile rather than in `forwardedProps` for the same reason the job is: the endpoint on
   * the other side may be LangGraph, Mastra or a hand-written server, and a system message is the
   * only thing all of them already understand.
   */
  memories?: readonly string[];
  /**
   * The skills this Bot holds, by name and one line, so the prompt can list them.
   *
   * Attached by `agents/granted-skills.ts` on the way out of the loader, not read here: the
   * middleware below is synchronous, and a Bot's grants are the plugin store's question.
   */
  skills?: readonly PromptSkill[];
  /**
   * What kind of business the person asking runs, and where they work every day.
   *
   * The person's, not the Bot's, so every Bot in their roster carries the same one. Attached by
   * `agents/shop-context.ts` from what the person answered — never taken from a run's
   * `forwardedProps`, which on a chat run are whatever the browser sent. Composed below into the
   * one system message, like the job and the memories, and for the same reason: it is the only
   * thing every endpoint understands.
   */
  shop?: ShopProfile;
  /**
   * The person's clock and place as they were last kept (`agents/person-context.ts`): the zone and
   * language their device last reported, the place they set or said. A chat run's own device
   * overrides the clock in the middleware below; a routine, which has no device, reads these.
   */
  person?: PromptPerson;
};

/*
 * The wall clock a Bot is told about is `config.botTimeZone` — `BOT_TIME_ZONE`, parsed once in
 * `config.ts` and handed to every function below that takes a `timeZone`. It was read from the
 * environment here, as a default parameter, by four functions at four different moments. The
 * defaults that remain are Seoul, for the tests that build agents without a deployment.
 */

/** The message id every composed prompt carries, so a replayed thread cannot accumulate copies. */
export function promptMessageId(agentId: string): string {
  return `laf-prompt:${agentId}`;
}

/**
 * Threads written before the prompt moved here still hold the old English standing-role message.
 *
 * Filtered out by id on the way past rather than migrated: a snapshot is a record of what was said,
 * and rewriting history to make today's prompt look like it was always there is a worse lie than
 * one stale system message the model never sees.
 */
function isSupersededPrompt(id: unknown, agentId: string): boolean {
  return id === promptMessageId(agentId) || id === `standing-role:${agentId}`;
}

/**
 * Everything the Bot reads before the first word of the conversation, as one system message.
 *
 * An ordinary AG-UI system message rather than `forwardedProps` or framework-specific state,
 * because the endpoint on the other side may be LangGraph, Mastra, ADK or a hand-written server
 * and a system message is the only thing all of them already understand.
 *
 * IT IS THE WHOLE PROMPT. `agent-bot` used to prepend a system prompt of its own — upstream's
 * English original — and this message was the second one after it. Two authors for one prompt is
 * how a rule gets contradicted by a rule nobody remembered writing, so the service now sends
 * nothing of its own and this is all there is.
 */
export function botPromptMessage(
  profile: AgentStandingProfile,
  options: {
    mode: PromptMode;
    now: Date;
    timeZone: string;
    /** A routine's notepad, as the run forwarded it. The composer draws it in routine mode only. */
    notepad?: readonly RoutineNote[];
    /** The person as this run knows them: the profile's, with the device's clock over it. */
    person?: PromptPerson;
  },
): StandingRoleMessage {
  return {
    id: promptMessageId(profile.id),
    role: "system",
    content: composePrompt(composeInputOf(profile, options)),
  };
}

/** What the composer is given for this profile and this run. */
function composeInputOf(
  profile: AgentStandingProfile,
  options: {
    mode: PromptMode;
    now: Date;
    timeZone: string;
    notepad?: readonly RoutineNote[];
    person?: PromptPerson;
    /** Every tool the run was handed; the deferred ones are named in the context layer. */
    toolNames?: readonly string[];
  },
): ComposePromptInput {
  return {
    ...(options.toolNames ? { toolNames: options.toolNames } : {}),
    mode: options.mode,
    now: options.now,
    timeZone: options.timeZone,
    bot: { id: profile.id, name: profile.name },
    standingRole: profile.roleDescription,
    ...(profile.shop ? { shop: profile.shop } : {}),
    ...(profile.memories ? { memories: profile.memories } : {}),
    ...(profile.skills ? { skills: profile.skills } : {}),
    ...(options.notepad?.length ? { notepad: options.notepad } : {}),
    ...((options.person ?? profile.person)
      ? { person: options.person ?? profile.person }
      : {}),
  };
}

/**
 * The tool list the MODEL is offered, as a fingerprint: by name, so the order the surface
 * registered in does not count — `agent-bot` sorts before sending (`deferral.ts`). A list that
 * changes is a different head of the prompt, so it is a new epoch.
 *
 * ONLY THE CORE TOOLS COUNT. What sits behind the bridge — a connected service's tools, the cards
 * a Bot is allowed — is not on the list the model is sent (`shared/tools/bridge.ts`); it is named
 * in the context layer and a change to it arrives as a reminder. Counting it here would open a new
 * epoch, and re-bill the conversation, every time a person connected a service.
 */
export function toolsFingerprint(
  tools:
    | ReadonlyArray<{
        name: string;
        description?: string;
        parameters?: unknown;
      }>
    | undefined,
): string {
  const sorted = [...(tools ?? [])]
    .filter((tool) => !isDeferredToolName(tool.name))
    .map((tool) => [tool.name, tool.description ?? "", tool.parameters ?? null])
    .sort(([a], [b]) =>
      String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
    );
  return createHash("sha256")
    .update(JSON.stringify(sorted), "utf8")
    .digest("hex")
    .slice(0, 12);
}

/**
 * A routine run's times, as `runner/unattended.ts` forwards them. Null for anything that is not a
 * routine's — a chat run carries none, and a value that is not the shape is none.
 */
function routineRunOf(
  forwarded: Record<string, unknown>,
): { scheduledFor: Date | null } | null {
  const routine = forwarded.routine;
  if (!routine || typeof routine !== "object") return null;
  const at = (routine as Record<string, unknown>).scheduledFor;
  const scheduled = typeof at === "string" ? new Date(at) : null;
  return {
    scheduledFor:
      scheduled && !Number.isNaN(scheduled.getTime()) ? scheduled : null,
  };
}

export type RuntimeModel = {
  provider: "openai";
  defaultModel: string;
  /**
   * Whether this deployment's model takes an effort setting.
   *
   * False sends nothing, whatever a Bot's own setting says. A model that does not reason answers a
   * request carrying the parameter with a 400 on some providers and silence on others, and the one
   * thing this must not do is turn a Bot that works into a Bot that errors because somebody moved a
   * slider. The surface reads the same flag and hides the control, so nobody is offered a choice
   * that does nothing.
   */
  supportsEffort: boolean;
};

type RuntimeAgentRow = {
  id: string;
  name: string;
  type: "built_in" | "remote_ag_ui";
  configuration: unknown;
  roleDescription: string;
  /** Absent on a row read by something that does not select it; `balanced` is the column's default. */
  effort?: AgentEffort;
  /**
   * What this Bot has learned about the person the row was read for.
   *
   * Absent on a row read outside a person's request — a registry listing has no "the person" to
   * scope memories to, and a Bot carrying somebody else's is the one failure this must not have.
   */
  memories?: readonly string[];
};

export function registeredAgentFromRow(
  row: RuntimeAgentRow,
): RegisteredAgent | null {
  if (!isPlainObject(row.configuration)) {
    return null;
  }
  /*
   * A `built_in` row resolves to nothing.
   *
   * The enum value stays — old audit rows and old snapshots name it — but nothing constructs one:
   * migration 0024 released the packaged Bots as ordinary remote ones and the package ships
   * `agents: []`. Answering null rather than throwing keeps one stray row from taking a person's
   * whole roster down with it; `resolveRuntimeAgents` still refuses a roster that resolves to
   * nothing at all, which is the case worth failing on.
   */
  if (row.type === "built_in") return null;

  const endpoint = row.configuration?.endpoint;
  return typeof endpoint === "string" && isHttpUrl(endpoint)
    ? {
        id: row.id,
        name: row.name,
        type: "remote_ag_ui",
        endpoint,
        profile: {
          id: row.id,
          name: row.name,
          roleDescription: row.roleDescription,
          ...(row.memories ? { memories: row.memories } : {}),
        },
        effort: row.effort ?? "balanced",
      }
    : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * What every run is metered by and judged against, at the seam they all share.
 *
 * Both halves are about the same number — a day's tokens — and both have to reach chat, a room's
 * turn, a routine and one Bot asking another alike, which is why they ride here rather than on any
 * one of those paths.
 */
export type RunMeter = {
  /**
   * Where each turn's `model.usage` row is written: one per usage event the Bot's stream reports.
   * Absent writes nothing, which is what a test that builds agents alone wants.
   */
  auditStore?: AuditStore;
  /**
   * A free trial's day, judged before each run leaves (`usage/daily-budget.ts`). Absent — every
   * deployment that is not a trial — nothing is judged and nothing is asked.
   */
  dailyBudget?: DailyBudget;
  /**
   * What each conversation has been told: its epoch, its reminders, what its question has cost
   * (`context/conversations.ts`). Here because it is metering as much as prompting — the usage
   * rows are what it counts a question's dollars and a cache's warmth from. Absent, every run is
   * an epoch of its own: the prompt is composed fresh and nothing is appended, which is what a
   * test that builds agents alone wants.
   */
  conversations?: ConversationStore;
};

/**
 * Build the AG-UI agent map the runtime serves.
 *
 * Keyed by the registry id, which is what the browser sends as the agent name, so the two cannot
 * drift apart without the lookup failing loudly rather than silently running the wrong Bot.
 */
export function buildAgents(
  agents: RegisteredAgent[],
  model: RuntimeModel,
  /** Absent leaves every stream unwatched, which is what an unconfigured timeout means. */
  stallGuard?: StallGuard,
  /** The clock a Bot is told about: `config.botTimeZone`, read from the environment once, at boot. */
  timeZone: string = DEFAULT_TIME_ZONE,
  /** Files long tool results on the Bot's computer. Absent — no computer — forwards them whole. */
  spill?: ResultSpill,
  /** The trail each run's cost lands on, and a trial's day. See {@link RunMeter}. */
  meter?: RunMeter,
): Record<string, AbstractAgent> {
  return Object.fromEntries(
    agents.map((agent) => [
      agent.id,
      buildAgent(agent, model, stallGuard, timeZone, spill, meter),
    ]),
  );
}

function buildAgent(
  agent: RegisteredAgent,
  model: RuntimeModel,
  stallGuard: StallGuard | undefined,
  timeZone: string,
  spill: ResultSpill | undefined,
  meter: RunMeter | undefined,
): AbstractAgent {
  if (agent.type === "unavailable") {
    return new UnavailableAgent(agent);
  }
  return remoteAgentWithPrompt(agent, model.supportsEffort, {
    model: model.defaultModel,
    timeZone,
    ...(stallGuard ? { stallGuard } : {}),
    ...(spill ? { spill } : {}),
    ...(meter ? { meter } : {}),
  });
}

type ToolResultMessage = Extract<AgentMessage, { role: "tool" }>;

/**
 * A tool result as the endpoint is shown it: whole, or the head of it and where the whole is.
 *
 * Here, in the one middleware every run path goes through, rather than in `agent-bot`: the server
 * is the process that has the computer, the Bot's id and no credential to mint, and a room turn
 * or a routine step resends its results through exactly this seam. See computer/spillover.ts for
 * why the run that received a result still gets all of it.
 */
function filedToolResult(
  message: ToolResultMessage,
  botId: string,
  spill: ResultSpill,
): ToolResultMessage {
  const text = textOf(message.content);
  const shown = spill.forModel(botId, message.toolCallId, text);
  return shown === text ? message : { ...message, content: shown };
}

/**
 * A remote AG-UI agent that composes its whole prompt on every run.
 *
 * THIS IS THE ONE SEAM. Chat, rooms, routines and one Bot asking another all resolve their agents
 * through here, so this middleware is the only place that has to know what a Bot is told — and the
 * only place that has to be changed when that changes. Standard AG-UI middleware rather than a
 * request transformation on one provider's client, so the same Bot works against any endpoint that
 * speaks the protocol.
 *
 * WHAT THE BOT IS TOLD IS DECIDED PER CONVERSATION (`context/conversations.ts`). The system message
 * is the epoch's, frozen when the conversation started or last changed model, effort, harness or
 * tools; what changed since is appended to the person's new message as a reminder. So every
 * request in an epoch leads with the same bytes and the provider serves the history behind them
 * from its cache. Without the store (a test building agents alone) each run is an epoch of its
 * own. Any copy already in the conversation — this run's id, or the old `standing-role:` message
 * a thread was saved with before the prompt moved — is dropped: the endpoint receives exactly
 * one, first, however many times the thread has been replayed.
 *
 * The stall watch goes on the fetch rather than into this middleware, because the middleware works
 * in AG-UI events and a stall is the absence of one. The thing that has to be watched is the
 * response body, and the fetch is where this deployment still holds it.
 *
 * A TRIAL'S DAY IS JUDGED ON THE FETCH TOO, around the watch, for a different reason: the judgement
 * reads the database, and a middleware answers synchronously with an Observable — building one here
 * would take `rxjs`, which this workspace does not depend on. The fetch is already asynchronous, it
 * is called once per run, and it is where the stall guard already ends a run with one RUN_ERROR. A
 * refused run never reaches the endpoint (`usage/daily-budget.ts`).
 *
 * WHAT A RUN COST IS WRITTEN HERE, by a subscriber on the agent. Subscribers ride along when the
 * runtime copies an agent to run it (`AbstractAgent.clone`) and every path calls `runAgent`, so this
 * sees a chat turn, a room's, a routine's and a coworker's alike — which the runner the chat endpoint
 * drives, where the row used to be written, never could.
 */
function remoteAgentWithPrompt(
  agent: RegisteredRemoteAgent,
  /** Whether this deployment's model takes an effort setting. See `RuntimeModel.supportsEffort`. */
  supportsEffort: boolean,
  options: {
    /** The deployment's model, by name: part of what an epoch is frozen against. */
    model: string;
    timeZone: string;
    stallGuard?: StallGuard;
    spill?: ResultSpill;
    meter?: RunMeter;
  },
) {
  const { timeZone, stallGuard, spill, meter } = options;
  const conversations = meter?.conversations;
  const watched = stallGuard?.watch({ id: agent.id, name: agent.name });
  const reach: AgentFetch | undefined = meter?.dailyBudget
    ? withDailyBudget(
        meter.dailyBudget,
        watched ?? ((url, requestInit) => fetch(url, requestInit)),
      )
    : watched;
  const remote = new HttpAgent({
    url: agent.endpoint,
    agentId: agent.id,
    // The customer's own key, if their agent sits behind one. `HttpAgentConfig` is
    // `{ url, headers?, fetch? }`, verified against @ag-ui/client 0.0.57.
    ...(agent.headers ? { headers: agent.headers } : {}),
    ...(reach ? { fetch: reach } : {}),
  });
  const auditStore = meter?.auditStore;
  if (auditStore || conversations) {
    remote.subscribe({
      /*
       * Written and not awaited: a subscriber is awaited between events, so a slow insert here would
       * be a slow answer on somebody's screen, and metering must never be able to break the turn it
       * measures. Counts only — the payload is what the runner's row always carried.
       */
      onCustomEvent: ({ event, input }) => {
        for (const usage of modelUsageOf([event])) {
          /*
           * TREAT THE CACHE HIT RATE LIKE UPTIME (Claude Code's words). Each row says which epoch
           * it belongs to and why that epoch began, so a miss can be read against its cause; and a
           * warm request in an established epoch that read under half its prompt from the cache
           * is a break in the prefix — something rewrote bytes the provider had — and is said so
           * in the log. Counts and ids only; nothing a person wrote.
           */
          const context = conversations?.recordUsage(input.threadId, usage);
          const share = cacheReadOf(usage);
          const cacheLow =
            context !== undefined &&
            context !== null &&
            !context.epochStart &&
            context.idleSeconds !== null &&
            context.idleSeconds <= CACHE_WARM_SECONDS &&
            usage.promptTokens >= CACHE_WATCH_MIN_PROMPT &&
            share !== null &&
            share < CACHE_LOW_SHARE;
          if (cacheLow) {
            log.warn("cache_hit_low", {
              bot: agent.id,
              run: input.runId,
              epoch: context.epochId,
              provider: usage.provider ?? null,
              promptTokens: usage.promptTokens,
              cachedPromptTokens: usage.cachedPromptTokens ?? 0,
              idleSeconds: context.idleSeconds,
            });
          }
          if (!auditStore) continue;
          void recordAuditEvent(auditStore, {
            eventType: "model.usage",
            targetType: "agent",
            targetId: agent.id,
            payload: {
              runId: input.runId,
              threadId: input.threadId,
              botId: agent.id,
              ...usage,
              ...(context
                ? {
                    epochId: context.epochId,
                    epochReason: context.epochReason,
                    epochStart: context.epochStart,
                    ...(context.idleSeconds === null
                      ? {}
                      : { idleSeconds: context.idleSeconds }),
                  }
                : {}),
              ...(cacheLow ? { cacheLow: true } : {}),
              source: "bot-turn",
            },
          }).catch(auditRowLost("model.usage"));
        }
      },
    });
  }
  remote.use((input, next) => {
    const forwarded =
      typeof input.forwardedProps === "object" && input.forwardedProps !== null
        ? (input.forwardedProps as Record<string, unknown>)
        : {};
    // What the run says it is. Chat says nothing, and silence is a chat.
    const mode = promptModeOf(forwarded);
    const now = new Date();
    const composing = composeInputOf(agent.profile, {
      mode,
      now,
      timeZone,
      /*
       * Where a routine left off. Parsed to its shape and its bounds here whoever forwarded it —
       * this seam cannot tell a routine's run from a browser's — and drawn for a routine only.
       */
      notepad: notepadOf(forwarded),
      /*
       * WHOSE CLOCK. The device a chat run was sent from says its zone and language on the run
       * (`forwardedProps.device`, from the app's `Intl`), and that is what "오늘" and "지금 몇 시야"
       * are asking about — not this VM's clock and not the deployment's. It goes over what the
       * person's last session kept, which is all a routine has. A zone this runtime does not know
       * was dropped by `deviceOf`, so a bad value falls back rather than throwing mid-run.
       *
       * The place is never taken from the run: it is the person's, kept on the account and changed
       * through their own session (`account/whereabouts.ts`), like the shop.
       */
      person: { ...agent.profile.person, ...deviceOf(forwarded) },
      toolNames: (input.tools ?? []).map((tool) => tool.name),
    });
    const facts = contextFactsFor(composing);
    const notepad = notepadLayerText(mode, composing.notepad);
    const frozen = (told: typeof facts) =>
      systemPromptText(mode, contextLayerText(told, notepad));
    const history = input.messages
      .filter((message) => !isSupersededPrompt(message.id, agent.id))
      .map((message) =>
        spill && message.role === "tool"
          ? filedToolResult(message, agent.id, spill)
          : message,
      );
    const prepared = conversations?.prepare({
      threadId: input.threadId,
      botId: agent.id,
      mode,
      messages: history,
      key: {
        harness: HARNESS_VERSION,
        model: options.model,
        effort: supportsEffort ? agent.effort : "none",
        tools: toolsFingerprint(input.tools),
      },
      facts,
      system: frozen,
      routine: routineRunOf(forwarded),
      now,
    });
    const prompt: StandingRoleMessage = {
      id: promptMessageId(agent.id),
      role: "system",
      content: prepared?.system ?? frozen(facts),
    };
    return next.run({
      ...input,
      messages: [prompt, ...(prepared?.messages ?? history)],
      /*
       * WHAT THE ENDPOINT IS TOLD ABOUT THIS RUN, beside the conversation.
       *
       * `botId` because `agent-bot` had no way to know which Bot it was answering — the Bot's whole
       * identity arrived as a system message, which a log line cannot be written from. Every other
       * service in this deployment names the Bot in its logs and that one could not.
       *
       * `effort` on the run rather than in a configuration: a remote Bot's model is answered by the
       * endpoint, not here, so the setting has to travel — and this middleware is the one place
       * every run path goes through, so chat, rooms and routines all carry it without any of them
       * knowing. OUR WORD, NOT THE PROVIDER'S: `thorough`, not `high`, because each end translates
       * its own spelling and adding a third API is then one file. Omitted entirely, not defaulted,
       * where the deployment's model takes no effort setting.
       *
       * `timeZone` is the person's, resolved — what the `now` tool reads the clock in, since the
       * minute is no longer in the prompt. `question` is what this question has cost in dollars
       * so far, from the usage rows the store counted; `agent-bot` bounds a question by it and by
       * its steps (`guards.ts`). `epoch` names the epoch, for that service's log.
       *
       * Merged over whatever the caller forwarded rather than replacing it.
       */
      forwardedProps: {
        ...forwarded,
        botId: agent.id,
        ...(supportsEffort ? { effort: agent.effort } : {}),
        timeZone: facts.timeZone,
        ...(prepared
          ? {
              question: { costUsd: prepared.question.costUsd },
              epoch: { id: prepared.epoch.id, reason: prepared.epoch.reason },
            }
          : {}),
      },
    });
  });
  return remote;
}

class UnavailableAgent extends AbstractAgent {
  private readonly reason: string;

  constructor(agent: RegisteredUnavailableAgent) {
    super({ agentId: agent.id, description: agent.name });
    this.reason = agent.reason;
  }

  // Refused here rather than at the endpoint: a deleted coworker has no endpoint worth contacting,
  // and the person is owed the reason rather than a transport error.
  run(): never {
    throw new Error(this.reason);
  }
}

/**
 * No model credential is resolved here any more.
 *
 * It was only ever needed by the built-in branch, which held the key itself and called the provider
 * from this process. Every Bot is an AG-UI endpoint now and the key lives where the call is made —
 * `agent-bot`'s own environment, and `askModel` for auto-review and write-ups, which still resolve
 * it from the vault.
 */
export async function resolveRuntimeAgents(
  loadAgents: () => Promise<RegisteredAgent[]>,
  model: RuntimeModel,
  stallGuard?: StallGuard,
  timeZone: string = DEFAULT_TIME_ZONE,
  spill?: ResultSpill,
  meter?: RunMeter,
): Promise<Record<string, AbstractAgent>> {
  const registered = await loadAgents();
  /*
   * AN EMPTY ROSTER IS A CORRECT STATE. This used to throw "No agents are registered", which was
   * true when every deployment shipped built-in Bots and an empty roster meant a broken package.
   * Deployments ship none now: every account is legitimately empty for its first minute, and again
   * the moment somebody deletes their last Bot — and the throw turned the first screen of the
   * product into a 500 on `/info` plus a 404 on the chat endpoint (measured on a cold first run).
   * A run against a Bot that does not exist still fails where it always did, by name.
   */
  if (registered.length === 0) return {};
  return buildAgents(registered, model, stallGuard, timeZone, spill, meter);
}

/** Who is asking. A Bot is its owner's alone, so a run has to know whose turn it is first. */
export type IdentifyActor = (request: Request) => Promise<AgentActor>;

/** Loads exactly the agents one person may see, already carrying their standing roles. */
export type LoadAgentsForActor = (
  actor: AgentActor,
) => Promise<RegisteredAgent[]>;

/**
 * Build the runtime's per-request agent factory.
 *
 * Resolution is per request, not per boot, because who may run a coworker is a property of the
 * person asking: a private coworker must be absent for everybody else, and a role edited a moment
 * ago must apply to the next run without a restart. Both fall out of rebuilding the map here.
 */
export function createRequestAgents(
  identifyActor: IdentifyActor,
  loadAgents: LoadAgentsForActor,
  model: RuntimeModel,
  /**
   * Shared across every request rather than built per run, because it is the thing that has to
   * outlive one: the sweep that notices a silent stream has to still be running after the request
   * that opened it has been answered.
   */
  stallGuard?: StallGuard,
  timeZone: string = DEFAULT_TIME_ZONE,
  spill?: ResultSpill,
  meter?: RunMeter,
) {
  return async ({ request }: { request: Request }) => {
    const actor = await identifyActor(request);
    return resolveRuntimeAgents(
      () => loadAgents(actor),
      model,
      stallGuard,
      timeZone,
      spill,
      meter,
    );
  };
}

/**
 * Mount the CopilotKit endpoint onto the host Hono app.
 *
 * `agents` is a factory rather than a fixed map so a Bot registered while the server is running is
 * reachable on the next request. Resolving once at boot would mean every new Bot needed a restart,
 * which is not a property you can explain to somebody who just created one.
 */
export function mountCopilotRuntime(
  model: RuntimeModel,
  loadAgents: LoadAgentsForActor,
  identifyActor: IdentifyActor,
  /**
   * The watch on Bot streams. Not optional, unlike the parameter it forwards to: a guard built from
   * a timeout of zero already watches nothing, so an unconfigured deployment has one to hand and
   * there is no reason for a caller to have to say `undefined` here to reach `basePath`.
   */
  stallGuard: StallGuard,
  /** The durable runner every turn goes through. */
  localRunner: AgentRunner,
  /** The clock every Bot is told about: `config.botTimeZone`. */
  timeZone: string,
  basePath = "/api/copilotkit",
  /** Files long tool results on the Bot's computer. See computer/spillover.ts. */
  spill?: ResultSpill,
  /** The trail each run's cost lands on, and a trial's day. The same one every other path is given. */
  meter?: RunMeter,
) {
  const agents = createRequestAgents(
    identifyActor,
    loadAgents,
    model,
    stallGuard,
    timeZone,
    spill,
    meter,
  );

  const runtime = new CopilotRuntime({
    runner: localRunner,
    agents: agents as never,
  });
  return createCopilotHonoHandler({ runtime, basePath });
}
