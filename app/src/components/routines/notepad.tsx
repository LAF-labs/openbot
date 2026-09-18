import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import { ConfirmDialog } from "@/components/layout/confirm-dialog";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { useNow } from "@/lib/use-now";
import {
  notepadEntryLabel,
  type RoutineNotepad as Notepad,
  routineKeys,
  routineRequest,
  whenLabel,
} from "@/lib/routines/queries";

/**
 * 메모장 — where a routine left off, above its run history.
 *
 * READ-ONLY, WITH ONE BUTTON. The routine's own runs write this (`server/src/routines/notepad.ts`)
 * and nothing on this screen can put a value into it: a note typed here would be a "fact" planted
 * in front of a run nobody watches. What a person can do is see it — which review the Bot thinks it
 * got to — and empty it, when the Bot got that wrong.
 *
 * EMPTYING ASKS FIRST, and says what it costs. The next run starts with no idea where the last one
 * left off and may go over the same reviews again; a clear that said nothing about that would be a
 * button that looks like tidying and acts like a reset. The server writes the trail row.
 */
export const RoutineNotepad = ({ routineId }: { routineId: string }) => {
  const queryClient = useQueryClient();
  const headingId = useId();
  const [isConfirming, setIsConfirming] = useState(false);
  // What 오늘 and 어제 are measured from; see `useNow` for why it is not read inside `whenLabel`.
  const now = useNow();

  const notepad = useQuery({
    queryKey: routineKeys.notepad(routineId),
    queryFn: async () =>
      (await routineRequest(`/api/routines/${routineId}/notepad`))
        ?.notepad as Notepad,
  });
  const clear = useMutation({
    mutationFn: async () =>
      routineRequest(`/api/routines/${routineId}/notepad`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      setIsConfirming(false);
      void queryClient.invalidateQueries({
        queryKey: routineKeys.notepad(routineId),
      });
    },
  });

  const entries = notepad.data?.entries ?? [];
  const updatedAt = notepad.data?.updatedAt ?? null;

  return (
    <section
      aria-labelledby={headingId}
      className="border-border border-b py-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-xs" id={headingId}>
            {t("Notepad")}
          </h3>
          <p className="text-muted-foreground text-xs">
            {t("Where this routine left off, as its last run noted it.")}
          </p>
        </div>
        {entries.length > 0 ? (
          <Button
            onClick={() => setIsConfirming(true)}
            size="sm"
            variant="ghost"
          >
            {t("Clear")}
          </Button>
        ) : null}
      </div>

      {notepad.isPending ? (
        <p className="pt-2 text-muted-foreground text-xs">
          {t("Loading the notepad…")}
        </p>
      ) : null}
      {notepad.isError ? (
        <div className="flex items-center gap-2 pt-2">
          <p className="text-destructive text-xs" role="alert">
            {t("The notepad could not be loaded.")}
          </p>
          <Button
            onClick={() => void notepad.refetch()}
            size="sm"
            variant="ghost"
          >
            {t("Try again")}
          </Button>
        </div>
      ) : null}
      {notepad.isSuccess && entries.length === 0 ? (
        <p className="pt-2 text-muted-foreground text-xs">
          {t("Nothing noted yet.")}
        </p>
      ) : null}

      {entries.length > 0 ? (
        <>
          <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1 pt-2 text-xs">
            {entries.map((entry) => (
              <Fragment key={entry.key}>
                <dt className="truncate font-mono text-muted-foreground">
                  {entry.key}
                </dt>
                <dd className="whitespace-pre-wrap break-words">
                  {notepadEntryLabel(entry, now)}
                </dd>
              </Fragment>
            ))}
          </dl>
          {updatedAt ? (
            <p className="pt-2 text-muted-foreground/80 text-xs">
              {t("Noted {when}", { when: whenLabel(updatedAt, now) })}
            </p>
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        confirmLabel={t("Clear")}
        description={t(
          "Its next run starts without knowing where the last one left off, so it may go over the same things again.",
        )}
        error={clear.error?.message}
        onConfirm={() => clear.mutate()}
        onOpenChange={(open) => {
          if (!open) setIsConfirming(false);
        }}
        open={isConfirming}
        pending={clear.isPending}
        pendingLabel={t("Clearing…")}
        title={t("Clear this routine's notepad?")}
      />
    </section>
  );
};
