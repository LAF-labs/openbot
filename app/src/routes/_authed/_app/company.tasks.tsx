import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { TaskBoard } from "@/components/tasks/task-board";
import {
  companyMembersQueryOptions,
  companyMeQueryOptions,
} from "@/lib/hub/company";

/**
 * 회사 → 업무판: the company's task board, under 회사's title and tabs (`company.tsx` draws them and
 * this in its place). Which task is open is in the address, so a reload or Back keeps it.
 */
const taskSearchSchema = z
  .object({
    task: z.string().optional(),
  })
  .catch({});

export const Route = createFileRoute("/_authed/_app/company/tasks")({
  validateSearch: taskSearchSchema,
  component: CompanyTasksPage,
});

function CompanyTasksPage() {
  const search = Route.useSearch();
  const me = useQuery(companyMeQueryOptions());
  const members = useQuery(companyMembersQueryOptions());
  return (
    <TaskBoard
      meId={me.data?.member.id}
      members={members.data}
      openTask={search.task}
    />
  );
}
