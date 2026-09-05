import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";

export type CredentialStatus = {
  id: string;
  kind: "model" | "connector";
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  revokedAt: string | null;
};

export const credentialKeys = {
  all: ["credentials"] as const,
  list: () => [...credentialKeys.all, "list"] as const,
};

export function credentialListQueryOptions() {
  return queryOptions({
    queryKey: credentialKeys.list(),
    queryFn: async (): Promise<CredentialStatus[]> => {
      const response = await fetch("/api/admin/credentials", {
        credentials: "include",
      });
      if (!response.ok) throw new Error(t("Could not load credentials."));
      return ((await response.json()) as { credentials: CredentialStatus[] })
        .credentials;
    },
  });
}
