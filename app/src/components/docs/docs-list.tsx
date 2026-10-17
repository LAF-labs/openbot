import { IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { PageEmpty, PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { type CompanyMember, memberName } from "@/lib/hub/company";
import {
  createDoc,
  docFailureText,
  docKeys,
  docListQueryOptions,
} from "@/lib/hub/docs";
import { t } from "@/lib/i18n";
import { isImeKey } from "@/lib/ime";

/**
 * 문서: the team's documents, newest change first, and 새 문서. A document opens on a page of its own
 * (`routes/_authed/_app/company_.docs.$docId.tsx`), where it is written in.
 */
export function DocsList({
  members,
}: {
  members: readonly CompanyMember[] | undefined;
}) {
  const docs = useQuery(docListQueryOptions());

  return (
    <div data-company-docs>
      <NewDoc />
      {docs.isPending ? (
        <PageRows>
          {[0, 1].map((slot) => (
            <div className="flex flex-col gap-2 p-4" key={slot}>
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
          ))}
        </PageRows>
      ) : docs.isError ? (
        <PageEmpty>{docFailureText(docs.error)}</PageEmpty>
      ) : docs.data.length === 0 ? (
        <PageEmpty>{t("No team documents yet.")}</PageEmpty>
      ) : (
        <PageRows>
          {docs.data.map((doc, index) => (
            <div key={doc.id}>
              <Item
                render={(props) => (
                  <Link
                    data-company-doc={doc.id}
                    params={{ docId: doc.id }}
                    to="/company/docs/$docId"
                    {...props}
                  />
                )}
                size="sm"
              >
                <ItemContent>
                  <ItemTitle>{doc.title || t("Untitled")}</ItemTitle>
                  {doc.updatedBy ? (
                    <ItemDescription>
                      {t("Last changed by {name}", {
                        name: memberName(
                          doc.updatedBy.replace(/^(m|bot):/, ""),
                          members,
                        ),
                      })}
                    </ItemDescription>
                  ) : null}
                </ItemContent>
              </Item>
              {index !== docs.data.length - 1 && <Separator />}
            </div>
          ))}
        </PageRows>
      )}
    </div>
  );
}

function NewDoc() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [key] = useState(() => crypto.randomUUID());
  const create = useMutation({
    mutationFn: () => createDoc(title.trim(), key),
    onSuccess: (id) => {
      void queryClient.invalidateQueries({ queryKey: docKeys.list });
      void navigate({ to: "/company/docs/$docId", params: { docId: id } });
    },
  });

  if (!isOpen) {
    return (
      <div className="mb-4">
        <Button
          data-doc-new
          onClick={() => setIsOpen(true)}
          size="sm"
          variant="outline"
        >
          <IconPlus />
          {t("New document")}
        </Button>
      </div>
    );
  }

  const canCreate = title.trim() !== "" && !create.isPending;
  return (
    <form
      className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center"
      onSubmit={(event) => {
        event.preventDefault();
        if (canCreate) create.mutate();
      }}
    >
      <Input
        aria-label={t("Document title")}
        autoFocus
        className="sm:max-w-sm"
        data-doc-title-input
        maxLength={200}
        onChange={(event) => setTitle(event.currentTarget.value)}
        onKeyDown={(event) => {
          // The Enter that finishes a Korean syllable is the syllable's, not the form's.
          if (event.key === "Enter" && isImeKey(event)) event.preventDefault();
        }}
        placeholder={t("Document title")}
        value={title}
      />
      <div className="flex gap-2">
        <Button disabled={!canCreate} size="sm" type="submit">
          {t("Make document")}
        </Button>
        <Button
          onClick={() => setIsOpen(false)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("Cancel")}
        </Button>
      </div>
      {create.isError ? (
        <p className="text-destructive text-sm" role="alert">
          {docFailureText(create.error)}
        </p>
      ) : null}
    </form>
  );
}
