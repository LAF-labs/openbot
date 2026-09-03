/**
 * What a Bot may do with a connected 카카오톡 채널: look at the templates, and send one.
 *
 * TWO TOOLS AND ONE OF THEM ASKS. Listing is a read of this deployment's own rows and asks nobody.
 * Sending reaches somebody else's phone — a customer of the business, not the person who owns the
 * Bot — and that is an external effect in the contract's own vocabulary, so a person answers for the
 * exact message, every time, whatever the written policy says (`plugins/laf-contract.ts`).
 *
 * A TEMPLATE THAT IS NOT APPROVED CANNOT BE SENT, and the refusal is ours rather than the vendor's.
 * 카카오 would refuse it too, with a sentence about a template mismatch that tells a shop owner
 * nothing; refusing here says which template and that it is still being inspected.
 */
import {
  type PartnerConnections,
  PartnerRefusedError,
} from "../partner-connections";
import {
  type PartnerToolSpec,
  partnerTransport,
  refuse,
  requiredString,
} from "../partner-tools";
import type { PluginContext } from "../store";
import { normalizeRecipient } from "./connect";
import { sendTemplateMessage, SolapiError, solapiSettings } from "./solapi";
import {
  missingVariables,
  standardTemplate,
  STANDARD_TEMPLATES,
  withVariableBraces,
} from "./templates";

const PROVIDER = "kakao-alimtalk" as const;

/**
 * The two tools, with their declarations.
 *
 * The descriptions are Korean and short because they are prompt: a model reads them to decide
 * whether this is the tool for what somebody asked, and a paragraph is a paragraph in every turn's
 * context for the life of the deployment.
 */
export const ALIMTALK_TOOLS: readonly PartnerToolSpec[] = Object.freeze([
  {
    name: "alimtalk_templates",
    description:
      "이 사업장의 카카오톡 채널에 등록된 알림톡 서식과 심사 상태를 본다. 보내기 전에 어떤 서식을 쓸 수 있는지 확인할 때.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "alimtalk_send",
    description:
      "승인된 서식으로 손님 휴대폰에 알림톡을 보낸다. 예약 확정, 후기 요청처럼 사업장이 손님에게 알리는 내용에만 쓴다.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "받는 사람 휴대폰 번호. 숫자만 또는 하이픈 포함.",
        },
        template: {
          type: "string",
          description: `보낼 서식의 코드. ${STANDARD_TEMPLATES.filter((entry) => entry.audience === "customer")
            .map((entry) => entry.code)
            .join(", ")} 중 하나.`,
          enum: STANDARD_TEMPLATES.filter(
            (entry) => entry.audience === "customer",
          ).map((entry) => entry.code),
        },
        variables: {
          type: "object",
          description:
            "서식의 빈칸을 채울 값. 예: {\"상호\": \"미소상회\", \"고객명\": \"김민수\"}",
          additionalProperties: { type: "string" },
        },
      },
      required: ["to", "template", "variables"],
      additionalProperties: false,
    },
    /*
     * `external`, which is a guard floor and not a label.
     *
     * A message to a customer is the business speaking to somebody who is not in this room. It
     * cannot be recalled, it arrives with the shop's name on it, and the number came from a model.
     * So the boundary stops and a person reads the exact call — the same treatment a custom server's
     * tool gets for declaring the same thing.
     */
    annotations: { "x-laf/effect": "external" },
  },
]);

export function createAlimtalkTools(
  _context: PluginContext,
  partners: PartnerConnections,
  environment: Record<string, string | undefined> = process.env,
) {
  return partnerTransport({
    tools: ALIMTALK_TOOLS,
    anonymousFact: "laf:alimtalk_no_actor",
    run: async ({ toolName, args, actorId }) => {
      if (toolName === "alimtalk_templates") {
        const rows = await partners.templatesFor(actorId);
        const byCode = new Map(rows.map((row) => [row.code, row]));
        /*
         * Facts, as JSON, including the templates that have no row yet.
         *
         * A model reading this decides whether it may send, so "this one is not registered" and
         * "this one is waiting for inspection" have to be two different answers rather than an
         * absence it has to interpret.
         */
        return JSON.stringify(
          STANDARD_TEMPLATES.map((entry) => ({
            code: entry.code,
            audience: entry.audience,
            variables: entry.variables,
            status: byCode.get(entry.code)?.status ?? "not_registered",
            reason: byCode.get(entry.code)?.reason ?? "",
          })),
        );
      }

      if (toolName !== "alimtalk_send") refuse("laf:alimtalk_unknown_tool");

      const settings = solapiSettings(environment);
      if (!settings) refuse("laf:alimtalk_not_configured");

      const connection = await partners.find(PROVIDER, actorId);
      if (!connection) refuse("laf:alimtalk_not_connected");

      const code = requiredString(args, "template", "laf:alimtalk_no_template");
      const entry = standardTemplate(code);
      if (!entry) refuse("laf:alimtalk_unknown_template");
      /*
       * A Bot may not send the owner's own notifications.
       *
       * `laf_approval` and `laf_done` are the outbox's, and they are addressed to the person who
       * owns this deployment. A Bot that could send them could tell its owner it was waiting for an
       * approval it had never asked for, which is a Bot writing the notification that decides
       * whether it gets looked at.
       */
      if (entry.audience !== "customer") {
        refuse("laf:alimtalk_template_not_for_customers");
      }

      const known = (await partners.templatesFor(actorId)).find(
        (row) => row.code === code,
      );
      if (!known) refuse("laf:alimtalk_template_not_registered");
      if (known.status !== "approved") {
        refuse(
          known.status === "rejected"
            ? "laf:alimtalk_template_rejected"
            : "laf:alimtalk_template_pending",
        );
      }

      const to = normalizeRecipientOrRefuse(
        requiredString(args, "to", "laf:alimtalk_no_recipient"),
      );
      const supplied = withVariableBraces(
        (args.variables ?? {}) as Record<string, unknown>,
      );
      const missing = missingVariables(entry, supplied);
      if (missing.length > 0) refuse("laf:alimtalk_variables_missing");

      const sent = await sendTemplateMessage({
        settings,
        senderKey: connection.account,
        templateId: known.templateId,
        to,
        variables: supplied,
      }).catch((error: unknown) => {
        if (error instanceof SolapiError) refuse("laf:alimtalk_send_failed");
        throw error;
      });

      if (!sent.accepted) refuse("laf:alimtalk_send_failed");
      // The message id and nothing else. What was said is the person's message and the customer's,
      // and a tool result is read into a model's context and then into a transcript.
      return JSON.stringify({ sent: true, messageId: sent.messageId });
    },
  });
}

/** The recipient's number, with the connect flow's own rules and this path's fact code. */
function normalizeRecipientOrRefuse(raw: string): string {
  try {
    return normalizeRecipient(raw);
  } catch (error) {
    if (error instanceof PartnerRefusedError) refuse(error.fact);
    throw error;
  }
}
