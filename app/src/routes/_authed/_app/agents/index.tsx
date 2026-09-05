import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { AgentCard } from "@/components/agents/agent-card";
import { AgentProfile as AgentProfileDetail } from "@/components/agents/agent-profile";
import { Mascot } from "@/components/agents/mascot";
import { NewBotButton } from "@/components/agents/new-bot-button";
import { DetailPanel } from "@/components/layout/detail-panel";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useSeats } from "@/lib/agents/new-bot";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { workingLabel, workingQueryOptions } from "@/lib/agents/working";
import { t } from "@/lib/i18n";

/**
 * Inspecting a Bot is a search-parameter state so the roster remains mounted and Back closes the
 * detail pane.
 *
 * `new` IS GONE. Creating was a third state here — a form in a 320px pane, asking for a title it
 * threw away — and a Bot is now made by pressing the button, with no screen in between. An old
 * `?new=true` link is simply dropped by the schema and lands on the roster, which is where somebody
 * following one wanted to be anyway.
 */
const agentsSearchSchema = z
  .object({
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
  const { agent: selectedAgentId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const {
    data: agents,
    isPending,
    isError,
    refetch,
  } = useQuery(agentListQueryOptions());
  const { data: working } = useQuery(workingQueryOptions());
  const seats = useSeats();
  const mine = agents?.filter((a) => a.mine);

  const close = () => navigate({ search: {} });

  return (
    <DetailPanel
      /*
       * 400px, not 320. The pane holding a Bot's profile is not the pane holding a thumbnail and a
       * list: it carries a face, a name that can be typed in, four cards of settings and a menu, and
       * at 320 the effort buttons and the skill switches were laid out three-to-a-line on a column
       * narrower than the sentence explaining them.
       */
      detailWidth={400}
      onClose={close}
      open={selectedAgentId !== undefined}
      detail={
        selectedAgentId ? (
          <AgentProfileDetail agentId={selectedAgentId} />
        ) : null
      }
    >
      {/*
       * ON THE SHELL EVERY OTHER NAV DESTINATION USES. Hand-written measurements meant this screen
       * had no page title at all, section gaps that did not match its peers, and — because the shell
       * is where the scroller lives — no way to reach anything below the fold.
       */}
      <PageShell action={<NewBotButton />} title={t("Bots")}>
        {/*
         * THE COUNT IS IN THE HEADING, NOT IN A REFUSAL.
         *
         * Five per person is a real limit with a real reason — one VM each — and it used to be
         * spoken exactly once, by the sixth attempt failing. A person who can see 4/5 makes the
         * fifth one on purpose.
         */}
        <PageSection
          title={t("My Bots {used}/{total}", {
            total: seats.total,
            used: seats.used,
          })}
        >
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
                  const run = working?.find((it) => it.agentId === agent.id);
                  return (
                    <StaggerItem index={index} key={agent.id}>
                      <Link to="/agents" search={{ agent: agent.id }}>
                        <AgentCard
                          agent={agent}
                          status={run ? workingLabel(run) : undefined}
                        />
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
                  {t("Your Bots could not be loaded.")}
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
              /*
               * A DEAD END BEFORE. The empty roster said "you have not made a Bot yet" and offered
               * nothing to press: the button was in the header, in ghost grey, above a page whose
               * entire content was a sentence about not having pressed it.
               */
              <Empty className="h-auto w-full border border-dashed py-10">
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
                    {t("You have not made a Bot yet.")}
                  </EmptyTitle>
                  <p className="text-muted-foreground text-sm">
                    {t(
                      "It arrives with nothing set. What it does is decided in the conversation.",
                    )}
                  </p>
                </EmptyHeader>
                <NewBotButton
                  label={t("Make your first Bot")}
                  size="default"
                  variant="default"
                />
              </Empty>
            )}
          </div>
        </PageSection>
      </PageShell>
    </DetailPanel>
  );
}
