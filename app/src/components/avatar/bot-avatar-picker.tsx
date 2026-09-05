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
  BOT_AVATAR_ACCESSORIES,
  BOT_AVATAR_PALETTES,
  BOT_AVATAR_SHAPES,
  type BotAvatarParams,
  botAvatarParams,
  botAvatarSeed,
  randomBotAvatarSeed,
} from "@/lib/avatar/bot-avatar";
import { t } from "@/lib/i18n";

/**
 * Choosing a Bot's face, three rows and a shuffle.
 *
 * THE GRID OF THIRTY-FIVE IS GONE, AND SO IS THE DECISION IT ASKED FOR. A wall of finished
 * characters is a catalogue: somebody has to look at all of it, compare a cat with a robot, and
 * pick — and whatever they pick, the one thing they cannot do is get the face they had in mind. The
 * axes are separable now, so they are separated: a shape, a colour, a small thing on the head. Each
 * row is short enough to take in at a glance and every tile is the person's OWN face with one thing
 * changed, so the row reads as "what if it were green" rather than as a list of strangers.
 *
 * Eyes have no row. Four variants that differ by two pixels of eyelid cost a decision and return
 * nothing a person can see from across a table; the shuffle deals them.
 *
 * One press applies, as it always did — the same contract the mascot picker had, and the reason
 * there is no Save. 완료 closes, and undoing is pressing another tile.
 */

/** A tile is the current face with exactly one axis moved, so the row reads as a variation. */
const withAxis = (
  params: BotAvatarParams,
  axis: keyof BotAvatarParams,
  value: number,
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
    <div className="flex flex-row flex-wrap gap-1.5">
      {options.map((option, index) => {
        const seed = withAxis(params, axis, index);
        const chosen = params[axis] === index;
        return (
          <button
            aria-label={t(option.name)}
            aria-pressed={chosen}
            className={
              // ring-primary is the app's one selection colour, the same as the roster's.
              "flex size-11 items-center justify-center rounded-xl bg-[var(--sand-fill-secondary)] ring-offset-2 ring-offset-background transition hover:scale-105 disabled:opacity-50" +
              (chosen
                ? " ring-2 ring-primary"
                : " hover:ring-1 hover:ring-border")
            }
            disabled={pending}
            key={option.id}
            onClick={() => onSelect(seed)}
            type="button"
          >
            {/* 34px: under the animation floor on purpose — a row of eleven blinking tiles is
             * eleven things moving while somebody is trying to compare them. */}
            <BotAvatar seed={seed} size={34} />
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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Pick a face")}</DialogTitle>
          {/* Says out loud what the missing Save button implies. */}
          <DialogDescription>
            {t("A click applies it right away.")}
          </DialogDescription>
        </DialogHeader>

        <div
          aria-busy={pending ? "true" : undefined}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col items-center gap-3">
            {/* Big enough that the face is alive here and nowhere else in this dialog. */}
            <BotAvatar seed={seed} size={128} />
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
          <Row
            axis="accessory"
            label={t("Accessory")}
            onSelect={onSelect}
            options={BOT_AVATAR_ACCESSORIES}
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
