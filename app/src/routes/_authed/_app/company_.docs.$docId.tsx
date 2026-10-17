import { IconArrowLeft } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DocEditor } from "@/components/docs/doc-editor";
import { PageEmpty, PageShell } from "@/components/layout/page-shell";
import { focusRingBare } from "@/components/ui/focus";
import {
  companyMembersQueryOptions,
  companyMeQueryOptions,
} from "@/lib/hub/company";
import { openDocQueryOptions } from "@/lib/hub/docs";
import { hubStatusQueryOptions } from "@/lib/hub/status";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 회사 → 문서 → one document, open for writing. Its own address, so a reload or a link a colleague
 * pastes opens the same document; 문서 in 회사 (`company.tsx`) lists them.
 */
export const Route = createFileRoute("/_authed/_app/company_/docs/$docId")({
  component: DocPage,
});

function DocPage() {
  const { docId } = Route.useParams();
  const status = useQuery(hubStatusQueryOptions());
  const configured = status.data?.configured === true;
  const me = useQuery({ ...companyMeQueryOptions(), enabled: configured });
  const members = useQuery({
    ...companyMembersQueryOptions(),
    enabled: configured,
  });
  const doc = useQuery({ ...openDocQueryOptions(docId), enabled: configured });

  if (status.data && !status.data.configured) {
    return (
      <PageShell title={t("Company")}>
        <PageEmpty>{t("This place does not belong to a company.")}</PageEmpty>
      </PageShell>
    );
  }

  return (
    <PageShell title={doc.data?.doc.title || t("Document")}>
      <Link
        className={cn(
          "mt-1 mb-8 inline-flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground",
          focusRingBare,
        )}
        data-doc-back
        search={{ tab: "docs" }}
        to="/company"
      >
        <IconArrowLeft className="size-4" />
        {t("All documents")}
      </Link>
      {configured ? (
        <DocEditor
          docId={docId}
          meId={me.data?.member.id}
          members={members.data}
        />
      ) : null}
    </PageShell>
  );
}
