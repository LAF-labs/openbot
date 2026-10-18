import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  authorOf,
  type CompanyMember,
  keyFor,
  memberName,
  type WriteKey,
} from "@/lib/hub/company";
import {
  type JobChoice,
  stageLabel,
  taskConversationOf,
  taskDetailQueryOptions,
  taskFailureText,
  taskKeys,
  taskNoteText,
  taskWrite,
} from "@/lib/hub/tasks";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { AssigneeSelect, NOBODY } from "./assignee-select";

/**
 * One task opened: what it is, who has it, its notes — a 라피's in plain words — and, where this
 * VM's 라피 worked it, the way to the conversation it was worked in. Who has it can be changed here,
 * and a note added.
 */
export function TaskDetail({
  taskId,
  meId,
  members,
  jobs,
  onClose,
}: {
  taskId: string;
  meId: string | undefined;
  members: readonly CompanyMember[] | undefined;
  jobs: readonly JobChoice[] | undefined;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery(taskDetailQueryOptions(taskId));
  const channels = useQuery(channelListQueryOptions());
  const conversation = taskConversationOf(taskId, channels.data);
  const task = detail.data?.task;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: taskKeys.detail(taskId) });
    void queryClient.invalidateQueries({ queryKey: taskKeys.board });
  };

  const reassign = useMutation({
    mutationFn: (assignee: string) =>
      taskWrite(
        `/api/hub/tasks/${encodeURIComponent(taskId)}`,
        "PATCH",
        {
          version: task?.version ?? 0,
          assignee: assignee === NOBODY ? null : assignee,
        },
        crypto.randomUUID(),
      ),
    onSettled: refresh,
  });

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent className="sm:max-w-lg" data-task-detail={taskId}>
        <DialogHeader>
          <DialogTitle className="break-words">
            {task?.title ?? t("Task")}
          </DialogTitle>
          {task ? (
            <DialogDescription>{stageLabel(task.stage)}</DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {detail.isPending ? (
            <Skeleton className="h-20 w-full" />
          ) : detail.isError ? (
            <p className="text-muted-foreground text-sm">
              {taskFailureText(detail.error)}
            </p>
          ) : (
            <>
              {detail.data.task.description ? (
                <p className="whitespace-pre-wrap break-words text-sm">
                  {detail.data.task.description}
                </p>
              ) : null}
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">
                  {t("Who does it")}
                </span>
                <AssigneeSelect
                  disabled={reassign.isPending}
                  jobs={jobs}
                  meId={meId}
                  members={members}
                  onChange={(next) => reassign.mutate(next)}
                  value={detail.data.task.assignee ?? NOBODY}
                />
                {reassign.isError ? (
                  <p className="text-destructive text-sm" role="alert">
                    {taskFailureText(reassign.error)}
                  </p>
                ) : null}
              </div>
              {conversation ? (
                <Link
                  className="text-link text-sm underline-offset-2 hover:underline"
                  data-task-conversation
                  params={{ channelId: conversation.id }}
                  to="/channel/$channelId"
                >
                  {t("See how Lafi worked on it")}
                </Link>
              ) : null}
              <section className="flex flex-col gap-2" data-task-notes>
                <h3 className="font-medium text-sm">{t("Notes")}</h3>
                {detail.data.notes.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {t("No notes yet.")}
                  </p>
                ) : (
                  <ol className="flex flex-col gap-2">
                    {detail.data.notes.map((note) => {
                      const said = taskNoteText(note);
                      return (
                        <li
                          className={cn(
                            "rounded-lg px-3 py-2 text-sm",
                            said.isStop ? "bg-accent" : "bg-muted",
                          )}
                          data-task-note={note.id}
                          key={note.id}
                        >
                          <span className="block text-muted-foreground text-xs">
                            {noteAuthor(note.by, meId, members)}
                          </span>
                          <span className="whitespace-pre-wrap break-words">
                            {said.text}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                )}
                <NoteBox onSent={refresh} taskId={taskId} />
              </section>
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** Who left a note: a person, or a person's 라피 — this person's own said as 나 and 내 라피. */
function noteAuthor(
  by: string,
  meId: string | undefined,
  members: readonly CompanyMember[] | undefined,
): string {
  const author = authorOf(by, members);
  const isMine = author.memberId === meId;
  if (author.isBot) {
    return isMine
      ? t("My Lafi")
      : t("{name}'s Lafi", { name: memberName(author.memberId, members) });
  }
  return isMine ? t("Me") : author.name;
}

function NoteBox({ taskId, onSent }: { taskId: string; onSent: () => void }) {
  const [text, setText] = useState("");
  const held = useRef<WriteKey | null>(null);
  const send = useMutation({
    mutationFn: (written: string) => {
      // The key follows the words, as a room's message does (`company-rooms.tsx`): the same note
      // again is one note, an edited one is another.
      held.current = keyFor(held.current, written);
      return taskWrite(
        `/api/hub/tasks/${encodeURIComponent(taskId)}/notes`,
        "POST",
        { text: written },
        held.current.key,
      );
    },
    onSuccess: () => {
      setText("");
      held.current = null;
      onSent();
    },
  });
  const written = text.trim();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (written && !send.isPending) send.mutate(written);
      }}
    >
      <Textarea
        aria-label={t("Add a note")}
        maxLength={4000}
        onChange={(event) => setText(event.target.value)}
        placeholder={t("Add a note")}
        rows={2}
        value={text}
      />
      <div className="flex items-center justify-between gap-2">
        {send.isError ? (
          <p className="text-destructive text-sm" role="alert">
            {taskFailureText(send.error)}
          </p>
        ) : (
          <span />
        )}
        <Button disabled={!written || send.isPending} size="sm" type="submit">
          {t("Add note")}
        </Button>
      </div>
    </form>
  );
}
