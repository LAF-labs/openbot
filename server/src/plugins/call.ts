import { and, eq } from "drizzle-orm";
import { recordAuditEvent } from "../audit";
import { fingerprintOf } from "../computer/approvals";
import { evaluateActionPolicy, type PolicyContext } from "../computer/policy";
import { allowanceFor, scopeKeyOf } from "../computer/standing-approvals";
import { mcpTools } from "../db/schema";
import { type CatalogueEntry, classifyTool } from "./catalogue";
import type { Connections } from "./connections";
import {
  classifyDeclaredTool,
  guardQuestion,
  type LafGuard,
  type ToolAnnotations,
} from "./laf-contract";
import { effectiveUrl, type Servers } from "./servers";
import type { SkillsAndGrants } from "./skills-and-grants";
import {
  type PluginContext,
  PluginNeedsApprovalError,
  PluginRefusedError,
  toolNameFor,
} from "./store";
import { transportFor } from "./transport";

/**
 * The one path a tool call takes: decide, record, act.
 *
 * That order is the whole point of this module being its own. A call that was permitted and then
 * failed is exactly what an investigation needs to see, and a trail written only on success cannot
 * show it — so the row goes down once, after the outcome exists, and never before the attempt.
 */

/**
 * Whose credential reaches this server, as the trail names it.
 *
 * One definition, because two expressions for one fact can disagree, and the one place that would
 * show is an audit row claiming a call ran as somebody it did not — which is the row a per-person
 * connector exists to be able to trust.
 *
 * `deployment` for a shared token; the asker's own id for a server reached as the person asking.
 */
const reachedAsFor = (entry: CatalogueEntry | null, actorId: string): string =>
  entry?.auth.kind === "user-oauth" ? actorId : "deployment";

/**
 * Optional arguments the model filled in with an empty string, removed.
 *
 * A model handed a schema with many optional fields tends to fill them all, and where it has no
 * value it writes "". Vendors reject that: an empty string is not a channel id, not a timestamp and
 * not a cursor, so the call fails with a validation error that reads to the person as the tool being
 * broken.
 *
 * Only optional fields, and only empty strings. A required field left empty is the model getting it
 * wrong, and the vendor should say so rather than have us hide it. Anything other than "" is a value
 * the model meant, including false and 0.
 */
function withoutEmptyOptionals(
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const required = new Set(
    Array.isArray(schema?.required) ? (schema.required as string[]) : [],
  );
  return Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) => required.has(key) || value !== "",
    ),
  );
}

export function createCallPath(
  context: PluginContext,
  servers: Servers,
  connections: Connections,
  grants: SkillsAndGrants,
) {
  const { database, auditStore, options } = context;

  /**
   * Spend a person's answer on this call, or stop and ask them.
   *
   * The fingerprint covers the arguments as well as the tool, which is the difference between this
   * and the browser actions. A click is identified by the thing it lands on; a call to somebody
   * else's server is identified by what it says, and an approval for "post the release note in the
   * team channel" that could be spent on any other message to any other channel would be a
   * confirmation prompt wearing a governance feature's clothes.
   *
   * Returns who allowed it. Throws when nobody has, which every unsuccessful presentation counts as:
   * an expired id, one already spent, a No being replayed and an approval given for a different call
   * all mean that nobody has agreed to THIS, and asking again is both the safe answer and the one a
   * person can act on.
   */
  async function askAbout(question: {
    approvalId: string | undefined;
    botId: string;
    actorId: string;
    ref: string;
    serverId: string;
    toolName: string;
    effect: "read" | "write";
    args: Record<string, unknown>;
    rule: string;
    question: string;
  }): Promise<string> {
    const fingerprint = fingerprintOf({
      botId: question.botId,
      toolName: toolNameFor(question.ref),
      arguments: question.args,
    });
    const presented = question.approvalId
      ? await options.approvals.consume(question.approvalId, fingerprint)
      : undefined;
    // An approval with nobody's name on it asks again rather than being credited to whoever was
    // driving the Bot, which is the one attribution this record must never make.
    if (presented?.ok && presented.approval.answeredBy) {
      return presented.approval.answeredBy;
    }

    /*
     * A call to somebody else's server has no host and no path, only a name, so an allowance here is
     * always about the tool. Note what that widens: the approval it stands in for is bound to the
     * arguments — see the fingerprint above — and this is not. It is the broadest grant this product
     * can produce from one button, which is why the button says the tool's name out loud.
     */
    const allowance = allowanceFor({ tool: question.ref });
    // The same switch the computer's gateway reads, and it does the same two things here: nothing
    // standing is honoured, and the question goes out without a scope so there is nothing to grant.
    const mayStand =
      (options.policy()?.settleWithoutAsking ?? "allowed") === "allowed";
    const already = mayStand
      ? await options.standing?.find(
          question.botId,
          question.rule,
          scopeKeyOf(allowance),
        )
      : undefined;
    if (already) return already.grantedBy;

    const pending = await options.approvals.request({
      botId: question.botId,
      actor: question.actorId,
      rule: question.rule,
      question: question.question,
      fingerprint,
      ...(mayStand ? { scope: allowance } : {}),
      // Filed against the tool, so the answer's row lands beside the call's own row rather than
      // under whichever surface the person happened to press the button on.
      target: { type: "mcp_tool", id: question.ref },
    });
    await recordAuditEvent(auditStore, {
      eventType: "approval.requested",
      targetType: "mcp_tool",
      targetId: question.ref,
      payload: {
        bot: question.botId,
        actor: question.actorId,
        approval: pending.id,
        rule: pending.rule,
        reason: pending.question,
        server: question.serverId,
        tool: question.toolName,
        effect: question.effect,
      },
    });
    throw new PluginNeedsApprovalError(pending);
  }

  return {
    /**
     * Call a tool on somebody else's server, on a Bot's behalf.
     *
     * Decide, record, then act, which is the order the computer gateway uses and for the same
     * reason: a call that was permitted and then failed is exactly what an investigation needs to
     * see, and a trail written only on success cannot show it. The grant is checked first because a
     * tool this Bot was never given should not reach the policy engine, the vault or the network.
     */
    async callTool(input: {
      ref: string;
      args: Record<string, unknown>;
      botId: string;
      actorId: string;
      /**
       * An answer a person already gave, presented for the call it was given for.
       *
       * The same contract the acting routes on the computer have, and for the same reason: the id
       * alone proves nothing, it is the id together with the fingerprint of the call actually being
       * made that means anything.
       */
      approvalId?: string | undefined;
    }): Promise<{ text: string; isError: boolean }> {
      const [serverId, ...rest] = input.ref.split("/");
      const toolName = rest.join("/");
      if (!serverId || !toolName) {
        throw new PluginRefusedError(`${input.ref} is not a tool.`, null);
      }

      const decision = await grants.decide("mcp", input.ref, input.botId);
      if (!decision.allowed) {
        await recordAuditEvent(auditStore, {
          eventType: "mcp.call_rejected",
          targetType: "mcp_tool",
          targetId: input.ref,
          payload: {
            actor: input.actorId,
            bot: input.botId,
            server: serverId,
            tool: toolName,
            refusal: "not_granted",
            reason: decision.reason,
          },
        });
        throw new PluginRefusedError(decision.reason, null);
      }

      const { row, entry } = await servers.requireServer(serverId);

      const advertised = await database
        .select({
          name: mcpTools.name,
          inputSchema: mcpTools.inputSchema,
          annotations: mcpTools.annotations,
          needsReview: mcpTools.needsReview,
        })
        .from(mcpTools)
        .where(
          and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)),
        )
        .limit(1);

      /*
       * A definition that changed after consent does not get to run on the old
       * consent. Refused before the policy is even asked, because no rule an
       * operator wrote was written about the tool as it now is.
       */
      if (advertised[0]?.needsReview) {
        await recordAuditEvent(auditStore, {
          eventType: "mcp.call_rejected",
          targetType: "mcp_tool",
          targetId: input.ref,
          payload: {
            actor: input.actorId,
            bot: input.botId,
            server: serverId,
            tool: toolName,
            refusal: "needs_review",
          },
        });
        throw new PluginRefusedError(
          `'${toolName}' changed its definition since it was approved. Review it under Plugins before it runs again.`,
          null,
        );
      }

      /*
       * Custom servers are classified by their own declaration (the LAF
       * contract), because the definition the declaration lives in is pinned
       * by hash above. Curated servers keep the reviewed catalogue's word.
       * The guard is the contract's floor: for money, external, destructive
       * and undeclared tools, a person answers for the exact call, every
       * time, whatever the written policy says short of deny.
       */
      const declared =
        entry === null && advertised.length > 0
          ? classifyDeclaredTool(advertised[0]?.annotations as ToolAnnotations)
          : null;
      const effect = declared
        ? declared.effect
        : classifyTool(entry, toolName, advertised.length > 0);
      // Three-way on purpose: a declared guard of null means "no floor", which
      // `??` would silently promote to the harshest floor there is.
      const guard: LafGuard | null =
        entry !== null ? null : declared ? declared.guard : "unannotated";

      const args = withoutEmptyOptionals(
        input.args,
        advertised[0]?.inputSchema as Record<string, unknown> | undefined,
      );

      /**
       * The same policy the computer actions are judged by, asked about a tool call.
       *
       * Every field is present, including the ones a tool call has no use for, and that is load
       * bearing rather than tidy. This engine treats an expression it cannot evaluate as a match,
       * which is correct for a browser action on an element the server could not resolve. Applied to
       * a tool call it is a disaster: the boundary this product ships in `.env.example` denies
       * `contains(element.name, "submit") || key == "Enter"`, and with `element` and `key` absent
       * that rule is unevaluable, so it would match, so every deployment using the shipped preset
       * would refuse every MCP call for a reason mentioning a submit button.
       *
       * Neutral values instead. Empty strings match no substring, no key and no extension, and
       * `submit` is false because a tool call submits no form, so a rule written about the browser
       * evaluates to false against a tool call, which is the honest answer: a tool call did not click
       * anything. A rule meant to catch tool calls says so, with `mcp` or with `intent`.
       *
       * The blanks are for the policy engine and never for a person: the sentence a question is
       * phrased in reads them as absent rather than as an empty file path, or somebody would be
       * asked to approve "The Bot wants to call ."
       */
      const policyContext: PolicyContext = {
        tool: { name: toolNameFor(input.ref) },
        bot: { id: input.botId },
        actor: { id: input.actorId },
        page: { url: "", host: "" },
        // One, for the same reason as the empty strings, and with a cost worth naming: repetition is
        // counted by the computer gateway, and nothing counts a Bot calling the same MCP tool over
        // and over. A rule about repetition is therefore false here rather than unevaluable, which
        // keeps a browser rule from refusing every tool call, and leaves a Bot looping through
        // somebody else's server as a gap this deployment cannot yet see.
        repeat: { count: 1 },
        element: { ref: "", role: "", name: "", type: "" },
        key: "",
        submit: false,
        file: { path: "", name: "", extension: "" },
        intent: effect === "write" ? "write_tool" : "read_tool",
        mcp: { server: serverId, tool: toolName, effect },
      };

      const verdict = evaluateActionPolicy(options.policy(), policyContext);

      /**
       * The third answer, handled here as well as on the computer.
       *
       * An `ask` verdict is `forward: false` in enforce mode, so a call site that knows only about
       * yes and no reads it as a refusal, and the list an operator wrote to be asked about silently
       * becomes a list of things their Bots may never do. That is the exact failure the ask list
       * exists to prevent, and it is worse here than it looks: the boundary editor and the shipped
       * configuration both offer `ask` as a general third list, and "ask me before anything changes
       * anything in Jira" is the first rule most deployments reach for.
       *
       * So the same shape as the gateway: spend an approval that fits this exact call, or open the
       * question and stop. Nothing is recorded as succeeded or rejected in the second case, because
       * neither happened yet.
       */
      const policyAsks = verdict.source === "ask" && !verdict.forward;
      // The contract floor: the policy allowed it, and a person still answers.
      // A deny stays a deny — the floor never softens the written boundary.
      const floorAsks = guard !== null && verdict.forward;
      const approved =
        policyAsks || floorAsks
          ? await askAbout({
              approvalId: input.approvalId,
              botId: input.botId,
              actorId: input.actorId,
              ref: input.ref,
              serverId,
              toolName,
              effect,
              args,
              rule: policyAsks ? (verdict.matched ?? "") : `laf:${guard}`,
              question: policyAsks
                ? verdict.reason
                : guardQuestion(guard as LafGuard, toolName),
            })
          : undefined;

      // What the boundary settled on once a person's answer is folded in. The source stays `ask`, so
      // the row reads as "allowed, because somebody was asked and said yes" rather than as an
      // ordinary permission nobody ever questioned.
      const carriedOut =
        policyAsks || floorAsks ? approved !== undefined : verdict.forward;

      /*
       * The parts of the row that are known before the attempt, held rather than written.
       *
       * Everything here is a fact about the decision, and the decision is final at this point. What
       * is NOT yet known is whether the call worked, which is why this is a variable and not a
       * write: the row goes down once, after the outcome exists.
       */
      const decided = {
        actor: input.actorId,
        bot: input.botId,
        server: serverId,
        tool: toolName,
        effect,
        /*
         * Whose credential this call goes out with.
         *
         * Without it the trail cannot answer "who did this run reach as", which is the whole
         * question a per-person connector raises — two rows for the same tool and the same Bot can
         * legitimately have seen entirely different documents, and nothing else in the row says
         * why.
         */
        reachedAs: reachedAsFor(entry, input.actorId),
        decision: {
          allowed: verdict.allowed || approved !== undefined,
          mode: verdict.mode,
          rule: verdict.matched,
          source: verdict.source,
          carriedOut,
          ...(approved ? { approvedBy: approved } : {}),
        },
      };

      /*
       * A refusal is written here, because there is no attempt to wait for. This deployment
       * declining is the whole event, and it is recorded before the throw so that a refusal cannot
       * be lost by the caller's error handling.
       */
      if (!carriedOut) {
        await recordAuditEvent(auditStore, {
          eventType: "mcp.call_rejected",
          targetType: "mcp_tool",
          targetId: input.ref,
          payload: decided,
        });
        throw new PluginRefusedError(verdict.reason, verdict.matched);
      }

      /*
       * Attempt first, record second.
       *
       * The row then says what HAPPENED rather than what was permitted. Written before the attempt,
       * a call that died at the vendor left `call_succeeded` behind it — and a per-person connector
       * fails at exactly these lines: no connection for the asker, a refresh token the vendor no
       * longer accepts, an API not enabled for the project. Every one of those was invisible, and
       * worse than invisible, because the trail asserted the opposite.
       *
       * `isError` counts as a failure. A vendor that answers the protocol correctly to say the tool
       * itself failed has not completed the call, and a reader counting successes should not be
       * told it did.
       */
      try {
        const { token } = await connections.connectionTokenFor(
          row,
          entry,
          input.actorId,
        );
        const vendor = context.injectedVendor ?? transportFor(entry).callTool;
        const result = await vendor(
          {
            url: effectiveUrl(row, entry),
            token,
            actorId: input.actorId,
            botId: input.botId,
          },
          toolName,
          args,
        );
        await recordAuditEvent(auditStore, {
          eventType: result.isError ? "mcp.call_failed" : "mcp.call_succeeded",
          targetType: "mcp_tool",
          targetId: input.ref,
          /*
           * The vendor's own words, when it is reporting a failure — and only then. A successful
           * result is somebody's data and has no business in an audit row; an `isError` result is a
           * message written for whoever operates this deployment, and it is the most useful
           * sentence available. Capped, because the failure branch is not a promise about length.
           */
          payload: result.isError
            ? {
                ...decided,
                failure:
                  result.text.slice(0, 400) || "the tool reported an error",
              }
            : decided,
        });
        return { text: result.text, isError: result.isError };
      } catch (error) {
        /*
         * Recorded, then rethrown unchanged. The caller's behaviour is unaffected — what changes is
         * that the failure now exists in the trail, which is where somebody asking "is this
         * connector working" looks. The vendor's own sentence is kept, since for a 403 that is the
         * sentence naming which API is not enabled.
         */
        await recordAuditEvent(auditStore, {
          eventType: "mcp.call_failed",
          targetType: "mcp_tool",
          targetId: input.ref,
          payload: {
            ...decided,
            failure: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 400),
          },
        });
        throw error;
      }
    },
  };
}

export type CallPath = ReturnType<typeof createCallPath>;
