import type { Message } from "@ag-ui/core";
import { IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { RosterStrip } from "@/components/agents/roster-strip";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  addRecipient,
  canSend,
  MAX_RECIPIENTS,
  type Recipient,
  removeRecipient,
} from "@/components/channels/compose-state";
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
  /*
   * STATE, NOT A READING OF THE URL.
   *
   * This was derived straight from `?agent=`, so the recipient field's chips and its remove buttons
   * were decoration — nothing they did could change what the screen would send. A room holds
   * several Bots now, so the field has to be the source of truth; the URL seeds it and then stops
   * being consulted.
   */
  const [picked, setPicked] = useState<Recipient[] | null>(null);
  const seeded: Recipient[] = chosen
    ? [{ id: chosen.id, name: chosen.name }]
    : [];
  const recipients = picked ?? seeded;
  // Skills are the first member's; a room's `/` menu cannot offer four Bots' commands at once.
  const skillCommands = useSkillCommands(recipients[0]?.id ?? "");

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
        {/*
         * WHO IS IN THE ROOM, AS CHIPS YOU CAN TAKE BACK OUT.
         *
         * The field held one value and the combobox replaced it, so building a room of three was
         * impossible from this screen even after the server and the transcript both supported one.
         * Each pick is added; each chip removes itself.
         */}
        {recipients.map((recipient) => (
          <span
            className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-[var(--sand-fill-secondary)] py-0.5 ps-1 pe-1 text-sm"
            key={recipient.id}
          >
            <ChannelAvatar participantIds={[recipient.id]} size={20} />
            <span className="max-w-32 truncate">{recipient.name}</span>
            <button
              aria-label={t("Remove {name}", { name: recipient.name })}
              className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--sand-fill-ghost-selected)] hover:text-foreground"
              onClick={() =>
                setPicked(removeRecipient(recipients, recipient.id))
              }
              type="button"
            >
              <IconX className="size-3" />
            </button>
          </span>
        ))}
        <Combobox
          // Do not auto-open when the recipient came from the URL; the field is already answered.
          defaultOpen={false}
          autoHighlight
          items={(profiles ?? []).filter(
            (profile) =>
              !recipients.some((recipient) => recipient.id === profile.id),
          )}
          isItemEqualToValue={(item: AgentProfile, value: AgentProfile) =>
            item.id === value.id
          }
          itemToStringLabel={(item: AgentProfile) => item.name}
          itemToStringValue={(item: AgentProfile) => item.id}
          onValueChange={(next) => {
            if (!next) return;
            setPicked(
              addRecipient(recipients, { id: next.id, name: next.name }),
            );
          }}
          // Always empty: this control ADDS to the room, and the room is drawn as chips beside it.
          value={null}
        >
          <ComboboxInput
            // The control that decides who the conversation goes to announced as "combobox, blank".
            aria-label={t("Choose a Bot")}
            className="h-8 w-full max-w-xs text-sm"
            disabled={recipients.length >= MAX_RECIPIENTS}
            placeholder={
              recipients.length === 0 ? t("Choose a Bot…") : t("Add another…")
            }
          />
          <ComboboxContent className="min-w-0 max-w-lg" sideOffset={8}>
            <ComboboxEmpty>
              {rosterPending ? t("Loading Bots…") : t("No Bots found.")}
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
              <BotAvatar seed={chosen.avatarSeed} size={80} />
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
          if (!canSend(recipients, draft.text)) return;

          setError(null);
          setSent(seedMessage(draft.text, crypto.randomUUID()));

          try {
            await start(
              recipients.map((recipient) => recipient.id),
              draft.text,
            );
          } catch (caught) {
            // Preserve the unsent draft when channel creation fails.
            setSent(null);
            setError(
              caught instanceof Error
                ? caught.message
                : t("Could not start the conversation."),
            );
            throw caught;
          }
        }}
        pending={pending}
      />
    </div>
  );
}
