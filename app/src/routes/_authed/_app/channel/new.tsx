import type { Message } from "@ag-ui/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Mascot } from "@/components/agents/mascot";
import { RosterStrip } from "@/components/agents/roster-strip";
import { ChannelAvatar } from "@/components/channels/avatar";
import { canSend, type Recipient } from "@/components/channels/compose-state";
import { ConversationView } from "@/components/channels/conversation-view";
import { seedMessage } from "@/components/channels/transcript-messages";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  type AgentProfile,
  agentListQueryOptions,
  agentQueryOptions,
} from "@/lib/agents/queries";
import { useStartChannel } from "@/lib/channels/start";
import { t } from "@/lib/i18n";
import { useSkillCommands } from "@/lib/plugins/skill-commands";

/**
 * Creates the channel on first send. The selected coworker stays in the URL so profile links and
 * reloads preserve the pending recipient without creating an empty channel.
 */
export const Route = createFileRoute("/_authed/_app/channel/new")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { agent } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { start, pending } = useStartChannel();
  const { data: profiles, isPending: rosterPending } = useQuery(
    agentListQueryOptions(),
  );

  const [error, setError] = useState<string | null>(null);
  // Optimistic seed shown before the first channel record exists.
  const [sent, setSent] = useState<Message | null>(null);

  // Stale or private `?agent=` values are ignored because the roster is permission-filtered.
  const listed = profiles?.find((profile) => profile.id === agent);
  /**
   * Hidden coworkers are omitted from the roster but may still be valid recipients from a profile
   * link, so fetch the URL-selected coworker when it is absent from the visible list.
   */
  const { data: fetched } = useQuery({
    ...agentQueryOptions(agent ?? ""),
    enabled: Boolean(agent) && !listed,
    retry: false,
  });
  const chosen = listed ?? (fetched?.id === agent ? fetched : undefined);
  const recipients: Recipient[] = chosen
    ? [{ id: chosen.id, name: chosen.name }]
    : [];
  const skillCommands = useSkillCommands(chosen?.id ?? "");

  return (
    <div className="flex h-full flex-col">
      {/*
       * WHO THIS IS FOR, AS A FIELD THAT LOOKS LIKE ONE.
       *
       * This row used to be a bare label beside a borderless full-width combobox, so the only thing
       * a person could see was the word "To:" — squeezed to two lines, because nothing stopped the
       * flex row from shrinking it — and a chevron nine hundred pixels away at the edge of the
       * screen, attached to nothing. The field is bounded now, it has an edge, and its chevron is
       * inside it where a chevron belongs.
       */}
      <div className="sticky top-0 flex h-12 shrink-0 flex-row items-center gap-2 border-border border-b px-3">
        <span className="shrink-0 text-muted-foreground text-sm">
          {t("To:")}
        </span>
        <Combobox
          // Do not auto-open when the recipient came from the URL; the field is already answered.
          defaultOpen={false}
          autoHighlight
          items={profiles ?? []}
          isItemEqualToValue={(item: AgentProfile, value: AgentProfile) =>
            item.id === value.id
          }
          itemToStringLabel={(item: AgentProfile) => item.name}
          itemToStringValue={(item: AgentProfile) => item.id}
          onValueChange={(next) => {
            // Recipient changes are not separate navigation history entries.
            void navigate({
              replace: true,
              search: next ? { agent: next.id } : {},
            });
          }}
          value={chosen ?? null}
        >
          <ComboboxInput
            // The control that decides who the conversation goes to announced as "combobox, blank".
            aria-label={t("Choose a coworker")}
            className="h-8 w-full max-w-xs text-sm"
            placeholder={t("Choose a coworker…")}
          />
          <ComboboxContent className="min-w-0 max-w-lg" sideOffset={8}>
            <ComboboxEmpty>
              {rosterPending ? t("Loading coworkers…") : t("No agents found.")}
            </ComboboxEmpty>
            <ComboboxList>
              {(item: AgentProfile) => (
                <ComboboxItem key={item.id} value={item} className="h-10">
                  <ChannelAvatar participantIds={[item.id]} size={24} />
                  {item.name}
                  <span className="truncate text-muted-foreground ml-1">
                    {item.title}
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>
      <ConversationView
        // Commands must be loaded before the first channel message is sent.
        commands={skillCommands}
        emptyState={
          chosen ? (
            <div className="flex flex-col items-center gap-3 px-6 text-center">
              <span className="inline-flex size-20 overflow-hidden rounded-full ring-1 ring-border">
                <Mascot
                  className="size-full object-cover"
                  seed={chosen.avatarSeed}
                  size={80}
                />
              </span>
              <div className="flex flex-col gap-0.5">
                <span className="font-semibold text-[15px]">{chosen.name}</span>
                {chosen.title ? (
                  <span className="text-[12px] text-muted-foreground">
                    {chosen.title}
                  </span>
                ) : null}
              </div>
              {chosen.roleDescription ? (
                <p className="max-w-sm text-[13px] text-muted-foreground leading-relaxed">
                  {chosen.roleDescription}
                </p>
              ) : null}
            </div>
          ) : (
            /*
             * NOT A VOID. With nobody chosen this screen was six hundred pixels of white between a
             * combobox and a composer, and the one question it exists to ask — which colleague is
             * this for — was answerable only by typing into a field that did not look like one. The
             * team is a handful of drawn characters; pointing at one is faster than naming it, and
             * it is the same control Home uses for the same question.
             */
            <div className="pointer-events-auto flex flex-col items-center gap-4 px-6">
              <p className="text-[13px] text-muted-foreground">
                {t("Who is this for?")}
              </p>
              <RosterStrip
                onSelect={(agentId) =>
                  void navigate({ replace: true, search: { agent: agentId } })
                }
                roster={profiles ?? []}
                selectedId={undefined}
              />
            </div>
          )
        }
        disabled={recipients.length === 0}
        messages={sent ? [sent] : []}
        notice={
          error ? (
            <p className="pb-2 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null
        }
        onSubmit={async (draft) => {
          const recipient = recipients[0];
          if (!recipient || !canSend(recipients, draft.text)) return;

          setError(null);
          setSent(seedMessage(draft.text, crypto.randomUUID()));

          try {
            await start(recipient.id, draft.text);
          } catch (caught) {
            // Preserve the unsent draft when channel creation fails.
            setSent(null);
            setError(
              caught instanceof Error
                ? caught.message
                : "Could not start the conversation.",
            );
            throw caught;
          }
        }}
        pending={pending}
      />
    </div>
  );
}
