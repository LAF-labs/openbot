import type { DocBlockKind } from "@/lib/hub/docs";
import { kindLabel } from "@/lib/hub/docs";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The `/` menu: what an empty block can become. Opened by typing `/` into an empty block, narrowed
 * by what follows (`/제목`, `/h2`), chosen with the arrows and Enter or a click. The keys are the
 * block's (`doc-block.tsx`), so the caret never leaves the box while the menu is open.
 */
export function SlashMenu({
  choices,
  onChoose,
  selected,
}: {
  choices: readonly DocBlockKind[];
  onChoose: (kind: DocBlockKind) => void;
  selected: number;
}) {
  return (
    <div
      aria-label={t("Block kind")}
      className="absolute top-full left-0 z-20 mt-1 flex max-h-72 w-56 flex-col overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground text-sm shadow-md"
      data-doc-slash-menu
      role="listbox"
    >
      {choices.map((kind, index) => (
        <button
          aria-selected={index === selected}
          className={cn(
            "flex h-8 shrink-0 items-center rounded-md px-2 text-left",
            index === selected ? "bg-muted" : "hover:bg-muted/60",
          )}
          data-doc-kind-choice={kind}
          key={kind}
          // Chosen on press, before the box would lose focus to the button.
          onMouseDown={(event) => {
            event.preventDefault();
            onChoose(kind);
          }}
          role="option"
          type="button"
        >
          {kindLabel(kind)}
        </button>
      ))}
    </div>
  );
}
