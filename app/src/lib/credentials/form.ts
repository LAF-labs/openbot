import { z } from "zod";
import { t } from "@/lib/i18n";

export const credentialFormSchema = z.object({
  kind: z.enum(["model", "connector"]),
  provider: z.string().trim().min(1, t("Provider is required.")),
  keyId: z.string().trim().min(1, t("Key ID is required.")),
  plaintext: z.string().min(1, t("Secret is required.")),
});

export type CredentialFormValues = z.infer<typeof credentialFormSchema>;
