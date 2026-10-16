import { IconUpload } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PageEmpty, PageRows } from "@/components/layout/page-shell";
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
  companyFilesQueryOptions,
  companyKeys,
  memberName,
  refusalBeforeTeamUpload,
  sizeLabel,
  teamFileAddress,
  uploadTeamFile,
} from "@/lib/hub/company";
import { t } from "@/lib/i18n";

/**
 * 파일: the team's files, each opened (saved) through this VM's server, and one sent from this
 * person's computer. A file a colleague sends reaches this list as a `hub.file.changed` frame.
 *
 * A file goes up as it is: the words inside it are not read out here, so the team's search finds it
 * by its name until a reader is added.
 */
export function CompanyFiles({
  members,
}: {
  members: readonly CompanyMember[] | undefined;
}) {
  const queryClient = useQueryClient();
  const files = useQuery(companyFilesQueryOptions());
  const picker = useRef<HTMLInputElement>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => uploadTeamFile(file, crypto.randomUUID()),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: companyKeys.files }),
  });

  const handlePick = (file: File | undefined) => {
    if (!file) return;
    const refused = refusalBeforeTeamUpload(file);
    setRefusal(refused);
    if (!refused) upload.mutate(file);
  };

  return (
    <div data-company-files>
      <div className="flex items-center justify-end gap-3">
        {upload.isPending ? (
          <span className="text-muted-foreground text-sm" role="status">
            {t("Uploading…")}
          </span>
        ) : null}
        <input
          className="sr-only"
          data-team-file-input
          onChange={(event) => {
            handlePick(event.target.files?.[0]);
            event.target.value = "";
          }}
          ref={picker}
          tabIndex={-1}
          type="file"
        />
        <Button
          disabled={upload.isPending}
          onClick={() => picker.current?.click()}
          size="sm"
          variant="outline"
        >
          <IconUpload />
          {t("Upload from computer")}
        </Button>
      </div>
      {refusal || upload.isError ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {refusal ?? companyFailureText(upload.error)}
        </p>
      ) : null}

      {files.isPending ? (
        <PageRows>
          {[0, 1, 2].map((slot) => (
            <div className="flex flex-col gap-2 p-4" key={slot}>
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
          ))}
        </PageRows>
      ) : files.isError ? (
        <PageEmpty>{companyFailureText(files.error)}</PageEmpty>
      ) : files.data.length === 0 ? (
        <PageEmpty>{t("No team files yet.")}</PageEmpty>
      ) : (
        <PageRows>
          {files.data.map((file, index) => (
            <div data-team-file={file.id} key={file.id}>
              <Item size="sm">
                <ItemContent className="min-w-0">
                  <ItemTitle className="w-full truncate">{file.name}</ItemTitle>
                  <ItemDescription>
                    {[
                      file.folder === "/" ? null : file.folder,
                      sizeLabel(file.size),
                      file.by ? memberName(file.by, members) : null,
                      dateOf(file.at),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    nativeButton={false}
                    render={(props) => (
                      <a
                        download={file.name}
                        href={teamFileAddress(file.id)}
                        {...props}
                      />
                    )}
                    size="sm"
                    variant="ghost"
                  >
                    {t("Open")}
                  </Button>
                </ItemActions>
              </Item>
              {index !== files.data.length - 1 && <Separator />}
            </div>
          ))}
        </PageRows>
      )}
    </div>
  );
}

function dateOf(at: string): string {
  return new Date(at).toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
  });
}
