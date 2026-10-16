import type { UseQueryResult } from "@tanstack/react-query";
import { PageEmpty, PageRows } from "@/components/layout/page-shell";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type CompanyMember,
  companyFailureText,
  memberName,
  roleLabel,
} from "@/lib/hub/company";
import { t } from "@/lib/i18n";

/** 멤버: who is in the company, and in what role. Read from the page, which the rooms share. */
export function CompanyMembers({
  meId,
  members,
}: {
  meId: string | undefined;
  members: UseQueryResult<CompanyMember[]>;
}) {
  if (members.isPending) {
    return (
      <PageRows>
        {[0, 1, 2].map((slot) => (
          <div className="p-4" key={slot}>
            <Skeleton className="h-4 w-32" />
          </div>
        ))}
      </PageRows>
    );
  }
  if (members.isError) {
    return <PageEmpty>{companyFailureText(members.error)}</PageEmpty>;
  }
  return (
    <PageRows>
      {members.data.map((member, index) => (
        <div data-company-member={member.id} key={member.id}>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>
                {memberName(member.id, members.data)}
                {member.id === meId ? (
                  <span className="font-normal text-muted-foreground text-xs">
                    {t("Me")}
                  </span>
                ) : null}
              </ItemTitle>
              <ItemDescription>{roleLabel(member.role)}</ItemDescription>
            </ItemContent>
          </Item>
          {index !== members.data.length - 1 && <Separator />}
        </div>
      ))}
    </PageRows>
  );
}
