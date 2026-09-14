import { eq } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "./audit";
import {
  createAutoReviewProbe,
  createModelAutoReviewer,
  type ReviewSubject,
} from "./computer/auto-review";
import type { ModelUsage } from "./computer/model-call";
import { createWriteUp } from "./computer/write-up";
import type { DeploymentConfig } from "./config";
import {
  type ModelCredentialSecretReader,
  resolveModelApiKey,
} from "./credentials";
import type { Database } from "./db/client";
import { agentProfiles } from "./db/schema";
import type { TenantPackage } from "./tenant-package";

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
}) {
  const { endpoint, model } = input;

  /**
   * Server-side model calls land in the same ledger as Bot turns, tagged by purpose.
   *
   * The per-Bot monthly cost is a sum over `model.usage` rows; a deployment whose auto-review burns
   * tokens invisibly would undercount its own KPI. Counts only, never content.
   */
  const recordModelUsage =
    (source: "auto-review" | "write-up") => (usage: ModelUsage) => {
      void recordAuditEvent(input.auditStore, {
        eventType: "model.usage",
        targetType: "model",
        payload: { ...usage, source },
      }).catch(() => undefined);
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
    // The deployment's own assertion that its model reasons, which is what decides whether an effort
    // is sent at all. See `model.yaml supports_effort`, and the note in auto-review.ts.
    supportsEffort: model.supportsEffort,
  };

  const reviewModel = createModelAutoReviewer({
    ...reviewCall,
    onUsage: recordModelUsage("auto-review"),
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
      return row?.instruction ? reviewModel(row.instruction, subject) : null;
    },

    /**
     * Whether this deployment can auto-review at all, measured rather than assumed. The caller starts
     * it at boot without awaiting it; see `createAutoReviewProbe`.
     */
    autoReviewCapable: createAutoReviewProbe({
      ...reviewCall,
      onUsage: recordModelUsage("auto-review"),
    }),

    /**
     * A finished recording, written up as a procedure.
     *
     * The deployment's own model rather than the review one: this runs once, with the person watching
     * and knowing they asked for it, so a slow careful answer is the right trade — the opposite of the
     * judgement that sits in front of every action a Bot takes.
     */
    writeUp: createWriteUp({
      baseUrl: endpoint.baseUrl,
      model: model.defaultModel,
      apiKey,
      onUsage: recordModelUsage("write-up"),
    }),
  };
}
