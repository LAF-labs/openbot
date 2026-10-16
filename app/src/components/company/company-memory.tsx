import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type CompanyMember,
  companyFailureText,
  companyKeys,
  companyMemoryQueryOptions,
  companyProposalsQueryOptions,
  companyWrite,
  memberName,
} from "@/lib/hub/company";
import { t } from "@/lib/i18n";

/**
 * 팀 기억, for an admin: the lines members' Bots proposed, each with where the Bot read it, waiting
 * for 확인 (every member's Bot carries it from the next conversation) or 숨기기 (it is turned down,
 * and the same words proposed again are refused). Under them, what the team's Bots carry now.
 *
 * Only an admin sees this tab; the hub refuses a member's 확인 either way (`laf:hub_forbidden`).
 */
export function CompanyMemory({
  members,
}: {
  members: readonly CompanyMember[] | undefined;
}) {
  const proposals = useQuery(companyProposalsQueryOptions());
  const memory = useQuery(companyMemoryQueryOptions());

  return (
    <div data-company-memory>
      <PageSection className="mt-6" title={t("Waiting for confirmation")}>
        {proposals.isPending ? (
          <Skeleton className="mt-4 h-12 w-full" />
        ) : proposals.isError ? (
          <PageEmpty>{companyFailureText(proposals.error)}</PageEmpty>
        ) : proposals.data.length === 0 ? (
          <PageEmpty>{t("Nothing is waiting.")}</PageEmpty>
        ) : (
          <PageRows>
            {proposals.data.map((proposal, index) => (
              <div data-memory-proposal={proposal.id} key={proposal.id}>
                <Proposal
                  by={memberName(proposal.proposedBy, members)}
                  content={proposal.content}
                  excerpt={proposal.evidence.excerpt}
                  id={proposal.id}
                />
                {index !== proposals.data.length - 1 && <Separator />}
              </div>
            ))}
          </PageRows>
        )}
      </PageSection>

      <PageSection title={t("What the team's Bots remember")}>
        {memory.isPending ? (
          <Skeleton className="mt-4 h-12 w-full" />
        ) : memory.isError ? (
          <PageEmpty>{companyFailureText(memory.error)}</PageEmpty>
        ) : memory.data.length === 0 ? (
          <PageEmpty>{t("Nothing confirmed yet.")}</PageEmpty>
        ) : (
          <PageRows>
            {memory.data.map((line, index) => (
              <div data-memory-line={line.id} key={line.id}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle className="font-normal">
                      {line.content}
                    </ItemTitle>
                    <ItemDescription>
                      {t("Confirmed by {name}", {
                        name: memberName(line.confirmedBy, members),
                      })}
                    </ItemDescription>
                  </ItemContent>
                </Item>
                {index !== memory.data.length - 1 && <Separator />}
              </div>
            ))}
          </PageRows>
        )}
      </PageSection>
    </div>
  );
}

function Proposal({
  by,
  content,
  excerpt,
  id,
}: {
  by: string;
  content: string;
  excerpt: string;
  id: string;
}) {
  const queryClient = useQueryClient();
  // One key per decision on this line, so a press retried after a dropped answer is one decision.
  const [key] = useState(() => crypto.randomUUID());
  const decide = useMutation({
    mutationFn: (decision: "confirm" | "retire") =>
      companyWrite(
        `/api/hub/memory/${encodeURIComponent(id)}/${decision}`,
        "POST",
        undefined,
        `${key}.${decision}`,
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: companyKeys.memory }),
  });

  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle className="font-normal">{content}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {t("{name}'s Bot proposed it", { name: by })}
          {excerpt ? ` · “${excerpt}”` : null}
        </ItemDescription>
        {decide.isError ? (
          <p className="text-destructive text-xs" role="alert">
            {companyFailureText(decide.error)}
          </p>
        ) : null}
      </ItemContent>
      <ItemActions>
        <Button
          disabled={decide.isPending}
          onClick={() => decide.mutate("retire")}
          size="sm"
          variant="ghost"
        >
          {t("Hide")}
        </Button>
        <Button
          data-memory-confirm
          disabled={decide.isPending}
          onClick={() => decide.mutate("confirm")}
          size="sm"
        >
          {t("Confirm")}
        </Button>
      </ItemActions>
    </Item>
  );
}
