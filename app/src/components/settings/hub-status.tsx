import { useQuery } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { hubStatusLine, hubStatusQueryOptions } from "@/lib/hub/status";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 회사: <이름> · 연결됨/끊김 — one line, on a VM that belongs to a company.
 *
 * Not drawn at all where the person is on their own, and not drawn while the first answer is out:
 * a company line that appears on a VM with no company would be a claim. What the server's line to
 * the hub is doing is the server's to say (`/api/hub/status`); a `hub.status` frame on the app's
 * socket refreshes it when it changes (`lib/channels/use-channel-events.ts`).
 */
export function HubStatusSection() {
  const { data } = useQuery(hubStatusQueryOptions());
  const shown = data ? hubStatusLine(data) : null;
  if (!shown) return null;

  return (
    <PageSection title={t("Company")}>
      <PageRows>
        <Item size="sm">
          <ItemContent>
            <ItemTitle data-slot="hub-status">
              <span
                aria-hidden
                className={cn(
                  "inline-block size-2 rounded-full",
                  shown.connected ? "bg-emerald-500" : "bg-muted-foreground",
                )}
              />
              {shown.line}
            </ItemTitle>
            {shown.note ? (
              <ItemDescription className="line-clamp-none">
                {shown.note}
              </ItemDescription>
            ) : null}
          </ItemContent>
        </Item>
      </PageRows>
    </PageSection>
  );
}
