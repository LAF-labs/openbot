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
 * somebody answers it from any window (`people.ts`); a request for help waits for the wheel to come
 * back; a decision card waits for its choice. Closing the laptop does not end the wait — the
 * question's own ten minutes do.
 *
 * WHICH TOOLS: the ones the window declared when it sent the message, as the window always decided
 * them — the gallery's schemas exist only in the page — cut to the names this file can actually
 * carry out, so the model is never offered a call nothing here would run.
 */
import type { Tool } from "@ag-ui/client";
import {
  routineListResult,
  routineSavedText,
  routineUpdatedText,
  TOOL_RESULT_KO,
  toolResultText,
} from "../../../shared/prompt/tool-results.ko";
import { COMPUTER_TOOLS, computerTool } from "../../../shared/tools/computer";
import {
  type ComputerOutcome,
  computerReplyOutcome,
  navigationOutcome,
} from "../../../shared/tools/computer-reply";
import {
  GALLERY_CONFIRMATIONS,
  GALLERY_DECISIONS,
  galleryReads,
  ON_SCREEN,
} from "../../../shared/tools/gallery";
import {
  MANAGE_ROUTINE,
  REMEMBER,
  UPDATE_PROFILE,
  UPDATE_PROFILE_WITHOUT_EFFORT,
} from "../../../shared/tools/self";
import { normalizeSkillName, SKILL_VIEW } from "../../../shared/tools/skills";
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
import {
  type ActionActor,
  ActionNeedsApprovalError,
  ActionRefusedError,
  type ComputerGateway,
} from "../computer/gateway";
import { codeFor, isBadRequest, statusFor } from "../computer/routes";
import { readFileInputOf } from "../computer/schema";
import { snapshotForModel } from "../computer/snapshot-lines";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import { McpServerError } from "../plugins/mcp";
import { TOOL_SERVER_FAILED } from "../plugins/routes";
import {
  BotNotDrivableError,
  CatalogueEntryUnknownError,
  PluginNeedsApprovalError,
  PluginRefusedError,
  type PluginStore,
} from "../plugins/store";
import { RoutineError } from "../routines/errors";
import type { RoutineService } from "../routines/service";
import type { RoutineSchedule } from "../routines/schedule";
import type { LoopExecutor, LoopOutcome } from "../runner/turn-loop";
import { awaitApproval, type PersonAnswers } from "./people";

export type ChatToolsDeps = {
  /** Absent when no computer is configured; its tools are then not offered. */
  gateway?: ComputerGateway;
  pluginStore?: Pick<PluginStore, "listForAgent" | "callTool" | "viewSkill">;
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
  auditStore?: AuditStore;
  /** How long a person may take over a help request. The window's own ten minutes by default. */
  personWaitMs?: number;
  /** How often a help request looks at whether the wheel came back. */
  controlPollMs?: number;
};

/** Whose turn it is and where: what every call is carried out as. */
export type ChatTurnContext = {
  botId: string;
  owner: AgentActor;
  threadId: string;
  /** The turn's run: who holds a question it raises. */
  runId: string;
};

export type ChatToolkit = { tools: Tool[]; execute: LoopExecutor };

/** Human-assistance wait window. Long enough for a person to come back, finite so the run can end. */
const WAIT_FOR_PERSON_MS = 10 * 60_000;
const CONTROL_POLL_MS = 1_000;

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
  return computerReplyOutcome(
    200,
    overJson((result ?? {}) as Record<string, unknown>),
  );
}

/** The names of every tool this file can carry out for one Bot, right now. */
async function executableNames(
  deps: ChatToolsDeps,
  botId: string,
): Promise<{
  names: Set<string>;
  pluginRefs: Map<string, string>;
  pluginTools: Tool[];
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
  if (deps.pluginStore) {
    names.add(SKILL_VIEW.name);
    const granted = await deps.pluginStore
      .listForAgent(botId)
      .catch(() => ({ tools: [], skills: [] }));
    for (const tool of granted.tools) {
      names.add(tool.toolName);
      pluginRefs.set(tool.toolName, tool.ref);
      pluginTools.push({
        name: tool.toolName,
        description: tool.description,
        parameters: tool.inputSchema,
      });
    }
  }
  if (deps.components) {
    const held = await deps.components.listForAgent(botId).catch(() => []);
    for (const component of held) names.add(component.name);
  }
  return { names, pluginRefs, pluginTools };
}

/**
 * The tools a turn offers when its window declared none: the ones this server can describe on its
 * own. The gallery's cards are not among them — their schemas live in the page.
 */
function serverTools(
  deps: ChatToolsDeps,
  pluginTools: Tool[],
  effort: boolean,
): Tool[] {
  const profile = effort ? UPDATE_PROFILE : UPDATE_PROFILE_WITHOUT_EFFORT;
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
            name: profile.name,
            description: profile.description,
            parameters: profile.parameters,
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
  return async (
    context: ChatTurnContext,
    declared: readonly Tool[] | null,
    options: { effort?: boolean } = {},
  ): Promise<ChatToolkit> => {
    const { botId, owner, threadId, runId } = context;
    const { names, pluginRefs, pluginTools } = await executableNames(
      deps,
      botId,
    );
    const tools = declared
      ? declared.filter((tool) => names.has(tool.name))
      : serverTools(deps, pluginTools, options.effort !== false);
    if (declared) {
      const dropped = declared
        .filter((tool) => !names.has(tool.name))
        .map((tool) => tool.name);
      if (dropped.length > 0) {
        // Names, never arguments: what a window offered that nothing here would carry out.
        log.info("chat_tools_not_offered", { bot: botId, tools: dropped });
      }
    }
    const holder = `turn:${runId}`;
    const personWaitMs = deps.personWaitMs ?? WAIT_FOR_PERSON_MS;

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
      const waited = await awaitApproval(deps.approvals ?? noRegistry, {
        botId,
        approvalId: pause.approvalId,
        holder,
        signal,
      });
      if (waited.answer === "granted") {
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

    /** Hold a call open until the wheel or the secret box is back with the Bot, or it runs out. */
    const waitForPerson = async (
      toolCallId: string,
      signal: AbortSignal,
      done: (state: Record<string, unknown>) => boolean,
    ): Promise<"answered" | "gave up" | "cancelled" | "skipped"> => {
      const deadline = Date.now() + personWaitMs;
      while (Date.now() < deadline) {
        if (signal.aborted) return "cancelled";
        // Read before the computer: a skip also hands back, which the computer reports as done.
        if (deps.people.takeSkip(toolCallId)) return "skipped";
        const state = await deps.gateway?.control(botId).catch(() => null);
        if (state && done(state as unknown as Record<string, unknown>)) {
          return "answered";
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
              ),
            navigationOutcome,
          );
        case "computer_read":
          try {
            return computerReply(
              await gateway.read(botId, {
                whole: args.whole === true,
                ...(typeof args.from === "string" && args.from.trim()
                  ? { from: args.from.trim() }
                  : {}),
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
          if (typeof args.index !== "number") return invalidArguments();
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
        case "computer_list_files":
          return governed(signal, (approvalId) =>
            gateway.listFiles(
              c,
              botId,
              actor,
              typeof args.path === "string" ? { path: args.path } : {},
              approvalId,
            ),
          );
        case "computer_read_file": {
          const input = readFileInputOf(args);
          if (!input) return invalidArguments();
          return governed(signal, (approvalId) =>
            gateway.readFile(c, botId, actor, input, approvalId),
          );
        }
        case "computer_write_file": {
          if (
            typeof args.path !== "string" ||
            typeof args.contents !== "string"
          ) {
            return invalidArguments();
          }
          const file = {
            path: args.path,
            contents: args.contents,
            append: args.append === true,
          };
          return governed(signal, (approvalId) =>
            gateway.writeFile(c, botId, actor, file, approvalId),
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
          // Resolved when the wheel is back with the Bot and no help request remains outstanding.
          const outcome = await waitForPerson(
            call.id,
            signal,
            (state) => state.holder === "bot" && !state.requested,
          );
          const code =
            outcome === "answered"
              ? "laf:control_returned"
              : outcome === "skipped"
                ? "laf:help_skipped"
                : outcome === "cancelled"
                  ? "laf:request_cancelled"
                  : "laf:nobody_took_control";
          return { ok: true, code, result: toolResultText(code) };
        }
        case "computer_request_secret": {
          const target = asRef(args);
          if (!target) return invalidArguments();
          const asked = await governed(signal, () =>
            gateway.requestSecret(c, botId, actor, {
              label:
                typeof args.label === "string" && args.label.trim()
                  ? args.label.trim()
                  : "the value this page is asking for",
              ...target,
            }),
          );
          if (!asked.ok) return asked;
          // Completion is `secretWanted` clearing; the value never returns to the model.
          const outcome = await waitForPerson(
            call.id,
            signal,
            (state) => state.secretWanted === undefined,
          );
          const code =
            outcome === "answered"
              ? "laf:secret_entered"
              : outcome === "skipped"
                ? "laf:secret_skipped"
                : outcome === "cancelled"
                  ? "laf:request_cancelled"
                  : "laf:secret_not_entered";
          return { ok: true, code, result: toolResultText(code) };
        }
        default:
          return refusal("laf:tool_unknown");
      }
    };

    /** A call to somebody else's server, as `callPluginTool` in the app answered it: a sentence. */
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
          // Somebody may be in front of this call — a window of the conversation, or later the
          // transcript — so a code withheld from a mail is kept to be shown on its line.
          watched: true,
        });
      const said = (result: { text: string; isError: boolean }) =>
        result.isError
          ? `The tool reported an error: ${result.text}`
          : result.text;
      try {
        return said(await send());
      } catch (error) {
        if (call.signal.aborted) return toolResultText("laf:stopped");
        if (!(error instanceof PluginNeedsApprovalError)) {
          return pluginFailure(error, ref);
        }
        const waited = await awaitApproval(deps.approvals ?? noRegistry, {
          botId,
          approvalId: error.approvalId,
          holder,
          signal: call.signal,
        });
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
      if (args.effort !== undefined) patch.effort = args.effort;
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
     * A card the Bot put on screen: allowed for this Bot, reading only what it was granted.
     * `decideComponent` in the app asked exactly this, of the same store.
     */
    const component = async (
      name: string,
      args: Record<string, unknown>,
      call: { id: string; signal: AbortSignal },
    ): Promise<LoopOutcome> => {
      const store = deps.components;
      if (!store) return refusal("laf:tool_unknown");
      const refuse = async (reason: string, extra: Record<string, unknown>) => {
        if (deps.auditStore) {
          await recordAuditEvent(deps.auditStore, {
            eventType: extra.function
              ? "component.function_refused"
              : "component.refused",
            targetType: "component",
            targetId: name,
            ...(owner.id === DEV_ACTOR.id ? {} : { actorUserId: owner.id }),
            payload: { actor: owner.id, bot: botId, reason, ...extra },
          }).catch(() => {});
        }
        return reason.startsWith("laf:") ? toolResultText(reason) : reason;
      };
      const decision = await store.decide(name, botId).catch(() => null);
      if (!decision) {
        return "This deployment could not be asked whether that card is allowed, so it was not shown.";
      }
      if (!decision.allowed) {
        return refuse(String(decision.reason ?? ""), {});
      }
      for (const functionName of galleryReads(name, args)) {
        if (await store.mayCall(name, functionName)) continue;
        return refuse(FUNCTION_NOT_GRANTED, { function: functionName });
      }
      if (!GALLERY_DECISIONS.has(name)) {
        return GALLERY_CONFIRMATIONS[name] ?? ON_SCREEN;
      }
      /*
       * A QUESTION TO THE PERSON: the card is drawn from the call, and its answer is the result.
       * The window's card answered its own run through CopilotKit; the server waits for the same
       * answer from whichever window the person presses it in (`routes.ts`, answers).
       */
      const answered = await deps.people.wait({
        threadId,
        toolCallId: call.id,
        signal: call.signal,
        timeoutMs: personWaitMs,
      });
      if (!answered.answered) {
        return call.signal.aborted
          ? toolResultText("laf:stopped")
          : toolResultText("laf:nobody_answered");
      }
      const value = answered.value;
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
        return await component(name, args, call);
      } catch (error) {
        /*
         * CopilotKit's rule for a handler that threw: the call is answered, and the answer says it
         * failed. Never the error's own words beyond its message — a Drizzle failure's message
         * carries its SQL and parameters (`failure-text.ts`).
         */
        log.error("chat_tool_threw", {
          tool: name,
          reason: describeFailure(error),
        });
        return `Error: ${describeFailure(error)}`;
      }
    };

    return { tools, execute };
  };
}

/** No registry configured: every question is gone the moment it is asked about. */
const noRegistry: Pick<ApprovalRegistry, "hold" | "withdraw"> = {
  hold: async () => ({ ok: false }),
  withdraw: async () => undefined,
};

/** A plugin call's failure as the app's `sendCall` read the route's reply: a sentence. */
function pluginFailure(error: unknown, ref: string): string {
  if (
    error instanceof PluginRefusedError ||
    error instanceof BotNotDrivableError ||
    error instanceof CatalogueEntryUnknownError
  ) {
    const code = (error as { code?: string }).code ?? "";
    return code.startsWith("laf:")
      ? toolResultText(code)
      : "That tool is not allowed here.";
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
