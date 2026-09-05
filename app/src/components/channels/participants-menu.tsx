import { IconPlus, IconUserMinus, IconUsers } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentListQueryOptions } from "@/lib/agents/queries";
import type { AgentChannel } from "@/lib/channels/queries";
import {
  addParticipantMutationOptions,
  removeParticipantMutationOptions,
} from "@/lib/channels/mutations";
import { t } from "@/lib/i18n";

/**
 * Who is in this conversation, and the two things a person can do about it.
 *
 * THERE WAS NO WAY TO SEE OR CHANGE THIS. A room's membership was decided once, when it was
 * created, and after that the only evidence of who was in it was the comma-separated name in the
 * header — which truncates. Somebody who wanted a fourth colleague had to start a new room and
 * leave everything already said behind in the old one.
 *
 * On the header rather than in the settings pane, because the question it answers ("who is in
 * here?") is asked while looking at the conversation, not while configuring one.
 */
export const ParticipantsMenu = ({ channel }: { channel: AgentChannel }) => {
  const queryClient = useQueryClient();
  const roster = useQuery(agentListQueryOptions());
  const add = useMutation(addParticipantMutationOptions(queryClient));
  const remove = useMutation(removeParticipantMutationOptions(queryClient));
  /**
   * The last refusal, in this surface's words.
   *
   * Held here rather than thrown away: the two things this menu refuses — the last pair, and a Bot
   * already in — are both presses that look like they should work, and a control that does nothing
   * and says nothing is the failure this whole change exists to stop.
   */
  const [refusal, setRefusal] = useState<string | null>(null);

  const members = channel.agentIds.flatMap((agentId) => {
    const profile = roster.data?.find((agent) => agent.id === agentId);
    return profile ? [profile] : [];
  });
  const others = (roster.data ?? []).filter(
    (agent) => !channel.agentIds.includes(agent.id),
  );
  // The server refuses to leave a room with one member; the button says so before it is pressed.
  const canRemove = channel.agentIds.length > 2;
  const isBusy = add.isPending || remove.isPending;

  const handleChange = (
    run: () => Promise<unknown>,
  ): Promise<void> | undefined => {
    setRefusal(null);
    return run()
      .then(() => undefined)
      .catch((caught: unknown) => {
        setRefusal(
          caught instanceof Error
            ? caught.message
            : t("That change could not be made."),
        );
      });
  };

  return (
    <DropdownMenu onOpenChange={() => setRefusal(null)}>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={t("Who is in this conversation")}
            size="icon"
            title={t("Who is in this conversation")}
            variant="ghost"
          >
            <IconUsers className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          {/* Base UI's MenuGroupLabel reads a group context and THROWS without one, which took
              the whole screen down the first time this menu was opened. */}
          <DropdownMenuLabel>
            {t("In this conversation ({count})", {
              count: String(channel.agentIds.length),
            })}
          </DropdownMenuLabel>
          {members.map((member) => (
            <DropdownMenuItem
              className="justify-between gap-2"
              closeOnClick={false}
              disabled={!canRemove || isBusy}
              key={member.id}
              onClick={() =>
                void handleChange(() =>
                  remove.mutateAsync({
                    agentId: member.id,
                    channelId: channel.id,
                  }),
                )
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <BotAvatar seed={member.avatarSeed} size={20} />
                <span className="truncate">{member.name}</span>
              </span>
              <IconUserMinus aria-hidden="true" className="size-4 shrink-0" />
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {others.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("Add someone")}</DropdownMenuLabel>
              {others.map((agent) => (
                <DropdownMenuItem
                  className="justify-between gap-2"
                  closeOnClick={false}
                  disabled={isBusy}
                  key={agent.id}
                  onClick={() =>
                    void handleChange(() =>
                      add.mutateAsync({
                        agentId: agent.id,
                        channelId: channel.id,
                      }),
                    )
                  }
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <BotAvatar seed={agent.avatarSeed} size={20} />
                    <span className="truncate">{agent.name}</span>
                  </span>
                  <IconPlus aria-hidden="true" className="size-4 shrink-0" />
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        ) : null}
        {refusal ? (
          <p className="px-2 py-1.5 text-destructive text-xs" role="alert">
            {refusal}
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
