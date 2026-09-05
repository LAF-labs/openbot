import { BotAvatar } from "@/components/avatar/bot-avatar";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { ROOM_SUGGESTIONS } from "./room-suggestions";

/**
 * What a room says before anybody has said anything in it.
 *
 * A NEW ROOM WAS A BLANK PANE. Measured 2026-09-06: between the header and the composer there was
 * nothing at all — no faces, no names, no hint that this screen differs from a one-to-one chat.
 * Somebody who has just put three colleagues in a room together is looking at the one moment where
 * "what is this for" has to be answered, and the answer was six hundred pixels of white.
 *
 * The one-to-one screen already introduces its coworker here (`BotIntroCard` on `/channel/new`), so
 * this is the same idea for the case where there are several: who is in it, what a room is, and
 * three things to try. The chips are the part that matters most — a person who has never used one
 * does not know that a room's members answer in turn, and reading a sentence about it is a weaker
 * way to find out than pressing one and watching.
 */
export const RoomIntro = ({
  members,
  onSuggest,
}: {
  members: readonly { id: string; name: string; avatarSeed: string }[];
  /** Send one of the suggestions as the room's first message. */
  onSuggest?: (text: string) => void;
}) => {
  return (
    <div className="pointer-events-auto flex max-w-md flex-col items-center gap-4 px-6 text-center">
      <div className="flex flex-row items-center justify-center -space-x-2">
        {members.map((member) => (
          // `ring-background`: these overlap, and without a ring of the page's own ground two
          // drawn characters read as one smudge. Same reason as the stack in `avatar.tsx`.
          <div className="rounded-full ring-2 ring-background" key={member.id}>
            <BotAvatar seed={member.avatarSeed} size={48} />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <span className="font-semibold text-[15px]">
          {members.map((member) => member.name).join(", ")}
        </span>
        <p className="text-[13px] text-muted-foreground leading-relaxed">
          {t(
            "Everyone here answers the same message in turn. Address one with @, or ask them all at once.",
          )}
        </p>
      </div>
      {onSuggest ? (
        <div className="flex flex-row flex-wrap items-center justify-center gap-2">
          {ROOM_SUGGESTIONS.map((suggestion) => (
            <Button
              className="h-8 rounded-full text-xs"
              key={suggestion}
              onClick={() => onSuggest(t(suggestion))}
              size="sm"
              type="button"
              variant="outline"
            >
              {t(suggestion)}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
};
