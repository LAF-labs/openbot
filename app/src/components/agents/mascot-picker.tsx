import { MASCOT_TILES, Mascot, mascotIdFor } from "@/components/agents/mascot";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/lib/i18n";

/**
 * Choosing a Bot's face.
 *
 * The whole set, in one grid, at a size where the difference between two of them is visible — a
 * picker that needs a second look to tell a cat from a dog has not saved anybody the trouble of
 * scrolling. One click chooses and closes: there is no Save, because there is nothing to get wrong
 * and undoing it is picking another one.
 */
export function MascotPicker({
  open,
  onOpenChange,
  seed,
  onSelect,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seed: string | undefined;
  onSelect: (id: string) => void;
  pending?: boolean;
}) {
  const currentId = mascotIdFor(seed);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("Pick a face")}</DialogTitle>
          {/* Says out loud what the missing Save button implies. */}
          <DialogDescription>
            {t("A click applies it right away.")}
          </DialogDescription>
        </DialogHeader>
        <div
          className="grid grid-cols-7 gap-2"
          aria-busy={pending ? "true" : undefined}
        >
          {MASCOT_TILES.map((tile) => {
            const chosen = tile.id === currentId;
            return (
              <button
                key={tile.id}
                type="button"
                disabled={pending}
                onClick={() => onSelect(tile.id)}
                aria-pressed={chosen}
                // What the drawing is, not where it sits in the grid.
                aria-label={t(tile.name)}
                className={
                  // ring-primary, matching the home roster's selection ring: chosen is the one
                  // selection state in the app, and blue is its one color.
                  "overflow-hidden rounded-xl ring-offset-2 ring-offset-background transition hover:scale-105 disabled:opacity-50" +
                  (chosen
                    ? " ring-2 ring-primary"
                    : " hover:ring-2 hover:ring-muted-foreground/40")
                }
                style={{ background: tile.background }}
              >
                <Mascot className="size-full" seed={tile.id} size={64} />
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
