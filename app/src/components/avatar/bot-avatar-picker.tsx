import { BotAvatar } from "@/components/avatar/bot-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BOT_AVATAR_PALETTES,
  BOT_AVATAR_SHAPES,
  type BotAvatarParams,
  botAvatarParams,
  botAvatarSeed,
  randomBotAvatarSeed,
} from "@/lib/avatar/bot-avatar";
import { t } from "@/lib/i18n";

/**
 * Choosing a Bot's face: a body, a colour, and a shuffle.
 *
 * Two rows, because those are the two things a person decides (the owner's rule, and Grok Bot's:
 * its editor is "Character" — shape and colour — and nothing else). Every tile is the person's OWN
 * face with one thing changed, so the row reads as "what if it were a cloud" rather than as a wall
 * of strangers. The eyes are not chosen; they are what the Bot is feeling, and the preview above
 * the rows is the only face in the dialog that is allowed to move.
 *
 * One press applies — the contract every face picker here has had — and 완료 closes.
 */

const withAxis = (
  params: BotAvatarParams,
  axis: keyof BotAvatarParams,
  value: BotAvatarParams[keyof BotAvatarParams],
): string => botAvatarSeed({ ...params, [axis]: value });

const Row = ({
  label,
  options,
  axis,
  params,
  onSelect,
  pending,
}: {
  label: string;
  options: readonly { id: string; name: string }[];
  axis: keyof BotAvatarParams;
  params: BotAvatarParams;
  onSelect: (seed: string) => void;
  pending: boolean | undefined;
}) => (
  <fieldset className="flex flex-col gap-1.5">
    <legend className="pb-1 text-muted-foreground text-xs">{label}</legend>
    <div className="grid grid-cols-6 gap-1">
      {options.map((option) => {
        const seed = withAxis(
          params,
          axis,
          option.id as BotAvatarParams[typeof axis],
        );
        const chosen = params[axis] === option.id;
        return (
          <button
            aria-label={t(option.name)}
            aria-pressed={chosen}
            className={
              "flex size-9 items-center justify-center rounded-lg bg-[var(--sand-fill-secondary)] transition hover:scale-105 disabled:opacity-50" +
              (chosen
                ? " ring-2 ring-primary"
                : " hover:ring-1 hover:ring-border")
            }
            disabled={pending}
            key={option.id}
            onClick={() => onSelect(seed)}
            type="button"
          >
            <BotAvatar paused seed={seed} size={30} />
          </button>
        );
      })}
    </div>
  </fieldset>
);

export const BotAvatarPicker = ({
  open,
  onOpenChange,
  seed,
  onSelect,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seed: string | undefined;
  onSelect: (seed: string) => void;
  pending?: boolean;
}) => {
  const params = botAvatarParams(seed);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Pick a face")}</DialogTitle>
          <DialogDescription>
            {t("A click applies it right away.")}
          </DialogDescription>
        </DialogHeader>

        <div
          aria-busy={pending ? "true" : undefined}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col items-center gap-3">
            <BotAvatar seed={seed} size={128} state="curious" />
            <Button
              disabled={pending}
              onClick={() => onSelect(randomBotAvatarSeed())}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("Another face")}
            </Button>
          </div>

          <Row
            axis="shape"
            label={t("Shape")}
            onSelect={onSelect}
            options={BOT_AVATAR_SHAPES}
            params={params}
            pending={pending}
          />
          <Row
            axis="palette"
            label={t("Colour")}
            onSelect={onSelect}
            options={BOT_AVATAR_PALETTES}
            params={params}
            pending={pending}
          />
        </div>

        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            {t("Done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
