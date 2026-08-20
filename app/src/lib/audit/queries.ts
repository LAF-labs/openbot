import { keepPreviousData, queryOptions } from "@tanstack/react-query";

export const auditKeys = { all: ["audit-events"] as const };

export function auditEventsQueryOptions(search = "") {
  return queryOptions({
    queryKey: [...auditKeys.all, search] as const,
    /*
     * EVERY FILTER CHIP IS A COLD CACHE KEY. Without this, switching filters emptied the table and
     * collapsed the page to its heading while the next request was in flight — the reader loses
     * their place on a screen whose whole job is scanning, and the collapse reads as "no results".
     * The rows that are on screen stay there, dimmed, until the new ones replace them.
     */
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const response = await fetch(`/api/admin/audit-events${search}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not load audit events");
      return response.json();
    },
  });
}
