import { IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { focusRing } from "@/components/ui/focus";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useMyBots } from "@/lib/agents/my-bots";
import { createProjectMutationOptions } from "@/lib/channels/mutations";
import { projectName, projectsOf } from "@/lib/channels/projects";
import {
  type ChannelSummary,
  channelKeys,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { t } from "@/lib/i18n";
import { settledOf, useReading } from "@/lib/reading";
import { cn } from "@/lib/utils";

/**
 * 프로젝트 — THE OTHER CONVERSATIONS A PERSON HAS WITH THEIR BOT (2026-10-10, record §1 and §3,
 * piece 4-2).
 *
 * The Bot's main conversation is one, and always the one. A project is a conversation beside it,
 * made by a name, for something worked on over days — the same Bot, its own record. This page is
 * the names, and one box to make another.
 *
 * NAMES, AND NOTHING ELSE. No description, no date, no last line: the page this is modelled on
 * (record §1) is a list of names, and what was said in a project is in the project. A name with
 * something unread wears the mark the rest of the app wears.
 *
 * ONE BOX, ONE PRESS. A project is made by saying what it is called — or by saying nothing, and it
 * is called that — and it opens at once, empty, ready to be spoken to. There is no form because
 * there is nothing else to decide: what the project is for is settled by talking, as the Bot is.
 *
 * AN ACCOUNT FROM BEFORE THE CAP has several Bots, and its other conversations with each became
 * that Bot's projects (migration 0064). They are listed under their Bot's name, and a new project
 * is made with the Bot whose list it is typed into. With one Bot there is no name over the list.
 */
export const Route = createFileRoute("/_authed/_app/projects")({
  component: ProjectsPage,
});

function ProjectsPage() {
  const mine = useMyBots();
  const channels = useQuery(channelListQueryOptions());
  const list = settledOf(useReading(channels))?.data;
  const bots = mine.bots ?? [];
  const isSeveral = bots.length > 1;

  return (
    <PageShell title={t("Projects")}>
      {mine.bots === undefined && !mine.isError ? (
        <Skeleton className="h-24 rounded-xl" />
      ) : null}
      {bots.map((bot) => (
        <PageSection key={bot.id} {...(isSeveral ? { title: bot.name } : {})}>
          <ProjectsOfBot botId={bot.id} projects={projectsOf(bot.id, list)} />
        </PageSection>
      ))}
    </PageShell>
  );
}

function ProjectsOfBot({
  botId,
  projects,
}: {
  botId: string;
  projects: ChannelSummary[];
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation(createProjectMutationOptions(queryClient));
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending) return;
    setProblem(null);
    let made: Awaited<ReturnType<typeof create.mutateAsync>>;
    try {
      made = await create.mutateAsync({ agentId: botId, name });
    } catch (error) {
      // The mutation's own sentence, already in the reader's language (`mutations.ts`).
      setProblem(
        error instanceof Error
          ? error.message
          : t("Could not make the project. Try again."),
      );
      return;
    }
    setName("");
    // The conversation screen reads the channel by its id: hand it over, so it opens with no wait.
    queryClient.setQueryData(channelKeys.detail(made.id), made);
    await navigate({
      params: { channelId: made.id },
      to: "/channel/$channelId",
    });
  };

  return (
    <div className="flex flex-col gap-3" data-projects-of={botId}>
      <form className="flex items-center gap-2" onSubmit={handleSubmit}>
        <Input
          aria-label={t("New project")}
          autoComplete="off"
          className="h-10 min-w-0 flex-1"
          data-project-name
          onChange={(event) => setName(event.target.value)}
          placeholder={t("New project")}
          value={name}
        />
        <Button
          aria-label={t("Make the project")}
          className="size-10 shrink-0"
          data-project-make
          disabled={create.isPending}
          size="icon"
          title={t("Make the project")}
          type="submit"
        >
          <IconPlus aria-hidden="true" />
        </Button>
      </form>
      {problem ? (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
      {projects.length > 0 ? (
        <ul className="flex flex-col">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-lg px-2 py-2.5 text-sm transition-colors hover:bg-accent",
                  focusRing,
                )}
                data-project={project.id}
                params={{ channelId: project.id }}
                to="/channel/$channelId"
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  {projectName(project)}
                </span>
                {project.unread ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full bg-mark"
                      data-mark="new"
                    />
                    <span className="sr-only">{t("Unread")}</span>
                  </>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm" data-projects-none>
          {t("Work that runs over days gets a conversation of its own here.")}
        </p>
      )}
    </div>
  );
}
