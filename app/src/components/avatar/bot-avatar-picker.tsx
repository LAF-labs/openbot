import { useState } from "react";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { LiveRegion } from "@/components/layout/live-region";
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
import { pressOnce } from "@/lib/press";

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
  /** Saves the face. Resolves once it is saved; throws the person's sentence when it is not. */
  onSelect: (seed: string) => Promise<unknown>;
  pending?: boolean;
}) => {
  const params = botAvatarParams(seed);
  /*
   * WHAT A CHOICE CAME TO, SAID HERE. A face that did not save was said nowhere: the press's
   * promise rejected into the console, and the preview simply stayed as it was — which looks
   * exactly like a tile that was never pressed.
   */
  const [isApplying, setIsApplying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Saving a face is this dialog's one action: while it is out, nothing closes it or picks again.
  const isBusy = isApplying || pending === true;

  const handleSelect = async (chosen: string) => {
    if (isBusy) return;
    setFailure(null);
    setIsApplying(true);
    const outcome = await pressOnce({ act: () => onSelect(chosen) });
    setIsApplying(false);
    if (outcome.kind === "failed") setFailure(outcome.sentence);
  };

  return (
    <Dialog
      isBusy={isBusy}
      onOpenChange={onOpenChange}
      // Every open starts clean: the last failure was about a choice already left behind.
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) setFailure(null);
      }}
      open={open}
    >
      {/* One way out: a click applies, and 완료 closes. A second × beside it asked what it did. */}
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("Pick a face")}</DialogTitle>
          <DialogDescription>
            {t("A click applies it right away.")}
          </DialogDescription>
        </DialogHeader>

        <div
          aria-busy={isBusy ? "true" : undefined}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col items-center gap-3">
            <BotAvatar seed={seed} size={128} state="curious" />
            <Button
              disabled={isBusy}
              onClick={() => void handleSelect(randomBotAvatarSeed())}
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
            onSelect={(chosen) => void handleSelect(chosen)}
            options={BOT_AVATAR_SHAPES}
            params={params}
            pending={isBusy}
          />
          <Row
            axis="palette"
            label={t("Colour")}
            onSelect={(chosen) => void handleSelect(chosen)}
            options={BOT_AVATAR_PALETTES}
            params={params}
            pending={isBusy}
          />
        </div>

        <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
          {failure}
        </LiveRegion>

        <DialogFooter>
          <Button
            disabled={isBusy}
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
