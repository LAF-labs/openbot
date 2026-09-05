import { z } from "zod";
import { t } from "@/lib/i18n";

/**
 * Browser-side coworker form contract. Limits match the server parser so validation errors can be
 * shown next to fields before submit.
 */
export const agentFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, t("Name is required."))
    .max(80, t("Name must be 80 characters or fewer.")),
  /*
   * OPTIONAL, BOTH OF THEM, THE SAME WAY THE SERVER HAS THEM.
   *
   * They were required here and nowhere else: `server/src/agents/routes.ts` takes an empty title and
   * an empty description on purpose — a Bot starts with nothing set and is shaped by talking to it —
   * and every screen that makes one leaves them blank. So a Bot made yesterday could not be RENAMED
   * today without first inventing a job title it had never been shown, on a form that refused to
   * save and would not say which field it was refusing over.
   */
  title: z
    .string()
    .trim()
    .max(120, t("Title must be 120 characters or fewer.")),
  roleDescription: z
    .string()
    .trim()
    .max(1000, t("Role description must be 1000 characters or fewer.")),
  visibility: z.enum(["public", "private"]),
  /**
   * The AG-UI endpoint this coworker runs on. Empty means the Bot in the box.
   *
   * Only URL shape is checked here; deployment allow/deny rules are server-side.
   */
  endpoint: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || /^https?:\/\/\S+$/.test(value),
      t("Enter a web address starting with http:// or https://."),
    ),
  /**
   * A key the agent sits behind. WRITE-ONLY: it is never sent back from the server, so this field is
   * always empty when editing, and leaving it empty keeps whatever key is already set.
   */
  authValue: z.string(),
});

export type AgentFormValues = z.infer<typeof agentFormSchema>;

export const emptyAgentForm: AgentFormValues = {
  name: "",
  title: "",
  roleDescription: "",
  visibility: "private",
  endpoint: "",
  authValue: "",
};

/** Convert form values to API input; omit an empty key so editing preserves the current credential. */
export function agentInputFrom(values: AgentFormValues) {
  return {
    name: values.name,
    title: values.title,
    roleDescription: values.roleDescription,
    visibility: values.visibility,
    endpoint: values.endpoint,
    ...(values.authValue.trim()
      ? { auth: { header: "Authorization", value: values.authValue.trim() } }
      : {}),
  };
}
