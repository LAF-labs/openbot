import type { Message } from "@ag-ui/core";
import { IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { BotIntroCard } from "@/components/agents/bot-intro-card";
import { RosterStrip } from "@/components/agents/roster-strip";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  addRecipient,
  canSend,
  type Recipient,
  removeRecipient,
} from "@/components/channels/compose-state";
import { ConversationView } from "@/components/channels/conversation-view";
import { seedMessage } from "@/components/channels/transcript-messages";
import { agentListQueryOptions, agentQueryOptions } from "@/lib/agents/queries";
import { useStartChannel } from "@/lib/channels/start";
import { focusRing } from "@/components/ui/focus";
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
  const { start, pending } = useStartChannel();
  const { data: profiles } = useQuery(agentListQueryOptions());

  const [error, setError] = useState<string | null>(null);
  // Optimistic seed shown before the first channel record exists.
  const [sent, setSent] = useState<Message | null>(null);

  // Stale or private `?agent={` values are ignored because the roster is permission-filtered.
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
   * This was derived straight from `}?agent={`, so the recipient field's chips and its remove buttons
   * were decoration — nothing they did could change what the screen would send. A room holds
   * several Bots now, so the field has to be the source of truth; the URL seeds it and then stops
   * being consulted.
   */
  const [picked, setPicked] = useState<Recipient[] | null>(null);
  const seeded: Recipient[] = chosen
    ? [{ id: chosen.id, name: chosen.name }]
    : [];
  const recipients = picked ?? seeded;
  // Skills are the first member's; a room's `}/` menu cannot offer four Bots' commands at once.
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
      {/*
       * WHO IS IN THE ROOM, AS CHIPS. ONE PICKER, NOT TWO.
       *
       * This row used to hold a combobox, and the middle of the screen held a row of faces, and
       * both of them answered the same question in different ways — measured 2026-09-06: picking a
       * face and picking from the list did not visibly agree, because only the combobox drew chips
       * and only the face row could show who was chosen. The faces won: a roster is a handful of
       * drawn characters and pointing at one is faster than typing its name. What is left here is
       * the answer, in the place a messaging app puts it, with an × on each.
       */}
      <div className="sticky top-0 flex h-12 shrink-0 flex-row items-center gap-2 overflow-x-auto border-border border-b px-3">
        <span className="shrink-0 text-muted-foreground text-sm">
          {t("To:")}
        </span>
        {recipients.length === 0 ? (
          <span className="text-muted-foreground/70 text-sm">
            {t("Pick a Bot below")}
          </span>
        ) : null}
        {recipients.map((recipient) => (
          <span
            className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-[var(--sand-fill-secondary)] py-0.5 ps-1 pe-1 text-sm"
            key={recipient.id}
          >
            <ChannelAvatar participantIds={[recipient.id]} size={20} />
            <span className="max-w-32 truncate">{recipient.name}</span>
            <button
              aria-label={t("Remove {name}", { name: recipient.name })}
              className={`flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--sand-fill-ghost-selected)] hover:text-foreground ${focusRing}`}
              onClick={() =>
                setPicked(removeRecipient(recipients, recipient.id))
              }
              type="button"
            >
              <IconX className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <ConversationView
        // Commands must be loaded before the first channel message is sent.
        commands={skillCommands}
        emptyState={
          /*
           * ONE PICKER, ALWAYS THE SAME ONE.
           *
           * This used to be either/or: with nobody chosen, a row of faces; with somebody chosen,
           * the Bot's profile card and no way back to the roster except the combobox in the header
           * that is now gone. A room holds up to eight, so the picker has to stay on screen while
           * the room is being built, and every face in it has to be able to show that it is in.
           *
           * The profile card is kept for the one case it was written for — a Bot made a moment ago,
           * with nothing set, and this is the first screen of its life — which is exactly the case
           * where exactly one is chosen.
           */
          <div className="pointer-events-auto flex w-full flex-col items-center gap-4 px-6">
            <p className="text-[13px] text-muted-foreground">
              {/*
               * PLURAL-NEUTRAL. "누구에게 보낼까요?" asks for one person, and this screen has been
               * able to build a room of several since before that line was written — it contradicted
               * the rooms in the sidebar beside it.
               */}
              {t("Who should be in this conversation?")}
            </p>
            <RosterStrip
              onSelect={(agentId) => {
                const profile = (profiles ?? []).find(
                  (candidate) => candidate.id === agentId,
                );
                if (!profile) return;
                /*
                 * A press TOGGLES. The faces were add-only and the only way to take one back out
                 * was the × on its chip, so pressing a chosen face did nothing at all and looked
                 * broken. `aria-pressed` on the tile already said these were toggles.
                 */
                setPicked(
                  recipients.some((recipient) => recipient.id === agentId)
                    ? removeRecipient(recipients, agentId)
                    : addRecipient(recipients, {
                        id: profile.id,
                        name: profile.name,
                      }),
                );
              }}
              roster={profiles ?? []}
              selectedId={undefined}
              selectedIds={recipients.map((recipient) => recipient.id)}
            />
            {chosen && recipients.length === 1 ? (
              /*
               * THE PROFILE CARD, WHERE THE FORM USED TO BE.
               *
               * A Bot is made in one press and lands here with a name it was given and nothing else
               * set, so the first screen of its life has to be the place its name, its face and its
               * job are decided — beside the conversation that will decide the rest, not in a pane
               * somebody has to go looking for.
               *
               * `key` on the Bot's id: the pane stays mounted while the choice changes, and without
               * it one Bot's name sits in the field belonging to another.
               */
              <div className="flex w-full flex-col items-center gap-3 text-center">
                {chosen.canManage ? (
                  <BotIntroCard agent={chosen} key={chosen.id} />
                ) : (
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold text-[15px]">
                      {chosen.name}
                    </span>
                    {chosen.title ? (
                      <span className="text-[12px] text-muted-foreground">
                        {chosen.title}
                      </span>
                    ) : null}
                  </div>
                )}
                {chosen.roleDescription ? (
                  <p className="max-w-sm text-[13px] text-muted-foreground leading-relaxed">
                    {chosen.roleDescription}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
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
