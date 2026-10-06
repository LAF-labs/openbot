import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";

export type CredentialStatus = {
  id: string;
  /**
   * What the key is for, as the vault files it. The form on this page makes the first two; the
   * other two are written elsewhere and listed here all the same — `agent` is a key stored for a
   * Bot's own server from `/admin/bots`, `mcp` a token for a connected service. It said only the
   * first two, and the page needs to tell an `agent` key apart (`credentials.tsx`).
   */
  kind: "model" | "connector" | "agent" | "mcp";
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
