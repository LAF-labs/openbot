import { MASCOT_TILES, Mascot, mascotIdFor } from "@/components/agents/mascot";
import {
  Dialog,
  DialogContent,
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
                aria-label={tile.id}
                className={
                  "overflow-hidden rounded-xl ring-offset-2 ring-offset-background transition disabled:opacity-50" +
                  (chosen
                    ? " ring-2 ring-foreground"
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
