import { IconPlus } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CompanyMember } from "@/lib/hub/company";
import {
  type JobChoice,
  taskFailureText,
  taskKeys,
  taskWrite,
} from "@/lib/hub/tasks";
import { t } from "@/lib/i18n";
import { AssigneeSelect, NOBODY } from "./assignee-select";

/**
 * A new task: a title and who does it. It goes to 할 일, seen by the whole company — a board is the
 * team's; a task kept to oneself is a note, not a task on the team's board.
 */
export function NewTask({
  meId,
  members,
  jobs,
}: {
  meId: string | undefined;
  members: readonly CompanyMember[] | undefined;
  jobs: readonly JobChoice[] | undefined;
}) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState(NOBODY);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const create = useMutation({
    mutationFn: () =>
      taskWrite(
        "/api/hub/tasks",
        "POST",
        {
          title: title.trim(),
          visibility: "company",
          ...(assignee === NOBODY ? {} : { assignee }),
        },
        key,
      ),
    onSuccess: () => {
      setTitle("");
      setAssignee(NOBODY);
      setKey(crypto.randomUUID());
      setIsOpen(false);
      void queryClient.invalidateQueries({ queryKey: taskKeys.board });
    },
  });

  if (!isOpen) {
    return (
      <Button
        data-new-task
        onClick={() => setIsOpen(true)}
        size="sm"
        variant="outline"
      >
        <IconPlus />
        {t("New task")}
      </Button>
    );
  }

  return (
    <form
      className="flex w-full max-w-xl flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row sm:flex-wrap sm:items-center"
      data-new-task-form
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim() && !create.isPending) create.mutate();
      }}
    >
      <Input
        aria-label={t("What needs doing")}
        autoFocus
        className="sm:flex-1"
        maxLength={200}
        onChange={(event) => {
          setTitle(event.target.value);
          if (create.isError) create.reset();
        }}
        placeholder={t("What needs doing")}
        value={title}
      />
      <AssigneeSelect
        jobs={jobs}
        meId={meId}
        members={members}
        onChange={setAssignee}
        value={assignee}
      />
      <div className="flex justify-end gap-2">
        <Button
          onClick={() => setIsOpen(false)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("Cancel")}
        </Button>
        <Button
          disabled={!title.trim() || create.isPending}
          size="sm"
          type="submit"
        >
          {t("Add")}
        </Button>
      </div>
      {create.isError ? (
        <p className="w-full text-destructive text-sm" role="alert">
          {taskFailureText(create.error)}
        </p>
      ) : null}
    </form>
  );
}
