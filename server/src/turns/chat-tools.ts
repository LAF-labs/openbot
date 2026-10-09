/**
 * A chat turn's tools, carried out on the server.
 *
 * Every one of these used to be a frontend tool: CopilotKit handed the model the tool, the model
 * asked for it, the run ended, and the person's window carried the call out and started the next
 * run with the result. That is why a long task needed a window. A turn the server owns
 * (`engine.ts`) carries the same calls out here, through the same gateway, plugin store, profile
 * store and routine service the window's requests reached — the policy, the grants, the audit rows
 * and the approval registry are all underneath those — and answers the model with the same object
 * or sentence the window's handler answered it with. A Bot must not be able to tell which side ran
 * its call.
 *
 * WHERE A PERSON IS NEEDED, THE SERVER WAITS. A question the boundary raises is held here until
 * somebody answers it from any window (`people.ts`); a request for help waits for 다 했어요 or
 * 건너뛰기; a decision card waits for its choice. Closing the laptop does not end the wait — the
 * question's own ten minutes do.
 *
 * WHICH TOOLS: the ones the window declared when it sent the message, as the window always decided
 * them — the gallery's schemas exist only in the page — cut to the names this file can actually
 * carry out, so the model is never offered a call nothing here would run.
 */
import type { Tool } from "@ag-ui/client";
import { askOutcome, PERSON_WAIT_MS } from "../../../shared/person-wait";
import { secretFieldsOf } from "../../../shared/secret-ask";
import { isPersona } from "../../../shared/persona";
import {
  noteCodesOf,
  routineListResult,
  routineSavedText,
  routineUpdatedText,
  TOOL_RESULT_KO,
  toolResultText,
} from "../../../shared/prompt/tool-results.ko";
import { CORE_TOOL_NAMES, serverKeyOf } from "../../../shared/tools/bridge";
import { COMPUTER_TOOLS, computerTool } from "../../../shared/tools/computer";
import {
  type ComputerOutcome,
  computerReplyOutcome,
  navigationOutcome,
} from "../../../shared/tools/computer-reply";
import {
  type AccountState,
  accountStatesIn,
  CARD_NOT_ASKED,
  CONNECT_CARD,
  connectionAnswer,
  FILE_CARD,
  GALLERY_CONFIRMATIONS,
  GALLERY_DECISIONS,
  galleryReads,
  isAskable,
  ON_SCREEN,
  withAccountStates,
} from "../../../shared/tools/gallery";
import { isGoalToolName } from "../../../shared/tools/goals";
import {
  PAUSED_TOOL_DESCRIPTION,
  type WithheldTools,
} from "../../../shared/tools/paused";
import {
  MANAGE_ROUTINE,
  REMEMBER,
  UPDATE_PROFILE,
} from "../../../shared/tools/self";
import { normalizeSkillName, SKILL_VIEW } from "../../../shared/tools/skills";
import {
  TOOL_NOT_ALLOWED,
  toolErrorText,
} from "../../../shared/tools/step-result";
import type { ShopStore } from "../account/shop";
import { placeAnswerOf, type WhereaboutsStore } from "../account/whereabouts";
import type { AgentMemoryStore } from "../agents/memory-store";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor } from "../agents/profile-types";
import { editProfile, rememberFact } from "../agents/routes";
import {
  type AuditStore,
  FUNCTION_NOT_GRANTED,
  recordAuditEvent,
} from "../audit";
import { DEV_ACTOR } from "../auth/dev-actor";
import type { ComponentStore } from "../components/store";
import type { ApprovalRegistry } from "../computer/approvals";
import { STALE_REFS } from "../computer/client";
import {
  type ActionActor,
  ActionNeedsApprovalError,
  ActionRefusedError,
  type ComputerGateway,
} from "../computer/gateway";
import { codeFor, isBadRequest, statusFor } from "../computer/routes";
import { BOTS_OWN_LOOK, readFileInputOf } from "../computer/schema";
import { snapshotForModel } from "../computer/snapshot-lines";
import { describeFailure } from "../failure-text";
import type { GoalStore } from "../goals/store";
import { goalApprovals, goalTools } from "../goals/tools";
import { log } from "../log";
import { McpServerError } from "../plugins/mcp";
import type { ConnectionSwitch } from "../plugins/overview-routes";
import { TOOL_SERVER_FAILED } from "../plugins/routes";
import { TIMEOUT_MS } from "../plugins/timeouts";
import {
  BotNotDrivableError,
  CatalogueEntryUnknownError,
  PluginNeedsApprovalError,
  PluginRefusedError,
  type PluginStore,
} from "../plugins/store";
import { RoutineError } from "../routines/errors";
import type { RoutineSchedule } from "../routines/schedule";
import type { RoutineService } from "../routines/service";
import type { LoopExecutor, LoopOutcome } from "../runner/turn-loop";
import { awaitApproval, type PersonAnswers } from "./people";

export type ChatToolsDeps = {
  /** Absent when no computer is configured; its tools are then not offered. */
  gateway?: ComputerGateway;
  /**
   * `offeredToModel`, never `listForAgent`: this list is read by a model, and the other one holds a
   * vendor's unreviewed words for a tool that waits for review (`OfferedPlugins`, `store.ts`).
   */
  pluginStore?: Pick<PluginStore, "offeredToModel" | "callTool" | "viewSkill">;
  approvals?: Pick<ApprovalRegistry, "hold" | "withdraw">;
  people: PersonAnswers;
  agents?: AgentProfileStore;
  memories?: AgentMemoryStore;
  /** Whether this deployment may talk to its own network. See `createAgentRoutes`. */
  allowPrivateHosts?: boolean;
  routines?: Pick<
    RoutineService,
    "create" | "list" | "update" | "remove" | "setEnabled"
  >;
  whereabouts?: Pick<WhereaboutsStore, "savePlace">;
  components?: Pick<ComponentStore, "listForAgent" | "decide" | "mayCall">;
  /**
   * Where a person's answer to a persona question is written: the same store `PUT /api/me/persona`
   * writes through. Reached only with what a person pressed (`component`, below), never with
   * anything the Bot's call carried.
   */
  persona?: Pick<ShopStore, "savePersona">;
  /**
   * 목표 (`goals/tools.ts`): the four tools behind the bridge, offered in every chat turn whatever the
   * window declared — the window has no schemas for them. `save_goal` needs a yes this turn collected.
   */
  goals?: Pick<
    GoalStore,
    "active" | "find" | "create" | "update" | "log" | "linkRoutine"
  >;
  auditStore?: AuditStore;
  /**
   * What 연결 can switch for a person, and whether each is on (`plugins/overview-routes.ts`). A
   * connect card's wait is answered from this — the screen's own reading — and never from what a
   * window said: the one way that boundary lies is a Bot saying "연결됐어요" about a switch that is
   * off. Absent without a plugin store, and a connect card then draws nothing and waits for nothing.
   */
  connections?: (userId: string) => Promise<ConnectionSwitch[]>;
  /**
   * This person's accounts — every one this deployment can connect, with whether it is on
   * (`readAccountStates`, `plugins/overview-routes.ts`; one query). Written on the connect card a
   * turn hands on: see the turn's tool list below. Absent, the card goes on as the window
   * declared it and a lookup says nothing about connecting.
   */
  accounts?: (userId: string) => Promise<readonly AccountState[]>;
  /** How often a waiting connect card looks at 연결 for itself. */
  connectionPollMs?: number;
  /**
   * How long a connection that has just landed is given for its tools to arrive before it is said
   * to have brought none: as long as a listing may take (`TIMEOUT_MS.mcpList`) by default.
   */
  listingWaitMs?: number;
  /** How long a person may take to answer a help request. The window's own ten minutes by default. */
  personWaitMs?: number;
  /** How often a help request looks at whether it has been answered. */
  controlPollMs?: number;
};

/** Whose turn it is and where: what every call is carried out as. */
export type ChatTurnContext = {
  botId: string;
  owner: AgentActor;
  threadId: string;
  /** The turn's run: who holds a question it raises. */
  runId: string;
  /**
   * Wait for a person without holding the Bot (`engine.ts`): the Bot's lane is let go of for the
   * wait and taken back before the call goes on, and `moved` says whether anything else drove the
   * Bot in between — a routine may have moved the shared browser. Absent, the wait simply runs.
   */
  awaitPerson?: <T>(
    wait: () => Promise<T>,
  ) => Promise<{ value: T; moved: boolean }>;
};

export type ChatToolkit = {
  tools: Tool[];
  execute: LoopExecutor;
  /**
   * What this Bot holds and the list above cannot show: tools waiting for review that are offered
   * under no name, counted per server (`OfferedPlugins.withheld`). The turn forwards it beside the
   * list (`engine.ts`), and the context layer says it (`copilot.ts`). Read when the person's
   * message arrives, like the list — a reconnect in the middle of a turn shows from the next
   * message on.
   */
  withheld?: WithheldTools;
};

const CONTROL_POLL_MS = 1_000;
/**
 * How often a waiting connect card reads 연결. A consent takes a person tens of seconds, and the
 * read is four small queries, so three seconds is a few hundred of them at the very most.
 */
const CONNECTION_POLL_MS = 3_000;

/** One outcome, carrying the fact and the sentence the model reads for it. */
function refusal(code: string, extra: Record<string, unknown> = {}) {
  return { ok: false as const, code, reason: toolResultText(code), ...extra };
}

/** What a Bot's own tools hand back to the model: the sentence for the fact. */
const answer = (code: string) => toolResultText(code);

/** Only a code the model has words for; anything else is this call's generic one. */
const codeOr = (code: string | undefined, fallback: string) =>
  code && code in TOOL_RESULT_KO ? code : fallback;

/** A value as it would have come back over JSON, the way every window handler read it. */
const overJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const asRef = (args: Record<string, unknown>) =>
  typeof args.ref === "string" &&
  args.ref &&
  typeof args.snapshotId === "number"
    ? { ref: args.ref, snapshotId: args.snapshotId }
    : null;

const invalidArguments = (): ComputerOutcome =>
  computerReplyOutcome(400, {
    error: "laf:tool_arguments_invalid",
    code: "laf:tool_arguments_invalid",
  });

/** A gateway failure as the acting route answered it, read the way the window read the reply. */
function computerFailure(error: unknown): ComputerOutcome {
  if (error instanceof ActionRefusedError) {
    return computerReplyOutcome(403, {
      error: error.code,
      rule: error.rule,
      code: error.code,
    });
  }
  const status = statusFor(error);
  if (status === 500) {
    log.error("chat_tool_failed", { reason: describeFailure(error) });
  }
  const code = codeFor(error);
  return computerReplyOutcome(status, { error: code, code });
}

/** A gateway result as the acting route answered it. */
function computerReply(result: unknown): ComputerOutcome {
  if (isBadRequest(result)) {
    return computerReplyOutcome(400, result as Record<string, unknown>);
  }
  const body = overJson((result ?? {}) as Record<string, unknown>);
  const outcome = computerReplyOutcome(200, body);
  /*
   * THE NOTES' CODES, KEPT FOR THE TURN LOOP. The shared mapping puts the notes into words and keeps
   * nothing else, so "an alert went up" reached the loop as a Korean sentence — and an alert ends
   * the rest of a round of browser steps (`runner/round-stop.ts`). Added here, on the server, not in
   * the shared mapping: what the eval hands a model straight from that mapping must not grow a
   * field. The loop takes them off again before it files the result (`turn-loop.ts`).
   */
  const codes = noteCodesOf(body.notes);
  return codes.length > 0 ? { ...outcome, noteCodes: codes } : outcome;
}

/**
 * The grants a Bot's last turn read, by Bot. A listing that fails reuses them rather than dropping
 * the Bot's plugin and card tools for one turn: the tool list is the head of the prompt, and a list
 * that loses tools and gets them back re-bills the conversation twice (review L3).
 */
type Listing = {
  plugins: Awaited<ReturnType<PluginStore["offeredToModel"]>>["tools"];
  /** Kept with the tools it was counted beside: a failed listing reuses both or neither. */
  withheld: WithheldTools;
  components: string[];
};

/** The names of every tool this file can carry out for one Bot, right now. */
async function executableNames(
  deps: ChatToolsDeps,
  botId: string,
  lastListed: Map<string, Listing>,
): Promise<{
  names: Set<string>;
  pluginRefs: Map<string, string>;
  pluginTools: Tool[];
  /** The plugin tools that wait for review: worded by this server, whoever else has a copy. */
  waiting: Set<string>;
  /** The ones that wait and are offered under no name at all, counted per server. */
  withheld: WithheldTools;
}> {
  const names = new Set<string>();
  if (deps.gateway) {
    for (const tool of COMPUTER_TOOLS) names.add(tool.name);
  }
  if (deps.agents) names.add(UPDATE_PROFILE.name);
  if (deps.routines) names.add(MANAGE_ROUTINE.name);
  if (deps.agents && (deps.memories || deps.whereabouts)) {
    names.add(REMEMBER.name);
  }
  const pluginRefs = new Map<string, string>();
  const pluginTools: Tool[] = [];
  const waiting = new Set<string>();
  const last = lastListed.get(botId);
  const listing: Listing = { plugins: [], withheld: [], components: [] };
  if (deps.pluginStore) {
    names.add(SKILL_VIEW.name);
    const granted = await deps.pluginStore.offeredToModel(botId).catch(() => {
      log.warn("chat_tools_listing_failed", { bot: botId, of: "plugins" });
      return null;
    });
    listing.plugins = granted?.tools ?? last?.plugins ?? [];
    listing.withheld = granted
      ? (granted.withheld ?? [])
      : (last?.withheld ?? []);
    for (const tool of listing.plugins) {
      names.add(tool.toolName);
      pluginRefs.set(tool.toolName, tool.ref);
      if (tool.waitsForReview) waiting.add(tool.toolName);
      pluginTools.push({
        name: tool.toolName,
        description: tool.description,
        parameters: tool.inputSchema,
      });
    }
  }
  if (deps.components) {
    const held = await deps.components.listForAgent(botId).catch(() => {
      log.warn("chat_tools_listing_failed", { bot: botId, of: "components" });
      return null;
    });
    listing.components = held
      ? held.map((component) => component.name)
      : (last?.components ?? []);
    for (const name of listing.components) {
      // A file card hands over a file from the Bot's folder, and the folder is on its computer: a
      // deployment with no computer has nothing the card could offer, so it is not offered.
      if (name === FILE_CARD && !deps.gateway) continue;
      names.add(name);
    }
  }
  lastListed.set(botId, listing);
  return {
    names,
    pluginRefs,
    pluginTools,
    waiting,
    withheld: listing.withheld,
  };
}

/**
 * The tools a turn offers when its window declared none: the ones this server can describe on its
 * own. The gallery's cards are not among them — their schemas live in the page.
 */
function serverTools(deps: ChatToolsDeps, pluginTools: Tool[]): Tool[] {
  return [
    ...(deps.gateway
      ? COMPUTER_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }))
      : []),
    ...(deps.agents
      ? [
          {
            name: UPDATE_PROFILE.name,
            description: UPDATE_PROFILE.description,
            parameters: UPDATE_PROFILE.parameters,
          },
        ]
      : []),
    ...(deps.routines
      ? [
          {
            name: MANAGE_ROUTINE.name,
            description: MANAGE_ROUTINE.description,
            parameters: MANAGE_ROUTINE.parameters,
          },
        ]
      : []),
    ...(deps.agents && (deps.memories || deps.whereabouts)
      ? [
          {
            name: REMEMBER.name,
            description: REMEMBER.description,
            parameters: REMEMBER.parameters,
          },
        ]
      : []),
    ...pluginTools,
    ...(deps.pluginStore
      ? [
          {
            name: SKILL_VIEW.name,
            description: SKILL_VIEW.description,
            parameters: SKILL_VIEW.parameters,
          },
        ]
      : []),
  ];
}

export function createChatTools(deps: ChatToolsDeps) {
  const lastListed = new Map<string, Listing>();
  return async (
    context: ChatTurnContext,
    declared: readonly Tool[] | null,
  ): Promise<ChatToolkit> => {
    const { botId, owner, threadId, runId } = context;
    const { names, pluginRefs, pluginTools, waiting, withheld } =
      await executableNames(deps, botId, lastListed);
    /*
     * 목표's tools, added here rather than declared by a window: they are this server's own and sit
     * behind the bridge, so they cost the head of the prompt nothing (`shared/tools/goals.ts`). The
     * yeses are this turn's — a turn starts at the person's message, so a yes collected in it came
     * after that message.
     */
    const approvals = goalApprovals();
    const goals = deps.goals
      ? goalTools({
          store: deps.goals,
          userId: owner.id,
          agentId: botId,
          runId,
          approvals,
        })
      : null;
    for (const tool of goals?.tools ?? []) names.add(tool.name);
    /*
     * A CONNECTED TOOL ON THE CORE LIST IS OFFERED AS THIS SERVER KNOWS IT, whatever the window
     * declared — today that is the web search and the weather (`WEB_SEARCH_TOOL_NAME`,
     * `WEATHER_TOOL_NAME`). A core tool is in the head
     * of the prompt, so one that a window had not read yet on a conversation's first message (its
     * plugin list is a query that may still be loading) and declared on the second would start an
     * epoch twice, re-billing everything behind it both times. The server's own listing does not
     * depend on which window sent the message or how long it had been open.
     *
     * AND SO IS A TOOL THAT WAITS FOR REVIEW, for a different reason (2026-10-06). What a window
     * declares for a connected tool is the window's own copy of its description, kept by name —
     * and a window open since before the vendor changed the tool, or loaded by a build that still
     * handed the changed text over, declares words nobody has reviewed. For such a tool the only
     * words a model is given are the ones `offeredToModel` wrote, and the window's are dropped. A
     * tool that APPEARED after registration is not among the names at all, so a window's entry
     * for it goes with everything else this server would not carry out. Every other connected
     * tool keeps the window's words, which name its server beside the vendor's description.
     *
     * AND THE OTHER WAY ROUND: A WINDOW STILL HOLDING THE STAND-IN FOR A TOOL THAT NO LONGER WAITS
     * (the review of #119). The window's copy is refreshed by a poll, so for up to a minute after a
     * person approves a tool another window of theirs still declares this deployment's "waiting
     * for review, do not call" in place of the definition they have just read — with its server
     * named after it, so it is not even the same bytes — and an empty schema. Taken, the Bot was
     * told a reviewed tool still waited, and a call it made anyway went out with no field it had
     * ever been shown. The stand-in is this server's sentence and never a vendor's, so a window's
     * copy of it is recognised by how it begins, and the listing this turn just read is offered
     * in its place: for a tool that waits that is the stand-in again, and for one that does not
     * it is the reviewed definition.
     */
    const isCorePlugin = (name: string) =>
      pluginRefs.has(name) && CORE_TOOL_NAMES.has(name);
    const heldAsStandIn = new Set(
      (declared ?? [])
        .filter(
          (tool) =>
            pluginRefs.has(tool.name) &&
            tool.description.startsWith(PAUSED_TOOL_DESCRIPTION),
        )
        .map((tool) => tool.name),
    );
    const isServerWorded = (name: string) =>
      isCorePlugin(name) || waiting.has(name) || heldAsStandIn.has(name);
    const listed = declared
      ? [
          ...declared.filter(
            (tool) => names.has(tool.name) && !isServerWorded(tool.name),
          ),
          ...pluginTools.filter((tool) => isServerWorded(tool.name)),
        ]
      : serverTools(deps, pluginTools);
    /*
     * THE CONNECT CARD IS HANDED ON WITH THIS PERSON'S ACCOUNTS WRITTEN ON IT: which this
     * deployment can connect, and whether each is on. A lookup that finds nothing of a connected
     * service reads them to say what could be connected (`searchResultText`,
     * `shared/tools/bridge.ts`), and it is answered where only the run's tool list is known — so
     * the facts ride on the tool connecting is done with. From the connection's own row, read for
     * this message: an account that is on and brought no tools is on. The card is behind the
     * bridge, so nothing at the head of the prompt moves when somebody connects one. A read that
     * fails writes nothing, and the lookup then says nothing about connecting.
     */
    const accounts = deps.accounts
      ? await deps.accounts(owner.id).catch(() => null)
      : null;
    const told = (tool: Tool): Tool =>
      accounts && tool.name === CONNECT_CARD
        ? { ...tool, parameters: withAccountStates(tool.parameters, accounts) }
        : tool;
    const tools = (
      goals
        ? [
            ...listed,
            ...goals.tools.filter(
              (tool) => !listed.some((one) => one.name === tool.name),
            ),
          ]
        : listed
    ).map(told);
    if (declared) {
      const dropped = declared
        .filter((tool) => !names.has(tool.name))
        .map((tool) => tool.name);
      if (dropped.length > 0) {
        // Names, never arguments: what a window offered that nothing here would carry out.
        log.info("chat_tools_not_offered", { bot: botId, tools: dropped });
      }
    }
    /** The card that hands a file over is among what THIS turn offers (a window declared it). */
    const handsFilesOver = tools.some((tool) => tool.name === FILE_CARD);
    const holder = `turn:${runId}`;
    const personWaitMs = deps.personWaitMs ?? PERSON_WAIT_MS;
    const awaitPerson =
      context.awaitPerson ??
      (async <T>(wait: () => Promise<T>) => ({
        value: await wait(),
        moved: false,
      }));

    /** The actor a call is carried out as, naming its conversation and its step. */
    const actorFor = (toolCallId: string): ActionActor => ({
      id: owner.id,
      // The local actor is not a row in `users`, so it is named without claiming to be one.
      ...(owner.id === DEV_ACTOR.id ? {} : { userId: owner.id }),
      threadId,
      toolCallId,
    });

    /**
     * One computer call, including the pause where a person is asked about it: the same sequence
     * the window's `takeStep` ran — try, wait for the answer, send the identical call once more
     * with the answer on it.
     */
    const governed = async (
      signal: AbortSignal,
      attempt: (approvalId: string | undefined) => Promise<unknown>,
      shape: (outcome: ComputerOutcome) => ComputerOutcome = (outcome) =>
        outcome,
      /** The call acts on the page in front of the Bot, not on its files or on an address. */
      onThePage = true,
    ): Promise<ComputerOutcome> => {
      let pause: ActionNeedsApprovalError;
      try {
        return shape(computerReply(await attempt(undefined)));
      } catch (error) {
        if (signal.aborted) return refusal("laf:stopped", { stopped: true });
        if (!(error instanceof ActionNeedsApprovalError)) {
          return computerFailure(error);
        }
        pause = error;
      }
      const { value: waited, moved } = await awaitPerson(() =>
        awaitApproval(deps.approvals ?? noRegistry, {
          botId,
          approvalId: pause.approvalId,
          holder,
          signal,
        }),
      );
      /*
       * STOPPED WHILE TAKING THE BOT BACK (2026-09-27 code sprint). A yes followed by 멈춤 could lose
       * the race for the lane to the stop, and the approved action then went out anyway — without
       * the lane, after the person had asked for everything to stop.
       */
      if (signal.aborted) return refusal("laf:stopped", { stopped: true });
      if (waited.answer === "granted") {
        /*
         * SOMEBODY ELSE DROVE THE BOT WHILE THE PERSON DECIDED. The lane was let go of for the wait
         * (`engine.ts`), and a routine may have moved the shared browser: the element the person
         * said yes to may not be the one under that ref any more. Not sent — the Bot is told to look
         * again, and asks again if it still means to.
         */
        if (moved && onThePage) {
          return computerReplyOutcome(409, {
            error: STALE_REFS,
            code: STALE_REFS,
          });
        }
        try {
          return shape(computerReply(await attempt(pause.approvalId)));
        } catch (error) {
          if (signal.aborted) return refusal("laf:stopped", { stopped: true });
          if (error instanceof ActionNeedsApprovalError) {
            // Sent once, not waited on again: a second ask means the answer did not fit the call.
            return {
              ok: false,
              awaitingApproval: true,
              approvalId: error.approvalId,
              subject: error.subject,
              rule: error.rule,
              ...(error.scope ? { scope: error.scope } : {}),
              ...(error.threadId ? { threadId: error.threadId } : {}),
              ...(error.taskId ? { taskId: error.taskId } : {}),
              expiresAt: error.expiresAt,
              reason: toolResultText("laf:awaiting_approval"),
            };
          }
          return computerFailure(error);
        }
      }
      if (waited.answer === "cancelled") {
        return refusal("laf:stopped", { stopped: true });
      }
      return waited.answer === "declined"
        ? refusal("laf:person_declined", { refused: true })
        : refusal("laf:nobody_answered");
    };

    /**
     * Hold a call open until the ask for a hand or for a value is answered, or it runs out.
     *
     * `done` READS AN ASK THAT IS GONE AS AN ASK THAT WAS ANSWERED, so the ask has to outlast this
     * wait. The computer lets go of one nobody answered (`REQUEST_TTL_MS`,
     * `agent-computer/src/control.ts`) only after this wait's own time and a margin over it, and
     * both read the one number in `shared/person-wait.ts`: let go of any sooner, the last look
     * here would answer `laf:control_returned` about a person who never came.
     *
     * One ask the computer does end in the middle of this wait: the one whose tab went from under
     * the Bot. Its state says nobody answered it, and that is what this answers (`askOutcome`).
     */
    const waitForPerson = async (
      toolCallId: string,
      signal: AbortSignal,
      done: (state: Record<string, unknown>) => boolean,
    ): Promise<
      "answered" | "gave up" | "unfilled" | "cancelled" | "skipped"
    > => {
      const deadline = Date.now() + personWaitMs;
      while (Date.now() < deadline) {
        if (signal.aborted) return "cancelled";
        // Read before the computer: a skip also hands back, which the computer reports as done.
        if (deps.people.takeSkip(toolCallId)) return "skipped";
        const state = await deps.gateway?.control(botId).catch(() => null);
        if (state && done(state as unknown as Record<string, unknown>)) {
          // Gone because somebody answered it, or because the tab it was about went
          // (`askOutcome`): only the first is a person having come.
          return askOutcome(state);
        }
        await sleep(deps.controlPollMs ?? CONTROL_POLL_MS, signal);
      }
      return "gave up";
    };

    const computer = async (
      name: string,
      args: Record<string, unknown>,
      call: { id: string; signal: AbortSignal },
    ): Promise<LoopOutcome> => {
      const gateway = deps.gateway;
      if (!gateway) return refusal("laf:tool_unknown");
      const { signal } = call;
      const actor = actorFor(call.id);
      const c = botId;
      switch (name) {
        case "computer_navigate":
          if (typeof args.url !== "string" || !args.url.trim()) {
            return invalidArguments();
          }
          return governed(
            signal,
            (approvalId) =>
              gateway.navigate(
                c,
                botId,
                actor,
                String(args.url).trim(),
                approvalId,
                signal,
                BOTS_OWN_LOOK,
              ),
            navigationOutcome,
            false,
          );
        case "computer_read":
          try {
            return computerReply(
              await gateway.read(botId, {
                whole: args.whole === true,
                ...(typeof args.from === "string" && args.from.trim()
                  ? { from: args.from.trim() }
                  : {}),
                ...BOTS_OWN_LOOK,
              }),
            );
          } catch (error) {
            return computerFailure(error);
          }
        case "computer_snapshot":
          try {
            return computerReply(
              snapshotForModel(
                await gateway.snapshot(botId, {
                  botId,
                  actor: {
                    id: owner.id,
                    ...(owner.id === DEV_ACTOR.id ? {} : { userId: owner.id }),
                  },
                  ...BOTS_OWN_LOOK,
                }),
              ),
            );
          } catch (error) {
            return computerFailure(error);
          }
        case "computer_click": {
          const target = asRef(args);
          if (!target) return invalidArguments();
          return governed(signal, (approvalId) =>
            gateway.click(c, botId, actor, target, signal, approvalId),
          );
        }
        case "computer_type": {
          const target = asRef(args);
          if (!target || typeof args.text !== "string") {
            return invalidArguments();
          }
          const text = args.text;
          return governed(signal, (approvalId) =>
            gateway.type(
              c,
              botId,
              actor,
              { ...target, text, submit: args.submit === true },
              signal,
              approvalId,
            ),
          );
        }
        case "computer_key": {
          if (typeof args.key !== "string" || !args.key) {
            return invalidArguments();
          }
          const key = args.key;
          return governed(signal, (approvalId) =>
            gateway.key(
              c,
              botId,
              actor,
              { key, ...(asRef(args) ?? {}) },
              signal,
              approvalId,
            ),
          );
        }
        case "computer_scroll":
          return governed(signal, (approvalId) =>
            gateway.scroll(
              c,
              botId,
              actor,
              typeof args.deltaY === "number" ? { deltaY: args.deltaY } : {},
              approvalId,
            ),
          );
        case "computer_switch_tab": {
          if (typeof args.index !== "number" || !Number.isInteger(args.index)) {
            return invalidArguments();
          }
          const index = args.index;
          return governed(signal, (approvalId) =>
            gateway.switchTab(c, botId, actor, { index }, approvalId),
          );
        }
        case "computer_upload_file": {
          const target = asRef(args);
          if (!target || typeof args.path !== "string" || !args.path.trim()) {
            return invalidArguments();
          }
          const path = args.path.trim();
          return governed(signal, (approvalId) =>
            gateway.uploadFile(
              c,
              botId,
              actor,
              { ...target, path },
              signal,
              approvalId,
            ),
          );
        }
        case "computer_list_files": {
          const listed =
            typeof args.path === "string" && args.path.trim()
              ? { path: args.path.trim() }
              : {};
          return governed(
            signal,
            (approvalId) =>
              gateway.listFiles(c, botId, actor, listed, approvalId),
            undefined,
            false,
          );
        }
        case "computer_read_file": {
          const input = readFileInputOf(args);
          if (!input) return invalidArguments();
          return governed(
            signal,
            (approvalId) =>
              gateway.readFile(c, botId, actor, input, approvalId),
            undefined,
            false,
          );
        }
        case "computer_write_file": {
          if (
            typeof args.path !== "string" ||
            !args.path.trim() ||
            typeof args.contents !== "string"
          ) {
            return invalidArguments();
          }
          const file = {
            path: args.path.trim(),
            contents: args.contents,
            append: args.append === true,
          };
          return governed(
            signal,
            (approvalId) =>
              gateway.writeFile(c, botId, actor, file, approvalId),
            /*
             * WRITTEN IS NOT HANDED OVER, AND THE ANSWER SAYS SO where the card that hands a file
             * over is on offer (`toolResultText`, `laf:file_saved_not_handed_over`). In a
             * conversation with a day behind it the Bot wrote the file and told the person its
             * name, three times in three — a place they cannot reach.
             */
            (outcome) =>
              outcome.ok && handsFilesOver
                ? {
                    ...outcome,
                    note: toolResultText("laf:file_saved_not_handed_over"),
                  }
                : outcome,
            false,
          );
        }
        case "computer_request_help": {
          const asked = await governed(signal, () =>
            gateway.requestHelp(
              c,
              botId,
              actor,
              typeof args.reason === "string" && args.reason.trim()
                ? args.reason.trim()
                : "The assistant needs a person to continue.",
            ),
          );
          if (!asked.ok) return asked;
          // Resolved when no help request remains outstanding.
          const { value: outcome, moved } = await awaitPerson(() =>
            waitForPerson(call.id, signal, (state) => !state.requested),
          );
          const code =
            outcome === "answered"
              ? "laf:control_returned"
              : outcome === "skipped"
                ? "laf:help_skipped"
                : outcome === "cancelled"
                  ? "laf:request_cancelled"
                  : "laf:nobody_took_control";
          return {
            ok: true,
            code,
            result: toolResultText(code),
            ...(moved ? { notes: toolResultText(STALE_REFS) } : {}),
          };
        }
        case "computer_request_secret": {
          // One card, with a box for each value — or the one box the tool took until a card held
          // several, which a conversation from before that may still write (`secret-ask.ts`).
          const fields = secretFieldsOf(args);
          const { snapshotId } = args;
          if (!fields || typeof snapshotId !== "number") {
            return invalidArguments();
          }
          // Which saved login, where the Bot was told this site has several. Never a value.
          const login =
            typeof args.login === "string" && args.login.trim()
              ? args.login.trim()
              : undefined;
          const asked = await governed(signal, (approvalId) =>
            gateway.requestSecret(
              c,
              botId,
              actor,
              { fields, snapshotId, ...(login ? { login } : {}) },
              approvalId,
              signal,
            ),
          );
          if (!asked.ok) return asked;
          /*
           * A LOGIN THE PERSON SAVED ANSWERED, AND NOBODY IS WAITED FOR (record §6, piece 2-4).
           * The boxes are filled, or the site has several saved logins and the Bot is handed
           * what each is called to choose by — never anything of what one holds.
           */
          if (asked.loginFilled) {
            return {
              ok: true,
              code: "laf:login_filled",
              result: toolResultText("laf:login_filled"),
            };
          }
          if (Array.isArray(asked.loginChoice)) {
            return {
              ok: true,
              code: "laf:login_choice",
              result: toolResultText("laf:login_choice"),
              logins: asked.loginChoice,
            };
          }
          // Completion is `secretWanted` clearing; the value never returns to the model.
          const { value: outcome, moved } = await awaitPerson(() =>
            waitForPerson(
              call.id,
              signal,
              (state) => state.secretWanted === undefined,
            ),
          );
          // "Unfilled" is somebody having come and the page not being what the card said: not
          // "nobody entered anything", which is what the Bot was told for it (`person-wait.ts`).
          const code =
            outcome === "answered"
              ? "laf:secret_entered"
              : outcome === "skipped"
                ? "laf:secret_skipped"
                : outcome === "cancelled"
                  ? "laf:request_cancelled"
                  : outcome === "unfilled"
                    ? "laf:secret_not_filled"
                    : "laf:secret_not_entered";
          return {
            ok: true,
            code,
            result: toolResultText(code),
            ...(moved ? { notes: toolResultText(STALE_REFS) } : {}),
          };
        }
        default:
          return refusal("laf:tool_unknown");
      }
    };

    /** A call to somebody else's server, as the window's own call answered it: a sentence. */
    const plugin = async (
      ref: string,
      args: Record<string, unknown>,
      call: { id: string; signal: AbortSignal },
    ): Promise<LoopOutcome> => {
      const store = deps.pluginStore;
      if (!store) return refusal("laf:tool_unknown");
      const send = (approvalId?: string) =>
        store.callTool({
          ref,
          args,
          botId,
          actorId: owner.id,
          threadId,
          toolCallId: call.id,
          actorIsAdmin: owner.role === "admin",
          ...(approvalId ? { approvalId } : {}),
          // A line of the conversation — a window of it now, or the transcript later — so a code
          // withheld from a mail is kept to be shown on it, and a forecast is drawn as a card.
          drawnOn: "conversation",
        });
      const said = (result: { text: string; isError: boolean }) =>
        result.isError ? toolErrorText(result.text) : result.text;
      try {
        return said(await send());
      } catch (error) {
        if (call.signal.aborted) return toolResultText("laf:stopped");
        if (!(error instanceof PluginNeedsApprovalError)) {
          return pluginFailure(error, ref);
        }
        // Somebody else's server, not the page: nothing a routine did meanwhile changes the call.
        const { value: waited } = await awaitPerson(() =>
          awaitApproval(deps.approvals ?? noRegistry, {
            botId,
            approvalId: error.approvalId,
            holder,
            signal: call.signal,
          }),
        );
        // Stopped while the Bot was being taken back: the yes is not carried out (see above).
        if (call.signal.aborted) return toolResultText("laf:stopped");
        if (waited.answer === "granted") {
          try {
            return said(await send(error.approvalId));
          } catch (again) {
            if (again instanceof PluginNeedsApprovalError) {
              return toolResultText("laf:approval_did_not_fit");
            }
            return pluginFailure(again, ref);
          }
        }
        if (waited.answer === "declined") {
          return toolResultText("laf:person_declined");
        }
        return toolResultText(
          waited.answer === "cancelled" ? "laf:stopped" : "laf:nobody_answered",
        );
      }
    };

    const skillView = async (args: Record<string, unknown>) => {
      const store = deps.pluginStore;
      if (!store) return refusal("laf:tool_unknown");
      const name = normalizeSkillName(String(args.name ?? ""));
      const viewed = await store
        .viewSkill({ slug: name, agentId: botId, actorId: owner.id })
        .catch(() => null);
      if (!viewed?.allowed) {
        const code =
          viewed && typeof viewed.reason === "string"
            ? viewed.reason.startsWith("laf:")
              ? viewed.reason
              : "laf:skill_not_granted"
            : "laf:skill_not_granted";
        return { ok: false, code, reason: toolResultText(code) };
      }
      const skill = overJson(viewed.skill) as Partial<{
        slug: string;
        title: string;
        summary: string;
        instructions: string;
      }>;
      return {
        ok: true,
        slug: skill.slug ?? name,
        title: skill.title ?? name,
        summary: skill.summary ?? "",
        instructions: skill.instructions ?? "",
      };
    };

    const updateProfile = async (args: Record<string, unknown>) => {
      if (!deps.agents) return answer("laf:profile_invalid");
      const patch: Record<string, unknown> = {};
      if (args.name !== undefined) patch.name = args.name;
      if (args.description !== undefined)
        patch.roleDescription = args.description;
      // No `effort`, even from a call that carries one: how hard a Bot thinks is fixed since
      // 2026-10-08, and the tool no longer offers it (`shared/tools/self.ts`).
      const edited = await editProfile(
        deps.agents,
        owner,
        botId,
        patch,
        deps.allowPrivateHosts === true,
      ).catch(() => null);
      if (!edited?.ok) {
        return answer(codeOr(edited?.code, "laf:profile_invalid"));
      }
      return answer("laf:profile_updated");
    };

    const remember = async (args: Record<string, unknown>) => {
      const place = typeof args.place === "string" ? args.place : "";
      if (place.trim()) {
        const parsed = placeAnswerOf({ place, coordinates: null });
        if (!parsed.ok) return answer("laf:place_invalid");
        if (!deps.whereabouts) return answer("laf:place_unsaved");
        try {
          await deps.whereabouts.savePlace(owner.id, parsed.value);
        } catch {
          return answer("laf:place_unsaved");
        }
        return answer("laf:place_saved");
      }
      if (!deps.agents || !deps.memories) return answer("laf:no_bot_here");
      const kept = await rememberFact(
        deps.agents,
        deps.memories,
        owner,
        botId,
        typeof args.fact === "string" ? args.fact : "",
      ).catch(() => null);
      if (!kept?.ok) return answer(codeOr(kept?.code, "laf:memory_empty"));
      return answer("laf:remembered");
    };

    const manageRoutine = (args: Record<string, unknown>) =>
      deps.routines
        ? routineAction(deps.routines, owner, botId, args)
        : Promise.resolve(answer("laf:routine_list_unavailable"));

    /**
     * The tools a connection that landed mid-turn brought, offered from now on in this turn.
     *
     * A turn's list is drawn once, when the person's message arrives. A connect card that waited
     * until Gmail was switched on would otherwise hand the Bot back a turn in which Gmail's tools
     * are neither offered nor carried out — "연결됐어요", and then `laf:tool_unknown`. ADDED, NEVER
     * REMOVED, and only tools behind the bridge: the head of the prompt is the core list, which
     * this does not touch (`toolsFingerprint`), so nothing behind it is re-billed.
     */
    const offerLandedTools = async (): Promise<string[]> => {
      const again = await executableNames(deps, botId, lastListed);
      const added: string[] = [];
      for (const tool of again.pluginTools) {
        if (names.has(tool.name)) continue;
        const ref = again.pluginRefs.get(tool.name);
        if (ref === undefined) continue;
        names.add(tool.name);
        pluginRefs.set(tool.name, ref);
        tools.push(tool);
        added.push(tool.name);
      }
      return added;
    };

    /**
     * What the card just said is on, written on the card for the rest of this turn.
     *
     * The accounts on the card are this turn's read from BEFORE anybody pressed a switch, and every
     * lookup after the card's answer still reads them (`searchResultText`). An account that turned
     * on with its tools is left out of what could be connected by the tools being in the list
     * (`openAccountsIn`). One that turned on and brought none was still named "아직 연결하지 않은
     * 계정 … 연결 카드를 띄운다" — to a Bot this card had just told it is on, with nothing to use.
     * So the card is handed on again saying what its own answer says, and the lookup's line for
     * that account becomes the one for on-with-no-tools. Behind the bridge, like the first writing:
     * nothing at the head of the prompt moves.
     */
    const noteConnected = (connected: readonly string[]) => {
      const at = tools.findIndex((tool) => tool.name === CONNECT_CARD);
      const card = tools[at];
      const written = card ? accountStatesIn(card.parameters) : null;
      if (!card || !written) return;
      const isNews = (account: AccountState) =>
        !account.connected && connected.includes(account.key);
      if (!written.some(isNews)) return;
      tools[at] = {
        ...card,
        parameters: withAccountStates(
          card.parameters,
          written.map((account) =>
            isNews(account) ? { ...account, connected: true } : account,
          ),
        ),
      };
    };

    /**
     * 연결's switches, put in the conversation — and waited on.
     *
     * THE CALL ENDS WHEN A SWITCH IS ON, OR THE PERSON SAYS NOT NOW. Two things end the wait: the
     * card's own answer from whichever window the person is in (나중에, or its nudge that something
     * turned on), and this turn looking at 연결 for itself every few seconds — so a consent finished
     * in the person's browser with the app closed still lets the Bot go on, which is what a turn
     * the server owns is for. Whichever came first, what the Bot is told is read from 연결 after it:
     * a window's word is never the fact.
     */
    const connectCard = async (
      args: Record<string, unknown>,
      call: { id: string; signal: AbortSignal },
    ): Promise<LoopOutcome> => {
      const offered = [
        ...new Set(
          (Array.isArray(args.services) ? args.services : []).filter(
            (id): id is string => typeof id === "string",
          ),
        ),
      ];
      const read = async () =>
        deps.connections
          ? await deps.connections(owner.id).catch(() => null)
          : null;
      const first = await read();
      // What this deployment has of what was offered: the card draws these and leaves the rest out.
      const here = first
        ? offered.filter((id) => first.some((row) => row.id === id))
        : [];
      if (!first || here.length === 0) {
        // Nothing to draw, so nothing to wait for: ten minutes on an empty card would be the turn.
        return JSON.stringify(
          connectionAnswer({ offered, connected: [], isOffered: false }),
        );
      }
      const onIn = (rows: readonly ConnectionSwitch[]) =>
        here.filter((id) => rows.some((row) => row.id === id && row.connected));
      /*
       * CONNECTED, AND WHETHER ANYTHING CAN BE DONE WITH IT. A site that is on is worked through
       * the browser. An account that is on is worked through its tools, and it can be on with none
       * in this turn's list: 카카오's toolbox is the person's own and may be empty, a listing can
       * fail at connect (`plugins/servers.ts`, `offerToolsTo`), a grant can be taken away. Told
       * `laf:connection_on` for that — "its tools are there, look them up" — a Bot looked, found
       * nothing, and raised the card again, for as many steps as a question is allowed (review,
       * 2026-10-05). So where nothing that is connected has anything to work through, the fact is
       * a different one. An account is what this turn read as one (`accounts`); where that was not
       * read, nothing is known to be unusable.
       */
      const isUsable = (connected: readonly string[]) =>
        connected.some(
          (id) =>
            !accounts?.some((account) => account.key === id) ||
            [...names].some((name) => serverKeyOf(name) === id),
        );
      const before = onIn(first);
      if (before.length === here.length) {
        // Every switch it would draw is already on: the Bot is told so and goes on.
        noteConnected(before);
        return JSON.stringify(
          connectionAnswer({
            offered,
            connected: before,
            isUsable: isUsable(before),
          }),
        );
      }

      const settled = new AbortController();
      const signal = AbortSignal.any([call.signal, settled.signal]);
      const pollMs = deps.connectionPollMs ?? CONNECTION_POLL_MS;
      const { value: answered } = await awaitPerson(async () => {
        const person = deps.people.wait({
          threadId,
          toolCallId: call.id,
          signal,
          timeoutMs: personWaitMs,
        });
        const landed = (async () => {
          while (!signal.aborted) {
            await sleep(pollMs, signal);
            if (signal.aborted) break;
            const rows = await read();
            if (rows && onIn(rows).some((id) => !before.includes(id))) {
              return true;
            }
          }
          return false;
        })();
        const outcome = await Promise.race([
          person,
          landed.then((found) =>
            found ? { answered: true as const, value: undefined } : person,
          ),
        ]);
        // Whichever is still waiting stops: the card's question is over either way.
        settled.abort();
        await Promise.allSettled([person, landed]);
        return outcome;
      });
      if (call.signal.aborted) return toolResultText("laf:stopped");

      const rows = await read();
      const now = rows ? onIn(rows) : before;
      const fresh = now.filter((id) => !before.includes(id));
      if (!answered.answered && fresh.length === 0) {
        return toolResultText("laf:nobody_answered");
      }
      const landedTools = fresh.length > 0 ? await offerLandedTools() : [];
      /*
       * A SWITCH THAT TURNED ON A MOMENT AGO MAY NOT HAVE ITS TOOLS YET. The connect callback
       * records the connection and only then asks the vendor for its tools and grants them
       * (`plugins/routes.ts`), and this wait ends on the first of those: read at once, an account
       * connected a second ago had no tools, and its person was told there was nothing to use and
       * not to look again (review, 2026-10-05). So an account that turned on DURING this wait is
       * looked at again every poll until its tools are here — for as long as a listing may take
       * (`TIMEOUT_MS.mcpList`, fifteen seconds: one that has not landed by then timed out or
       * brought nothing, and "nothing usable" is then true). An adapter of this repository lists
       * from memory, so its tools are here by the first look or the one after; an account that was
       * on before this card went up has had its time, and is not waited for.
       */
      const hasTools = (id: string) =>
        [...names].some((name) => serverKeyOf(name) === id);
      const awaited = fresh.filter((id) =>
        accounts?.some((account) => account.key === id),
      );
      const listingBy = Date.now() + (deps.listingWaitMs ?? TIMEOUT_MS.mcpList);
      while (
        awaited.some((id) => !hasTools(id)) &&
        Date.now() < listingBy &&
        !call.signal.aborted
      ) {
        await sleep(Math.min(pollMs, listingBy - Date.now()), call.signal);
        if (call.signal.aborted) break;
        landedTools.push(...(await offerLandedTools()));
      }
      if (call.signal.aborted) return toolResultText("laf:stopped");
      noteConnected(now);
      return JSON.stringify(
        connectionAnswer({
          offered,
          connected: now,
          tools: landedTools,
          // Read after the landed tools were offered: a connection that brought none is said so.
          isUsable: isUsable(now),
        }),
      );
    };

    /**
     * THE FILE BEHIND A FILE CARD, LOOKED FOR BEFORE THE BOT IS TOLD IT IS ON SCREEN.
     *
     * Every other card draws what the call handed it, so "it is on screen" is true the moment it is
     * allowed. This one draws a file the call only NAMED — and a Bot that misremembers a path, or
     * never wrote the file it says it did, would be told the person now has it while the card says
     * it is gone. So the path is asked about first, and what comes back for a path that is not a
     * file is the computer's own fact, in the envelope `computer_read_file` answers the same path
     * with: nothing there, a folder, a path outside the folder.
     *
     * The runtime checking a fact, not the Bot reading its file — no policy is asked and no row is
     * written, as for `spillover.ts` filing a result. Existence and kind only: how big a file may be
     * to be downloaded is the card's and the route's (`shared/workspace-files.ts`), and nothing a
     * Bot can write today is over it.
     *
     * Null when the file is there.
     */
    const fileCardRefused = async (
      args: Record<string, unknown>,
    ): Promise<LoopOutcome | null> => {
      const gateway = deps.gateway;
      if (!gateway) return refusal("laf:tool_unknown");
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (!path) return invalidArguments();
      try {
        await gateway.fileFacts(botId, path);
        return null;
      } catch (error) {
        return computerFailure(error);
      }
    };

    /**
     * A card the Bot put on screen: allowed for this Bot, reading only what it was granted.
     * The window asked exactly this before it drew one, of the same store.
     */
    const component = async (
      name: string,
      args: Record<string, unknown>,
      call: { id: string; signal: AbortSignal },
    ): Promise<LoopOutcome> => {
      const store = deps.components;
      if (!store) return refusal("laf:tool_unknown");
      /** The trail's row for a card that was not drawn: which card, for whom, and the fact why. */
      const noteRefusal = async (
        reason: string,
        extra: Record<string, unknown>,
      ) => {
        if (!deps.auditStore) return;
        await recordAuditEvent(deps.auditStore, {
          eventType: extra.function
            ? "component.function_refused"
            : "component.refused",
          targetType: "component",
          targetId: name,
          ...(owner.id === DEV_ACTOR.id ? {} : { actorUserId: owner.id }),
          payload: { actor: owner.id, bot: botId, reason, ...extra },
        }).catch(() => {});
      };
      const refuse = async (reason: string, extra: Record<string, unknown>) => {
        await noteRefusal(reason, extra);
        return reason.startsWith("laf:") ? toolResultText(reason) : reason;
      };
      const decision = await store.decide(name, botId).catch(() => null);
      if (!decision) {
        return CARD_NOT_ASKED;
      }
      if (!decision.allowed) {
        return refuse(String(decision.reason ?? ""), {});
      }
      /*
       * THE DATA THE CARD WILL READ, DECIDED BEFORE IT IS DRAWN. A card's own data call
       * (`components/routes.ts`, `/call`) enforces the same grant, but that runs while the card
       * renders — after the Bot has been told its card is on screen. Decided here, the Bot gets one
       * verdict covering what the card will do rather than only its name, and a card that would be
       * drawn empty is refused, with the missing grant named in the row. The door a window asked
       * this of before it drew a card closed on 2026-10-06, and its reason with it: this is where
       * the rule lives now.
       */
      for (const functionName of galleryReads(name, args)) {
        if (await store.mayCall(name, functionName)) continue;
        return refuse(FUNCTION_NOT_GRANTED, { function: functionName });
      }
      if (name === FILE_CARD) {
        const refused = await fileCardRefused(args);
        if (refused) return refused;
      }
      if (!GALLERY_DECISIONS.has(name)) {
        return GALLERY_CONFIRMATIONS[name] ?? ON_SCREEN;
      }
      if (name === CONNECT_CARD) return connectCard(args, call);
      /*
       * A QUESTION WITH NOTHING IN IT IS NOT ASKED (`isAskable`). It was drawn and waited on: a
       * card with no title and no options, for ten minutes. Answered at once instead, as a call
       * whose arguments do not fit — nothing happened, and the Bot is told to read the card's
       * definition and call again. An envelope, not `refuse`'s sentence: a sentence is what a call
       * that worked answers with, and the screen leaves this one out by its code.
       */
      if (!isAskable(name, args)) {
        // The fact alone: what the call held, if anything, is not the trail's to keep.
        await noteRefusal("laf:tool_arguments_invalid", {});
        return invalidArguments();
      }
      /*
       * A QUESTION TO THE PERSON: the card is drawn from the call, and its answer is the result.
       * The window's card answered its own run through CopilotKit; the server waits for the same
       * answer from whichever window the person presses it in (`routes.ts`, answers).
       */
      const { value: answered } = await awaitPerson(() =>
        deps.people.wait({
          threadId,
          toolCallId: call.id,
          signal: call.signal,
          timeoutMs: personWaitMs,
        }),
      );
      if (!answered.answered) {
        return call.signal.aborted
          ? toolResultText("laf:stopped")
          : toolResultText("laf:nobody_answered");
      }
      const value = answered.value;
      // A yes, kept for the turn: `save_goal` spends it (`goals/tools.ts`).
      if (
        name === "askApproval" &&
        value &&
        typeof value === "object" &&
        (value as { decision?: unknown }).decision === "approved"
      ) {
        approvals.approved(args);
      }
      /*
       * WHO THE PERSON IS, SAVED ON THEIR PRESS. The Bot's call only asked: `saves` made the card
       * draw the four fixed choices, and nothing was written when it was called. What is written
       * is what arrived here from the person's own session (`routes.ts`, answers), and only if it
       * is one of the four — a Bot cannot reach this line with a value of its choosing.
       */
      if (name === "askChoice" && args.saves === "persona") {
        const chosen =
          value && typeof value === "object"
            ? (value as { choice?: unknown }).choice
            : undefined;
        if (isPersona(chosen) && deps.persona) {
          const held = await deps.persona
            .savePersona(owner.id, chosen)
            .catch(() => undefined);
          return JSON.stringify({
            choice: chosen,
            saved: held === chosen,
          });
        }
      }
      return typeof value === "string" ? value : JSON.stringify(value ?? "");
    };

    const execute: LoopExecutor = async (name, args, call) => {
      try {
        if (!names.has(name)) return refusal("laf:tool_unknown");
        if (computerTool(name)) return await computer(name, args, call);
        const ref = pluginRefs.get(name);
        if (ref !== undefined) return await plugin(ref, args, call);
        if (name === SKILL_VIEW.name) return await skillView(args);
        if (name === UPDATE_PROFILE.name) return await updateProfile(args);
        if (name === REMEMBER.name) return await remember(args);
        if (name === MANAGE_ROUTINE.name) return await manageRoutine(args);
        if (goals && isGoalToolName(name)) {
          return await goals.execute(name, args);
        }
        return await component(name, args, call);
      } catch (error) {
        /*
         * A handler that threw: the call is answered, and the answer says it failed — AS A FACT,
         * NOT AS A SENTENCE. This returned the string `Error: …`, and a string is what a tool that
         * WORKED returns (`answeredOk`, `runner/turn-loop.ts`): the step was recorded as one that
         * went through, and the Bot was handed an English sentence with the error's own words in
         * it (refactoring review, 2026-10-02). The reason is in the log, where a Drizzle failure's
         * SQL and parameters are bounded (`failure-text.ts`); the Bot is told only that it failed
         * here and that nobody knows how far it got.
         */
        log.error("chat_tool_threw", {
          tool: name,
          reason: describeFailure(error),
        });
        return refusal("laf:tool_failed");
      }
    };

    return { tools, execute, ...(withheld.length > 0 ? { withheld } : {}) };
  };
}

/** No registry configured: every question is gone the moment it is asked about. */
const noRegistry: Pick<ApprovalRegistry, "hold" | "withdraw"> = {
  hold: async () => ({ ok: false }),
  withdraw: async () => undefined,
};

/** A plugin call's failure as the window read the call door's reply to it: a sentence. */
function pluginFailure(error: unknown, ref: string): string {
  if (
    error instanceof PluginRefusedError ||
    error instanceof BotNotDrivableError ||
    error instanceof CatalogueEntryUnknownError
  ) {
    const code = (error as { code?: string }).code ?? "";
    return code.startsWith("laf:") ? toolResultText(code) : TOOL_NOT_ALLOWED;
  }
  log.warn("plugin_call_failed", {
    ref,
    ...(error instanceof McpServerError && error.status !== null
      ? { status: error.status }
      : {}),
    reason: describeFailure(error),
  });
  return toolResultText(TOOL_SERVER_FAILED);
}

/* ------------------------------------------------------------------------------------------ */
/* manage_routine, as the app's `routineAction` answered it.                                   */
/* ------------------------------------------------------------------------------------------ */

type ListedRoutine = { id: string; agentId: string; name: string };

function findRoutine(
  routines: readonly unknown[],
  wanted: string,
):
  | { kind: "found"; routine: ListedRoutine }
  | { kind: "unknown" | "ambiguous" } {
  const listed = routines.filter(
    (routine): routine is ListedRoutine =>
      !!routine &&
      typeof routine === "object" &&
      typeof (routine as ListedRoutine).id === "string" &&
      typeof (routine as ListedRoutine).name === "string",
  );
  const byId = listed.find((routine) => routine.id === wanted);
  if (byId) return { kind: "found", routine: byId };
  const named = listed.filter((routine) => routine.name.trim() === wanted);
  if (named.length === 1 && named[0]) {
    return { kind: "found", routine: named[0] };
  }
  return { kind: named.length > 1 ? "ambiguous" : "unknown" };
}

/** The refusal a routine service throws, as its code; anything else is not a refusal. */
function routineCode(error: unknown, fallback: string): string {
  return error instanceof RoutineError
    ? codeOr(error.code, fallback)
    : fallback;
}

/**
 * The app's `routineAction`, over the routine service rather than its routes. The same order, the
 * same refusals and the same sentences — `shared/prompt/tool-results.ko.ts` writes all of them.
 */
export async function routineAction(
  service: Pick<
    RoutineService,
    "create" | "list" | "update" | "remove" | "setEnabled"
  >,
  actor: AgentActor,
  botId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const text = (value: unknown) =>
    typeof value === "string" ? value : undefined;
  const action = text(args.action);
  const routinesOf = async (): Promise<unknown[] | null> => {
    try {
      const all = overJson(await service.list(actor)) as unknown[];
      return all.filter(
        (routine) =>
          !!routine &&
          typeof routine === "object" &&
          (routine as { agentId?: unknown }).agentId === botId,
      );
    } catch {
      return null;
    }
  };

  if (action === "create") {
    const schedule = args.schedule as RoutineSchedule | undefined;
    // The route's own refusal for a routine with no clock, read the way the window read it.
    if (!schedule) {
      return answer(
        codeOr("laf:routine_needs_schedule", "laf:routine_incomplete"),
      );
    }
    try {
      const summary = text(args.summary)?.trim();
      const routine = await service.create(actor, {
        agentId: botId,
        name: text(args.name)?.trim() ?? "",
        instruction: text(args.instruction)?.trim() ?? "",
        ...(summary ? { summary } : {}),
        schedule,
      });
      return routineSavedText(overJson(routine));
    } catch (error) {
      return answer(routineCode(error, "laf:routine_incomplete"));
    }
  }

  if (action === "list") {
    const routines = await routinesOf();
    if (!routines) return answer("laf:routine_list_unavailable");
    return routineListResult("laf:routine_list", routines);
  }

  if (action !== "update" && action !== "delete") {
    return answer("laf:routine_unknown_action");
  }

  const wanted = text(args.routineId)?.trim();
  if (!wanted) return answer("laf:routine_needs_id");

  const change = {
    ...(args.name === undefined || args.name === null
      ? {}
      : { name: String(args.name) }),
    ...(args.instruction === undefined || args.instruction === null
      ? {}
      : { instruction: String(args.instruction) }),
    ...(args.summary === undefined || args.summary === null
      ? {}
      : { summary: String(args.summary) }),
    ...(args.schedule === undefined || args.schedule === null
      ? {}
      : { schedule: args.schedule as RoutineSchedule }),
  };
  const edits = Object.keys(change).length > 0;
  const toggles = typeof args.enabled === "boolean";
  if (action === "update" && !edits && !toggles) {
    return answer("laf:routine_nothing_to_change");
  }

  const routines = await routinesOf();
  if (!routines) return answer("laf:routine_list_unavailable");
  const found = findRoutine(routines, wanted);
  if (found.kind !== "found") {
    return routineListResult(
      found.kind === "ambiguous"
        ? "laf:routine_name_ambiguous"
        : "laf:routine_name_unknown",
      routines,
    );
  }
  const target = found.routine;

  if (action === "delete") {
    try {
      await service.remove(actor, target.id);
    } catch (error) {
      return answer(routineCode(error, "laf:routine_not_found"));
    }
    return answer("laf:routine_deleted");
  }

  const said: string[] = [];
  let edited = false;
  if (edits) {
    try {
      const routine = await service.update(actor, target.id, change);
      said.push(routineUpdatedText(overJson(routine)));
      edited = true;
    } catch (error) {
      return answer(routineCode(error, "laf:routine_not_found"));
    }
  }

  if (toggles) {
    try {
      await service.setEnabled(actor, target.id, args.enabled === true);
    } catch (error) {
      const refused = answer(routineCode(error, "laf:routine_not_found"));
      if (!edited) return refused;
      return [...said, refused].join(" ");
    }
    said.push(
      answer(args.enabled ? "laf:routine_resumed" : "laf:routine_paused"),
    );
  }

  return said.join(" ");
}
