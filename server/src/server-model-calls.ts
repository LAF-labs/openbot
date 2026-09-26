import { eq } from "drizzle-orm";
import { type AuditStore, auditRowLost, recordAuditEvent } from "./audit";
import {
  type AutoReviewer,
  createAutoReviewProbe,
  createModelAutoReviewer,
  type ReviewSubject,
} from "./computer/auto-review";
import { jevAsker, modelAsker, withFallback } from "./computer/decision-askers";
import { type DecisionCall, decisionBaseUrlOf } from "./computer/decision-call";
import {
  createJevAutoReviewer,
  createJevAutoReviewProbe,
} from "./computer/jev-auto-review";
import type { ModelUsage } from "./computer/model-call";
import { createCompactor } from "./context/compaction";
import { createDaySummarizer } from "./context/day-close";
import { log } from "./log";
import { createWriteUp, type WriteUp } from "./computer/write-up";
import type { DeploymentConfig } from "./config";
import {
  type ModelCredentialSecretReader,
  resolveModelApiKey,
} from "./credentials";
import type { Database } from "./db/client";
import { agentProfiles } from "./db/schema";
import type { TenantPackage } from "./tenant-package";
import {
  type DailyBudget,
  DailyBudgetReachedError,
} from "./usage/daily-budget";

/**
 * The model calls this server makes on its own account, rather than a Bot's.
 *
 * Three of them, all against the deployment's own endpoint and key: judging an owner's "do not ask
 * me about" instruction against one action, asking once whether this deployment can judge at all,
 * and writing a finished demonstration up as a procedure. They were assembled inline in `main.ts`,
 * twice over — the same base URL default and the same key closure in two places, the second copy
 * waiting to drift from the first.
 */
export function createServerModelCalls(input: {
  database: Database;
  /** Where each call's token counts land, as `model.usage` rows beside a Bot's own turns. */
  auditStore: AuditStore;
  credentials: ModelCredentialSecretReader;
  encryptionKey: string;
  endpoint: DeploymentConfig["model"];
  model: TenantPackage["model"];
  /**
   * A free trial's day, which these calls draw on as much as a Bot's turns do: their rows are in the
   * same sum. Absent — every deployment that is not a trial — nothing is judged.
   */
  dailyBudget?: DailyBudget;
  /** The harness's switches: Jev, and how compaction decides. Absent: Jev off, compaction off. */
  harness?: DeploymentConfig["harness"];
}) {
  const { endpoint, model, dailyBudget } = input;

  /**
   * Server-side model calls land in the same ledger as Bot turns, tagged by purpose.
   *
   * The per-Bot monthly cost is a sum over `model.usage` rows; a deployment whose auto-review burns
   * tokens invisibly would undercount its own KPI. Counts only, never content.
   */
  const recordModelUsage =
    (
      source:
        | "auto-review"
        | "write-up"
        | "compaction"
        | "day-summary"
        | "memory"
        | "dream"
        | "high-risk",
    ) =>
    (usage: ModelUsage) => {
      void recordAuditEvent(input.auditStore, {
        eventType: "model.usage",
        targetType: "model",
        payload: { ...usage, source },
      }).catch(auditRowLost("model.usage"));
    };

  /**
   * Resolved per call, for the same reason the runtime's is: revoking a credential then takes effect
   * on the next action rather than on the next restart. `OPENAI_API_KEY` is only the fallback.
   */
  const apiKey = () =>
    resolveModelApiKey({
      encryptionKey: input.encryptionKey,
      reader: input.credentials,
      provider: model.provider,
      keyId: model.credentialSecretRef,
      configuredKey: endpoint.apiKey,
    });

  /** Everything the judge and the probe both need, so the probe measures the real call. */
  const reviewCall = {
    baseUrl: endpoint.baseUrl,
    model: model.reviewModel,
    apiKey,
    // The server model's own assertion that it reasons, which is what decides whether an effort is
    // sent at all — not the Bot's model's: a MiMo deployment judges on GLM, which takes `low`. See
    // `model.yaml server_model_effort`, and the note in auto-review.ts.
    supportsEffort: model.serverModelSupportsEffort,
  };

  const modelReviewer = createModelAutoReviewer({
    ...reviewCall,
    onUsage: recordModelUsage("auto-review"),
  });

  /*
   * JEV, ONLY WITH THE SWITCH ON (`JEV_ENABLED`, off by default), and only where the deployment's
   * endpoint is OpenRouter — the key it holds is an OpenRouter key. Off, or not OpenRouter, the
   * deployment's own model answers every question it would have been asked, exactly as before.
   */
  const decisionBase = input.harness?.jevEnabled
    ? decisionBaseUrlOf(endpoint.baseUrl)
    : null;
  const decisionCall: DecisionCall | null = decisionBase
    ? {
        baseUrl: decisionBase,
        model: model.decisionModel,
        apiKey,
        onUsage: (usage) =>
          void recordAuditEvent(input.auditStore, {
            eventType: "model.usage",
            targetType: "model",
            payload: { ...usage, source: "decisions" },
          }).catch(auditRowLost("model.usage")),
      }
    : null;
  const reviewModel: AutoReviewer = decisionCall
    ? createJevAutoReviewer({ call: decisionCall, fallback: modelReviewer })
    : modelReviewer;
  const modelProbe = createAutoReviewProbe({
    ...reviewCall,
    onUsage: recordModelUsage("auto-review"),
  });

  /*
   * THE COMPACTOR (`context/compaction.ts`). `decisions` asks Jev when the switch is on and the
   * deployment's model in Jev's shape when it is off or Jev cannot answer; any failure of both
   * falls back to the deterministic rule. The stand-in is the server model, not the Bot's: it used
   * to be the Bot's on the theory that a compaction runs behind the conversation and may be slow,
   * and on MiMo-V2.6-Pro it outlived its bound 2 times in 3 and the rule lost the detail
   * (docs/laf/eval-pack.md). A stand-in that times out is no stand-in.
   */
  const standIn = modelAsker(
    {
      baseUrl: endpoint.baseUrl,
      model: model.serverModel,
      apiKey,
      supportsEffort: model.serverModelSupportsEffort,
      onUsage: recordModelUsage("compaction"),
    },
    { timeoutMs: 90_000 },
  );
  const compactor = createCompactor({
    mode: input.harness?.compaction ?? "off",
    asker: decisionCall
      ? withFallback(jevAsker(decisionCall, { timeoutMs: 15_000 }), standIn)
      : standIn,
    excerpts: true,
    onFallback: (reason) =>
      log.warn("compaction_fell_back", { reason: reason.split(":")[0] }),
  });

  /*
   * THE DAY'S SUMMARY (`context/day-close.ts`), on the server model like the compactor's stand-in.
   * Jev answers yes/no questions and cannot write one; the Bot's own model could, as a cache-safe
   * fork, but a close made hours after the last turn reads a cold cache either way, and the server
   * model is the one measured to answer inside its bound.
   */
  const summarizeDay = createDaySummarizer(
    {
      baseUrl: endpoint.baseUrl,
      model: model.serverModel,
      apiKey,
      supportsEffort: model.serverModelSupportsEffort,
      onUsage: recordModelUsage("day-summary"),
    },
    { timeoutMs: 120_000 },
  );

  /*
   * THE MEMORY'S JUDGE — the hourly curation's keep-or-drop (`agents/memory-curation.ts`) and the
   * scrub that takes a forgotten fact out of the day summaries (`context/forget-scrub.ts`). The
   * compactor's arrangement: Jev when the switch is on, the server model in Jev's shape behind it or
   * alone. Shorter bounds than the compactor's, because an owner's 잊기 waits on the scrub.
   */
  const memoryStandIn = modelAsker(
    {
      baseUrl: endpoint.baseUrl,
      model: model.serverModel,
      apiKey,
      supportsEffort: model.serverModelSupportsEffort,
      onUsage: recordModelUsage("memory"),
    },
    { timeoutMs: 30_000 },
  );
  const memoryAsker = decisionCall
    ? withFallback(
        jevAsker(decisionCall, { timeoutMs: 10_000, purpose: "memory" }),
        memoryStandIn,
      )
    : memoryStandIn;

  /** The nightly dream's writer (`agents/dream.ts`): the server model, like the day's summary. */
  const dreamCall = {
    baseUrl: endpoint.baseUrl,
    model: model.serverModel,
    apiKey,
    supportsEffort: model.serverModelSupportsEffort,
    onUsage: recordModelUsage("dream"),
  };

  const writeUp = createWriteUp({
    baseUrl: endpoint.baseUrl,
    model: model.defaultModel,
    apiKey,
    onUsage: recordModelUsage("write-up"),
  });

  return {
    /**
     * The owner's own sentence about what not to be asked, judged against one action.
     *
     * Given to the gateway and the plugin store as one function, so neither knows anything about
     * where an instruction is kept or how it is judged. Read per action rather than cached: it is
     * edited on a screen, and an edit that took effect on the next restart would be a boundary
     * somebody believes they tightened.
     */
    autoReviewFor: async (botId: string, subject: ReviewSubject) => {
      const [row] = await input.database
        .select({ instruction: agentProfiles.autoReview })
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, botId));
      // No row and no instruction are the same answer: there is nothing to judge, so a person is asked.
      if (!row?.instruction) return null;
      /*
       * A SPENT DAY IS NOT JUDGED, WHICH MEANS A PERSON IS ASKED — the same answer as no instruction
       * at all (self-serve contract §4.6). The boundary gives way in the only direction it may: an
       * action is never let past unseen because a judgement could not be afforded. Asked after the
       * row, so a Bot with no instruction costs the database nothing extra.
       */
      if (await dailyBudget?.reachedToday()) return null;
      return reviewModel(row.instruction, subject);
    },

    /**
     * Whether this deployment can auto-review at all, measured rather than assumed. The caller starts
     * it at boot without awaiting it; see `createAutoReviewProbe`.
     */
    autoReviewCapable: decisionCall
      ? createJevAutoReviewProbe({
          call: decisionCall,
          fallbackProbe: modelProbe,
        })
      : modelProbe,

    /** How a long conversation is compacted, or null when it is not. See `context/compaction.ts`. */
    compactor,

    /** The summary a day's close stands on. See `context/day-close.ts`. */
    summarizeDay,

    /** The memory's keep-or-drop judge: curation and the forgetting's scrub. */
    memoryAsker,

    /**
     * The high-risk check's judge, and the snapshot it answers as first (for its bar). A spent free
     * trial day is not judged — which here means the check falls back to its rules and asks where
     * anything personal was typed, the direction it may always give way in.
     */
    highRiskAsker: {
      ask: async (state, questions) => {
        if (await dailyBudget?.reachedToday()) {
          throw new Error("budget: the day's budget is spent");
        }
        return highRiskAsker.ask(state, questions);
      },
    } satisfies JevAsker,
    highRiskModel: decisionCall ? model.decisionModel : model.serverModel,

    /** The nightly dream's writer. See `agents/dream.ts`. */
    dreamCall,

    /** The mail's second look at what its rules could not settle. See `plugins/mail-secrets.ts`. */
    mailSecretJudge,

    /**
     * A finished recording, written up as a procedure.
     *
     * The deployment's own model rather than the review one: this runs once, with the person watching
     * and knowing they asked for it, so a slow careful answer is the right trade — the opposite of the
     * judgement that sits in front of every action a Bot takes.
     *
     * On a free trial's spent day it is REFUSED with the fact a Bot's run ends on
     * (`laf:daily_budget_reached`), thrown as the refusal `app.ts` answers with — the recording
     * survives, and pressing again after midnight works. An empty recording is left to the route's
     * own answer, which comes first and costs nothing.
     */
    writeUp: (async (recording) => {
      if (recording.steps.length > 0 && (await dailyBudget?.reachedToday())) {
        throw new DailyBudgetReachedError();
      }
      return writeUp(recording);
    }) satisfies WriteUp,
  };
}
