import type { Persona } from "@shared/persona";
import { IconDots, IconPlugConnected } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { focusRing } from "@/components/ui/focus";
import { t } from "@/lib/i18n";
import {
  categoryLabel,
  ideaDraft,
  ideaFor,
  ideaReason,
  type OfferedIdea,
} from "@/lib/ideas/queries";
import { cn } from "@/lib/utils";

/**
 * One 아이디어: what the Bot will do, what comes out, and why it is here.
 *
 * THE WHOLE CARD IS THE PRESS, AND IT SENDS NOTHING. A card somebody can ask now opens the
 * conversation with its sentence in the composer (`?draft=`, `composer/prefill.ts`) for them to
 * finish and send; the model is not called until they do. With no conversation yet — a Bot nobody
 * has spoken to — the compose screen takes the sentence the same way. A card that waits on a
 * connection goes to 연결, and says so before it is pressed.
 *
 * 다음에 SITS BEHIND ⋯, OUTSIDE THE PRESS. A button inside a link is two presses in one place; the
 * menu is beside the card's content, not in it.
 */
export function IdeaCard({
  agentId,
  card,
  channelId,
  onDismiss,
  persona,
}: {
  agentId: string | undefined;
  card: OfferedIdea;
  channelId: string | undefined;
  onDismiss: () => void;
  persona: Persona | null;
}) {
  const idea = ideaFor(card);
  // A key a newer server knows and this build does not: nothing to say about it, so nothing drawn.
  if (!idea) return null;
  const reason = ideaReason(card, persona);
  const isConnect = card.state === "connect";
  const title = t(idea.title);

  const body = (
    <>
      <span className="text-muted-foreground text-xs">
        {categoryLabel(idea.category)}
      </span>
      <span className="font-medium text-base leading-6">{title}</span>
      <span className="text-muted-foreground text-sm">{t(idea.makes)}</span>
      {reason ? (
        <span
          className={cn(
            "mt-1 flex items-center gap-1 text-xs",
            reason.kind === "connect"
              ? "text-warning"
              : "text-muted-foreground",
          )}
          data-idea-reason={reason.kind}
        >
          {reason.kind === "connect" ? (
            <IconPlugConnected aria-hidden="true" className="size-3.5" />
          ) : null}
          {reason.text}
        </span>
      ) : null}
      {idea.kind === "routine" && !isConnect ? (
        <span className="text-muted-foreground text-xs">
          {t(
            "It repeats at the time in the sentence. Change the time before you send it.",
          )}
        </span>
      ) : null}
    </>
  );

  const linkClass = cn(
    "flex min-w-0 flex-1 flex-col gap-1 rounded-xl p-4 pr-12 text-left transition-colors hover:bg-accent",
    focusRing,
  );

  return (
    <div
      className="relative flex rounded-xl border border-border bg-card"
      data-idea={card.key}
      data-idea-state={card.state}
    >
      {isConnect ? (
        <Link className={linkClass} to="/settings/connected-accounts">
          {body}
        </Link>
      ) : channelId ? (
        <Link
          className={linkClass}
          params={{ channelId }}
          search={{ draft: ideaDraft(idea) }}
          to="/channel/$channelId"
        >
          {body}
        </Link>
      ) : (
        <Link
          className={linkClass}
          search={{
            ...(agentId ? { agent: agentId } : {}),
            draft: ideaDraft(idea),
          }}
          to="/channel/new"
        >
          {body}
        </Link>
      )}
      <div className="absolute top-2 right-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={t("Options for “{title}”", { title })}
                size="icon-sm"
                variant="ghost"
              >
                <IconDots />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-auto">
            <DropdownMenuItem className="whitespace-nowrap" onClick={onDismiss}>
              {t("Not now")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
