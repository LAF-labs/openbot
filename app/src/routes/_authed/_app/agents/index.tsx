import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { AgentCard } from "@/components/agents/agent-card";
import { Mascot } from "@/components/agents/mascot";
import { AgentProfile as AgentProfileDetail } from "@/components/agents/agent-profile";
import { NewAgent } from "@/components/agents/new-agent";
import { DetailPanel } from "@/components/layout/detail-panel";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { t } from "@/lib/i18n";

/**
 * Creating and inspecting a coworker are search-parameter states so the roster remains mounted and
 * Back closes the detail pane.
 */
const agentsSearchSchema = z.object({
  new: z.boolean().optional(),
  agent: z.string().optional(),
});

export const Route = createFileRoute("/_authed/_app/agents/")({
  validateSearch: agentsSearchSchema,
  component: AgentsScreen,
});

function AgentsScreen() {
  const { new: isCreating, agent: selectedAgentId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: agents } = useQuery(agentListQueryOptions());
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
      <div className="max-w-2xl px-4 w-full mx-auto">
        <div className="mt-12 w-full max-w-2xl">
          <div className="flex flex-row w-full items-center justify-between">
            <h2 className="font-semibold text-[15px]">{t("Your agents")}</h2>
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
          </div>
          <div className="flex flex-row mt-4">
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
            {!mine?.length && (
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
        </div>
        <div className="mt-8 w-full max-w-2xl">
          <h2 className="font-semibold text-[15px]">{t("Explore agents")}</h2>
          <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(144px,1fr))] gap-4">
            {!!explore?.length &&
              explore.map((agent, index) => {
                return (
                  <StaggerItem index={index} key={agent.id}>
                    <Link to="/agents" search={{ agent: agent.id }}>
                      <AgentCard agent={agent} />
                    </Link>
                  </StaggerItem>
                );
              })}
          </div>
        </div>
      </div>
    </DetailPanel>
  );
}
