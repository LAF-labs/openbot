import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { AgentCard } from "@/components/agents/agent-card";
import { AgentProfile as AgentProfileDetail } from "@/components/agents/agent-profile";
import { Mascot } from "@/components/agents/mascot";
import { NewAgent } from "@/components/agents/new-agent";
import { DetailPanel } from "@/components/layout/detail-panel";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { t } from "@/lib/i18n";

/**
 * Creating and inspecting a coworker are search-parameter states so the roster remains mounted and
 * Back closes the detail pane.
 */
const agentsSearchSchema = z
  .object({
    new: z.boolean().optional(),
    agent: z.string().optional(),
  })
  /* `.catch({})` so `?settings=yes` is ignored rather than throwing out of
   * validateSearch and taking the whole route down with it. */
  .catch({});

export const Route = createFileRoute("/_authed/_app/agents/")({
  validateSearch: agentsSearchSchema,
  component: AgentsScreen,
});

function AgentsScreen() {
  const { new: isCreating, agent: selectedAgentId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const {
    data: agents,
    isPending,
    isError,
    refetch,
  } = useQuery(agentListQueryOptions());
  const mine = agents?.filter((a) => a.mine);
  const explore = agents?.filter((a) => !a.mine && a.visibility === "public");

  // Creating wins if both are somehow set: it is the more recent intent.
  const showCreate = isCreating === true;
  const showProfile = !showCreate && selectedAgentId !== undefined;
  const close = () => navigate({ search: {} });

  return (
    <DetailPanel
      onClose={close}
      open={showCreate || showProfile}
      detail={
        showCreate ? (
          <NewAgent />
        ) : selectedAgentId ? (
          <AgentProfileDetail agentId={selectedAgentId} />
        ) : null
      }
    >
      {/*
       * ON THE SHELL EVERY OTHER NAV DESTINATION USES. Hand-written measurements meant this screen
       * had no page title at all, section gaps that did not match its peers, and — because the shell
       * is where the scroller lives — no way to reach anything below the fold.
       */}
      <PageShell
        action={
          <Button
            variant="ghost"
            size="sm"
            render={(props) => (
              <Link to="/agents" search={{ new: true }} {...props} />
            )}
          >
            <IconPlus />
            {t("New agent")}
          </Button>
        }
        title={t("Agents")}
      >
        <PageSection title={t("Your agents")}>
          <div className="flex flex-row">
            {!!mine?.length && (
              /*
               * Columns sized by the card, not counted out in advance: this column narrows by 400px
               * the moment a profile opens beside it, and a fixed four columns squeezed the cards
               * until they overlapped. auto-fill keeps every card at least 144px and drops to
               * however many fit.
               */
              <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(144px,1fr))] gap-4">
                {mine.map((agent, index) => {
                  return (
                    <StaggerItem index={index} key={agent.id}>
                      <Link to="/agents" search={{ agent: agent.id }}>
                        <AgentCard agent={agent} />
                      </Link>
                    </StaggerItem>
                  );
                })}
              </div>
            )}
            {/*
             * "YOU HAVE NONE" IS A CLAIM, AND IT WAS BEING MADE BEFORE THE ANSWER ARRIVED — and
             * again when the request failed, which told somebody with a roster full of Bots that
             * they had never made one.
             */}
            {isPending && (
              <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(144px,1fr))] gap-4">
                {[0, 1, 2].map((slot) => (
                  <Skeleton className="h-[200px] rounded-xl" key={slot} />
                ))}
              </div>
            )}
            {isError && (
              <div className="flex flex-col items-start gap-2">
                <p className="text-destructive text-sm" role="alert">
                  {t("Your agents could not be loaded.")}
                </p>
                <Button
                  onClick={() => void refetch()}
                  size="sm"
                  variant="outline"
                >
                  {t("Try again")}
                </Button>
              </div>
            )}
            {!isPending && !isError && !mine?.length && (
              <Empty className="border border-dashed h-[180px]">
                <EmptyHeader>
                  {/* The axolotl: the one that has not grown up yet, waiting to be made. */}
                  <span className="mx-auto mb-2 inline-flex size-12 overflow-hidden rounded-full opacity-80">
                    <Mascot
                      className="size-full object-cover"
                      seed="r4c5"
                      size={48}
                    />
                  </span>
                  <EmptyTitle className="text-muted-foreground">
                    {t("You don't have any agents created.")}
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </PageSection>
        {/* Hidden entirely on error: the page-level line above already said what went wrong once. */}
        {isError ? null : (
          <PageSection title={t("Explore agents")}>
            <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(144px,1fr))] gap-4">
              {isPending
                ? [0, 1, 2].map((slot) => (
                    <Skeleton className="h-[200px] rounded-xl" key={slot} />
                  ))
                : explore?.map((agent, index) => (
                    <StaggerItem index={index} key={agent.id}>
                      <Link to="/agents" search={{ agent: agent.id }}>
                        <AgentCard agent={agent} />
                      </Link>
                    </StaggerItem>
                  ))}
            </div>
            {!isPending && !explore?.length ? (
              <p className="mt-4 text-muted-foreground text-sm">
                {t("No public agents to explore yet.")}
              </p>
            ) : null}
          </PageSection>
        )}
      </PageShell>
    </DetailPanel>
  );
}
