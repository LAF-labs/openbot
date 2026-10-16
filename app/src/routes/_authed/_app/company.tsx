import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { CompanyFiles } from "@/components/company/company-files";
import { CompanyMembers } from "@/components/company/company-members";
import { CompanyMemory } from "@/components/company/company-memory";
import { CompanyRooms } from "@/components/company/company-rooms";
import { CompanySkills } from "@/components/company/company-skills";
import { PageEmpty, PageShell } from "@/components/layout/page-shell";
import { focusRingBare } from "@/components/ui/focus";
import {
  companyMembersQueryOptions,
  companyMeQueryOptions,
  isAdmin,
} from "@/lib/hub/company";
import { hubStatusLine, hubStatusQueryOptions } from "@/lib/hub/status";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 회사: the company this person's VM belongs to — its rooms, its files, what its Bots were taught,
 * who is in it, and for an admin the team memory waiting to be confirmed. Reached from 회사 in the
 * top row, which is drawn only where there is a company (`layout/screen-switch.tsx`).
 *
 * Which part is open, and which room or skill, is in the address, so a reload or Back keeps it.
 */
const TABS = ["rooms", "files", "skills", "members", "memory"] as const;
type Tab = (typeof TABS)[number];

const companySearchSchema = z
  .object({
    tab: z.enum(TABS).optional(),
    room: z.string().optional(),
    skill: z.string().optional(),
  })
  .catch({});

export const Route = createFileRoute("/_authed/_app/company")({
  validateSearch: companySearchSchema,
  component: CompanyPage,
});

function tabLabel(tab: Tab): string {
  switch (tab) {
    case "rooms":
      return t("Rooms");
    case "files":
      return t("Files");
    case "skills":
      return t("Skills");
    case "members":
      return t("Members");
    case "memory":
      return t("Team memory");
  }
}

function CompanyPage() {
  const search = Route.useSearch();
  const status = useQuery(hubStatusQueryOptions());
  const configured = status.data?.configured === true;
  const me = useQuery({ ...companyMeQueryOptions(), enabled: configured });
  const members = useQuery({
    ...companyMembersQueryOptions(),
    enabled: configured,
  });

  const role =
    me.data?.member.role ??
    (status.data?.configured ? status.data.member?.role : undefined);
  const shown = TABS.filter((tab) => tab !== "memory" || isAdmin(role));
  const tab: Tab =
    search.tab && shown.includes(search.tab) ? search.tab : "rooms";
  const line = status.data ? hubStatusLine(status.data) : null;
  const workspace =
    me.data?.workspace?.name ??
    (status.data?.configured ? status.data.workspace?.name : undefined);

  if (status.data && !status.data.configured) {
    return (
      <PageShell title={t("Company")}>
        <PageEmpty>{t("This place does not belong to a company.")}</PageEmpty>
      </PageShell>
    );
  }

  return (
    <PageShell title={workspace ?? t("Company")}>
      {line?.note ? (
        <p
          className="-mt-2 mb-4 text-muted-foreground text-sm"
          data-company-line
          role="status"
        >
          {line.note}
        </p>
      ) : null}
      <nav
        aria-label={t("Company")}
        className="mt-4 mb-6 flex w-full max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-muted p-0.5 text-sm sm:w-fit"
        data-company-tabs
      >
        {shown.map((one) => (
          <Link
            aria-current={one === tab ? "page" : undefined}
            className={cn(
              "flex h-7 shrink-0 items-center rounded-full px-3 font-medium transition-colors",
              one === tab
                ? "bg-background text-link"
                : "text-muted-foreground hover:text-foreground",
              focusRingBare,
            )}
            data-company-tab={one}
            key={one}
            search={{ tab: one }}
            to="/company"
          >
            {tabLabel(one)}
          </Link>
        ))}
      </nav>

      {tab === "rooms" ? (
        <CompanyRooms
          meId={me.data?.member.id}
          members={members.data}
          openRoom={search.room}
        />
      ) : null}
      {tab === "files" ? <CompanyFiles members={members.data} /> : null}
      {tab === "skills" ? <CompanySkills openSkill={search.skill} /> : null}
      {tab === "members" ? (
        <CompanyMembers meId={me.data?.member.id} members={members} />
      ) : null}
      {tab === "memory" ? <CompanyMemory members={members.data} /> : null}
    </PageShell>
  );
}
