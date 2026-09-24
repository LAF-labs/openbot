import { SKILL_SLUG_PATTERN } from "@shared/tools/skills";
import { z } from "zod";
import { t } from "@/lib/i18n";

/**
 * The four things a person decides about a skill.
 *
 * THE LIMITS MATCH THE SERVER'S PARSER EXACTLY, so a form that submits is a form that will be
 * accepted, and a rejection is shown next to the field that caused it rather than as a failed
 * request with a sentence at the top of the page.
 *
 * The slug pattern is the server's own, imported rather than copied (`shared/tools/skills.ts`):
 * letters — Korean among them, since 2026-09-24 — digits and hyphens, starting and ending on a
 * letter or digit, 2 to 40 long. Loosening it here would only move the refusal later, to a place
 * where it reads as the save being broken.
 */
export const skillFormSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1, t("A command is required."))
    // Decomposed Hangul passes too (its jamo are letters), and the server keeps it composed.
    .regex(
      SKILL_SLUG_PATTERN,
      t("Letters (Korean too), numbers and hyphens, 2 to 40, with no spaces."),
    ),
  title: z
    .string()
    .trim()
    .min(1, t("A title is required."))
    .max(120, t("Title must be 120 characters or fewer.")),
  /** Optional on the server too, which is why there is no minimum here. */
  summary: z
    .string()
    .trim()
    .max(200, t("The one-liner must be 200 characters or fewer.")),
  instructions: z
    .string()
    .trim()
    .min(1, t("Instructions are required — this is what the Bot follows.")),
});

export type SkillFormValues = z.infer<typeof skillFormSchema>;

export const emptySkillForm: SkillFormValues = {
  slug: "",
  title: "",
  summary: "",
  instructions: "",
};
