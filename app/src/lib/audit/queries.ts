import { infiniteQueryOptions, keepPreviousData } from "@tanstack/react-query";
import { t } from "@/lib/i18n";

export const auditKeys = { all: ["audit-events"] as const };

/** One row as the API returns it. */
export type AuditEvent = {
  id: string;
  actorUserId: string | null;
  eventType: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type AuditPage = {
  events: AuditEvent[];
  /** Absent on the last page. Carried back to ask for the next one. */
  nextCursor?: string;
};

/**
 * A hundred rows, then a hundred more when somebody asks.
 *
 * The table used to read one page and stop, because the server has always capped a request at
 * fifty and the screen had nothing to carry the cursor. So an account with a month of computer
 * actions behind it had an audit trail whose fifty-first row could not be reached from the
 * product at all: the answer to "what did it do on Tuesday" was not there, and nothing on the page
 * said there was more.
 *
 * A hundred is the server's ceiling and it is a screenful-and-a-half of a table this dense — enough
 * that the common question is answered without pressing anything, small enough that the page paints
 * at once.
 */
export const AUDIT_PAGE_SIZE = 100;

export function auditEventsQueryOptions(search = "") {
  return infiniteQueryOptions({
    queryKey: [...auditKeys.all, search] as const,
    /*
     * EVERY FILTER CHIP IS A COLD CACHE KEY. Without this, switching filters emptied the table and
     * collapsed the page to its heading while the next request was in flight — the reader loses
     * their place on a screen whose whole job is scanning, and the collapse reads as "no results".
     * The rows that are on screen stay there, dimmed, until the new ones replace them.
     */
    placeholderData: keepPreviousData,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: AuditPage) => page.nextCursor,
    queryFn: async ({ pageParam }): Promise<AuditPage> => {
      // The filters carry their own `?`, so the page size joins with `&` once there is one.
      const parameters = new URLSearchParams(search.replace(/^\?/, ""));
      parameters.set("limit", String(AUDIT_PAGE_SIZE));
      if (pageParam) parameters.set("cursor", pageParam);
      const response = await fetch(
        `/api/admin/audit-events?${parameters.toString()}`,
        { credentials: "include" },
      );
      if (!response.ok)
        throw new Error(
          t("The audit trail could not be loaded. Refresh to try again."),
        );
      return response.json();
    },
  });
}
