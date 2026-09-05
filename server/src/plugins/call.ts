import { and, eq } from "drizzle-orm";
import { recordAuditEvent, TOOL_REPORTED_ERROR } from "../audit";
import type { AskSubject } from "../computer/approvals";
import { fingerprintOf } from "../computer/approvals";
import {
  evaluateActionPolicy,
  type PolicyContext,
  type PolicyDecision,
} from "../computer/policy";
import { type SettleResult, settle } from "../computer/settle";
import { allowanceFor } from "../computer/standing-approvals";
import { mcpTools } from "../db/schema";
import { type CatalogueEntry, classifyTool } from "./catalogue";
import type { Connections } from "./connections";
import {
  classifyDeclaredTool,
  type LafGuard,
  type ToolAnnotations,
} from "./laf-contract";
import { McpRedirectRefusedError } from "./mcp";
import { effectiveUrl, type Servers } from "./servers";
import type { SkillsAndGrants } from "./skills-and-grants";
import {
  type PluginContext,
  PluginNeedsApprovalError,
  PluginRefusedError,
  toolNameFor,
} from "./store";

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
 *
 * A PARTNER ENTRY IS THE SECOND KIND, and reading it off `auth.kind` alone said the opposite. The
 * key spent is LAF's, so `auth` is not `user-oauth` and this returned "deployment" — but the message
 * leaves the person's OWN 카카오톡 채널. A row saying "deployment" about a message that went out as
 * somebody's shop is the one lie a per-person connector's trail cannot afford.
 */
const reachedAsFor = (entry: CatalogueEntry | null, actorId: string): string =>
  entry?.auth.kind === "user-oauth" || entry?.partner ? actorId : "deployment";

/** What a settled question hands back when the call may go ahead. See `computer/settle.ts`. */
type SettledAllowed = Extract<SettleResult, { outcome: "allowed" }>;

/**
 * What is about to happen, as the facts a person is shown.
 *
 * The guard travels rather than a sentence about it: `guardQuestion` in `laf-contract.ts` wrote four
 * Korean sentences into the same field the browser path filled with English ones, so one field held
 * two languages depending on which subsystem had stopped (docs/laf/redesign-2026-09.md §3.1). Both
 * paths now send the facts and the surface writes the sentence.
 */
function askSubjectOf(input: {
  serverId: string;
  toolName: string;
  guard: LafGuard | null;
  /** The expression that asked, to tell a question about repetition from any other. */
  matched: string | null;
  repeatCount: number;
  floorAsks: boolean;
}): AskSubject {
  const reason: AskSubject["reason"] = input.floorAsks
    ? // A tool that declared nothing is its own reason: what is wrong is not what it does but that
      // it did not say, and a person deciding needs to be told which of those they are looking at.
      input.guard === "unannotated"
      ? "unannotated"
      : "guard_floor"
    : input.matched !== null && /\brepeat\s*\./.test(input.matched)
      ? "repeat"
      : "policy_ask";
  return {
    kind: "tool",
    intent: "call_tool",
    tool: {
      server: input.serverId,
      name: input.toolName,
      ...(input.guard ? { guard: input.guard } : {}),
    },
    ...(reason === "repeat" ? { repeatCount: input.repeatCount } : {}),
    reason,
  };
}

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
   * THE SEQUENCE IS NOT HERE ANY MORE. It is in `computer/settle.ts`, and this hands it the two
   * things only this path knows: what the fingerprint is taken over, and whether the contract's
   * floor is asking. The gateway's copy and this one differed in ways nobody had decided — no
   * auto-review here, and a repeat count nailed to one — because they were two sequences that had to
   * be kept in agreement by hand (docs/laf/redesign-2026-09.md §3.1, §5.1(c)).
   *
   * The fingerprint covers the arguments as well as the tool, which is the difference between this
   * and the browser actions. A click is identified by the thing it lands on; a call to somebody
   * else's server is identified by what it says, and an approval for "post the release note in the
   * team channel" that could be spent on any other message to any other channel would be a
   * confirmation prompt wearing a governance feature's clothes.
   *
   * Returns HOW it was allowed, never a bare yes: by a person, by an allowance they granted for the
   * tool, or by the Bot's own instruction with nobody looking — three different amounts of attention,
   * and the row below has to be able to say which. Throws when a person is being asked, which every
   * unsuccessful presentation counts as: an expired id, one already spent, a No being replayed and
   * an approval given for a different call all mean that nobody has agreed to THIS.
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
    subject: AskSubject;
    verdict: PolicyDecision;
    forcedAsk: boolean;
  }): Promise<SettledAllowed> {
    const settled = await settle(
      {
        botId: question.botId,
        actorId: question.actorId,
        subject: question.subject,
        action: question.ref,
        fingerprint: fingerprintOf({
          botId: question.botId,
          toolName: toolNameFor(question.ref),
          arguments: question.args,
        }),
        /*
         * A call to somebody else's server has no host and no path, only a name, so an allowance
         * here is always about the tool. Note what that widens: the approval it stands in for is
         * bound to the arguments and this is not. It is the broadest grant this product can produce
         * from one button, which is why the button says the tool's name out loud.
         */
        allowance: allowanceFor({ tool: question.ref }),
        rule: question.rule,
        // Filed against the tool, so the answer's row lands beside the call's own row rather than
        // under whichever surface the person happened to press the button on.
        target: { type: "mcp_tool", id: question.ref },
        ...(question.approvalId
          ? { presentedApprovalId: question.approvalId }
          : {}),
        policyVerdict: question.verdict,
        forcedAsk: question.forcedAsk,
      },
      {
        policy: options.policy,
        approvals: options.approvals,
        standing: options.standing,
        autoReview: options.autoReview,
      },
    );

    if (settled.outcome === "refused") {
      await recordAuditEvent(auditStore, {
        eventType: "mcp.call_rejected",
        targetType: "mcp_tool",
        targetId: question.ref,
        payload: {
          bot: question.botId,
          actor: question.actorId,
          server: question.serverId,
          tool: question.toolName,
          effect: question.effect,
          refusal: settled.code,
          rule: question.rule,
        },
      });
      throw new PluginRefusedError(settled.code, question.rule || null);
    }

    if (settled.outcome === "allowed") return settled;

    await recordAuditEvent(auditStore, {
      eventType: "approval.requested",
      targetType: "mcp_tool",
      targetId: question.ref,
      payload: {
        bot: question.botId,
        actor: question.actorId,
        approval: settled.approvalId,
        rule: settled.approval.rule,
        // The facts, not a sentence: the card is Korean, the trail is queried, and one field cannot
        // be both. See AskSubject.
        subject: settled.approval.subject,
        server: question.serverId,
        tool: question.toolName,
        effect: question.effect,
        // An empty reason is the judge having failed rather than having decided, and the two are
        // said differently — the same distinction the computer's own row makes.
        ...(settled.autoReview
          ? {
              autoReview: settled.autoReview.reason
                ? `declined: ${settled.autoReview.reason}`
                : "could not be reached",
            }
          : {}),
      },
    });
    throw new PluginNeedsApprovalError(settled.approval);
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
      /*
       * Three-way on purpose: a declared guard of null means "no floor", which
       * `??` would silently promote to the harshest floor there is.
       *
       * A CURATED entry gets its floor from the reviewed catalogue rather than
       * from annotations, and the direction matters. A custom server declares
       * its own risk and is believed because the declaration is pinned by hash;
       * a vendor's remote server declares whatever it likes, and letting that
       * decide would let Gmail tell us that sending mail is read-only. So
       * `guardedTools` is this repository's word about somebody else's product,
       * and it is the only word here — which is why the REST adapters carry no
       * annotations of their own to disagree with it.
       */
      const guard: LafGuard | null =
        entry !== null
          ? (entry.guardedTools?.[toolName] ?? null)
          : declared
            ? declared.guard
            : "unannotated";

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
      /*
       * COUNTED, AT LAST, AND BY THE SAME COUNTER THE BROWSER USES.
       *
       * This was `repeat: { count: 1 }` with a comment admitting the gap: nothing counted a Bot
       * calling the same tool on somebody else's server over and over, so `repeat.count >= 5` — a
       * rule this deployment ships by default — was false here on every call, however many times a
       * stuck model made it. The detector keys on the tool plus the thing it acted on
       * (`computer/repeat.ts`), and for a tool call the thing acted on is the tool itself: the
       * arguments are deliberately not in the key there, for the same reason typed text is not.
       *
       * Absent leaves a count of one, which is what a rule about repetition reads as a first
       * attempt — a number nobody can substantiate must never be the reason a Bot is refused.
       */
      const repetition = options.repeat
        ? await options.repeat.observe(input.botId, {
            tool: toolNameFor(input.ref),
            ref: input.ref,
          })
        : { count: 1, fingerprint: null, threshold: null };

      if (repetition.threshold !== null && repetition.fingerprint) {
        /*
         * Ahead of the decision row, so the trail reads in the order the thing happened: this was
         * the tenth identical call, and this is what the boundary did about it. The gateway files
         * `computer.action_repeated` the same way round and for the same reason.
         *
         * Its failure is swallowed, which nothing else on this path does. The row is an observation
         * and an observation may not refuse anything: a lost insert here would stop every third,
         * tenth and twenty-fifth identical call before the policy had even been asked. Nothing is
         * weakened, because the decision row goes to the same store a few lines below and a store
         * that is genuinely down refuses the call there.
         */
        try {
          await recordAuditEvent(auditStore, {
            eventType: "mcp.call_repeated",
            targetType: "mcp_tool",
            targetId: input.ref,
            payload: {
              action: toolNameFor(input.ref),
              bot: input.botId,
              actor: input.actorId,
              server: serverId,
              tool: toolName,
              effect,
              fingerprint: repetition.fingerprint,
              count: repetition.count,
            },
          });
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "mcp-repeat-row-lost",
              bot: input.botId,
              fingerprint: repetition.fingerprint,
              count: repetition.count,
              error: String(error),
            }),
          );
        }
      }

      const policyContext: PolicyContext = {
        tool: { name: toolNameFor(input.ref) },
        bot: { id: input.botId },
        actor: { id: input.actorId },
        page: { url: "", host: "" },
        repeat: { count: repetition.count },
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
      /*
       * The rule the question is filed under, and it is what a standing allowance is keyed on.
       *
       * `laf:<guard>` for a floor, because there is no written expression to name: a person who
       * presses "always allow this tool" on a money guard is answering the floor, and rewriting the
       * boundary must not silently withdraw that. Unchanged from what this path already did.
       */
      const rule = policyAsks ? (verdict.matched ?? "") : `laf:${guard}`;
      const settled =
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
              rule,
              subject: askSubjectOf({
                serverId,
                toolName,
                guard,
                matched: verdict.matched,
                repeatCount: repetition.count,
                floorAsks,
              }),
              verdict,
              forcedAsk: floorAsks,
            })
          : undefined;

      // What the boundary settled on once a person's answer is folded in. The source stays `ask`, so
      // the row reads as "allowed, because somebody was asked and said yes" rather than as an
      // ordinary permission nobody ever questioned.
      const carriedOut =
        policyAsks || floorAsks ? settled !== undefined : verdict.forward;

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
          allowed: verdict.allowed || settled !== undefined,
          rule: verdict.matched,
          source: verdict.source,
          carriedOut,
          ...(settled?.approvedBy ? { approvedBy: settled.approvedBy } : {}),
          /*
           * WHICH KIND OF YES, structured, the way the computer's own rows have said it since
           * allowances existed. A person pressing Allow, an allowance they granted for this tool
           * last week and the Bot's own instruction are three different amounts of attention, and
           * this path could only report the first — so an allowance quietly waving calls through
           * read on the row exactly like somebody having looked at each one.
           */
          ...(settled?.allowance
            ? {
                allowance: settled.allowance.id,
                allowanceScope: settled.allowance.scope,
              }
            : {}),
          ...(settled?.autoReviewed
            ? { autoReviewed: settled.autoReviewed.reason }
            : {}),
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
          payload: { ...decided, refusal: verdict.code ?? "laf:policy_denied" },
        });
        // The code, not a sentence: the model reads Korean out of
        // `shared/prompt/tool-results.ko.ts` and the person reads Korean out of the dictionary.
        throw new PluginRefusedError(
          verdict.code ?? "laf:policy_denied",
          verdict.matched,
        );
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
        const vendor =
          context.injectedVendor ?? context.transportFor(entry).callTool;
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
                // The vendor's own sentence where it wrote one; ours is a code, because a vendor
                // that says "this failed" and nothing else leaves this side speaking for it.
                failure: result.text.slice(0, 400) || TOOL_REPORTED_ERROR,
              }
            : decided,
        });
        return { text: result.text, isError: result.isError };
      } catch (error) {
        /*
         * A server that answered by pointing somewhere else is OUR refusal, not the vendor's
         * failure, and the row says so with a code rather than with a sentence.
         *
         * The branch is worth its lines. Every other failure here is something that happened TO the
         * call — a vendor down, a credential it would not take. This one is the deployment declining
         * to follow a 3xx, which is the whole reason the transport now refuses redirects: a custom
         * server nobody reviewed can answer 302 with the Bot's own computer, or an address on this
         * network, and a followed redirect carries the credential there. A reader counting refusals
         * should find these; a reader counting vendor outages should not be reading them.
         *
         * `rule` carries the fact code for the same reason the guard floors do — the surface names
         * the boundary from a code, never from our sentence.
         */
        if (error instanceof McpRedirectRefusedError) {
          await recordAuditEvent(auditStore, {
            eventType: "mcp.call_rejected",
            targetType: "mcp_tool",
            targetId: input.ref,
            payload: { ...decided, refusal: error.fact, status: error.status },
          });
          throw new PluginRefusedError(error.message, error.fact);
        }
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
