import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
  companyFailureText,
  companySkillQueryOptions,
  companySkillsQueryOptions,
} from "@/lib/hub/company";
import { t } from "@/lib/i18n";

/**
 * 스킬: what the team taught every member's Bot, to read. Writing one is the Bot's (`mcp__hub__write`
 * kind `skill`) or an admin's later; this screen only shows them. A row opens to its instructions.
 */
export function CompanySkills({
  openSkill,
}: {
  openSkill: string | undefined;
}) {
  const skills = useQuery(companySkillsQueryOptions());

  if (skills.isPending) {
    return (
      <PageRows>
        {[0, 1].map((slot) => (
          <div className="flex flex-col gap-2 p-4" key={slot}>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-64" />
          </div>
        ))}
      </PageRows>
    );
  }
  if (skills.isError) {
    return <PageEmpty>{companyFailureText(skills.error)}</PageEmpty>;
  }
  if (skills.data.length === 0) {
    return <PageEmpty>{t("No team skills yet.")}</PageEmpty>;
  }
  return (
    <PageRows>
      {skills.data.map((skill, index) => {
        const isOpen = skill.slug === openSkill;
        return (
          <div data-team-skill={skill.slug} key={skill.slug}>
            <Item
              render={(props) => (
                <Link
                  aria-expanded={isOpen}
                  search={{
                    tab: "skills",
                    ...(isOpen ? {} : { skill: skill.slug }),
                  }}
                  to="/company"
                  {...props}
                />
              )}
              size="sm"
            >
              <ItemContent>
                <ItemTitle>{skill.title}</ItemTitle>
                {skill.summary ? (
                  <ItemDescription>{skill.summary}</ItemDescription>
                ) : null}
              </ItemContent>
            </Item>
            {isOpen ? <SkillInstructions slug={skill.slug} /> : null}
            {index !== skills.data.length - 1 && <Separator />}
          </div>
        );
      })}
    </PageRows>
  );
}

function SkillInstructions({ slug }: { slug: string }) {
  const skill = useQuery(companySkillQueryOptions(slug));
  return (
    <div className="px-4 pb-4" data-team-skill-instructions>
      {skill.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : skill.isError ? (
        <p className="text-muted-foreground text-sm">
          {companyFailureText(skill.error)}
        </p>
      ) : (
        <p className="whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 text-sm">
          {skill.data.instructions}
        </p>
      )}
    </div>
  );
}
