import { IconFile, IconLayoutKanban } from "@tabler/icons-react";
import { type KeyboardEvent, useState } from "react";
import { focusRingBare } from "@/components/ui/focus";
import type { DocBlockKind } from "@/lib/hub/docs";
import { kindLabel } from "@/lib/hub/docs";
import { t } from "@/lib/i18n";
import { isImeKey } from "@/lib/ime";
import { cn } from "@/lib/utils";
import {
  blockKeyAction,
  kindFromMarkdownStart,
  menuMatches,
  slashQuery,
} from "./block-keys";
import { BlockTextarea } from "./block-textarea";
import type { DocController, DocRow } from "./doc-controller";
import { tableRows } from "./doc-controller";
import { InlineMarkdown } from "./inline-markdown";
import { SlashMenu } from "./slash-menu";
import { TableBlock } from "./table-block";

/** The look of each kind, the same whether the block is being written in or only shown. */
function kindClass(kind: DocBlockKind): string {
  switch (kind) {
    case "heading1":
      return "text-2xl font-semibold leading-snug";
    case "heading2":
      return "text-xl font-semibold leading-snug";
    case "heading3":
      return "text-lg font-semibold leading-snug";
    case "quote":
      return "border-l-2 border-border pl-3 text-muted-foreground";
    case "code":
      return "rounded-md bg-muted px-3 py-2 font-mono text-sm whitespace-pre-wrap";
    default:
      return "leading-relaxed";
  }
}

/**
 * One block of a document: its markdown when nobody is writing in it, its box when this person is,
 * and "민수 님이 쓰는 중" — read-only — when a colleague is.
 */
export function DocBlockView({
  controller,
  caret,
  holderName,
  isActive,
  row,
}: {
  controller: DocController;
  caret: number | "end";
  /** The colleague writing in this block, or null. */
  holderName: string | null;
  isActive: boolean;
  row: DocRow;
}) {
  const { block } = row;
  const isHeld = holderName !== null;

  if (block.kind === "divider") {
    return (
      <div className="py-2" data-doc-block={block.id} data-doc-kind="divider">
        <hr className="border-border" />
      </div>
    );
  }

  if (block.kind === "file" || block.kind === "task-link") {
    const name =
      typeof block.attrs.name === "string"
        ? block.attrs.name
        : typeof block.attrs.title === "string"
          ? block.attrs.title
          : block.text || kindLabel(block.kind);
    const Icon = block.kind === "file" ? IconFile : IconLayoutKanban;
    return (
      <div
        className="py-1"
        data-doc-block={block.id}
        data-doc-kind={block.kind}
      >
        <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-sm">
          <Icon className="size-4 text-muted-foreground" />
          {name}
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative rounded-md py-1 transition-colors",
        isHeld && "bg-muted/50 ring-1 ring-border",
      )}
      data-doc-block={block.id || row.key}
      data-doc-held={isHeld ? "" : undefined}
      data-doc-kind={block.kind}
    >
      {isHeld ? (
        <span
          className="absolute -top-2.5 right-1 rounded bg-background px-1.5 text-muted-foreground text-xs"
          data-doc-holder
        >
          {t("{name} is writing", { name: holderName })}
        </span>
      ) : null}
      <div className="flex items-start gap-2">
        {block.kind === "list" ? (
          <span aria-hidden className="select-none pt-px leading-relaxed">
            •
          </span>
        ) : null}
        {block.kind === "check" ? (
          <input
            aria-label={t("Done")}
            checked={block.attrs.checked === true}
            className="mt-1.5 size-4 shrink-0 accent-primary"
            disabled={isHeld}
            onChange={() => controller.toggleCheck(row.key)}
            type="checkbox"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          {block.kind === "table" ? (
            <TableBlock
              isReadOnly={isHeld}
              onEnter={() => controller.focus(row.key)}
              onLeave={() => {
                if (controller.snapshot().activeKey === row.key) {
                  controller.leave();
                }
              }}
              onRows={(rows) => controller.setTable(row.key, rows)}
              rows={tableRows(block)}
            />
          ) : isActive ? (
            <ActiveBox caret={caret} controller={controller} row={row} />
          ) : (
            <ShownText
              isHeld={isHeld}
              onOpen={() => controller.focus(row.key, "end")}
              row={row}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** The block's markdown, pressed to write in it. */
function ShownText({
  isHeld,
  onOpen,
  row,
}: {
  isHeld: boolean;
  onOpen: () => void;
  row: DocRow;
}) {
  const { block } = row;
  const isDone = block.kind === "check" && block.attrs.checked === true;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a block of text that opens into its box, not a button's look.
    <div
      aria-disabled={isHeld || undefined}
      aria-label={block.text ? undefined : t("Empty block")}
      className={cn(
        "min-h-[1.75em] cursor-text whitespace-pre-wrap break-words rounded-sm",
        kindClass(block.kind),
        isDone && "text-muted-foreground line-through",
        isHeld && "cursor-default",
        focusRingBare,
      )}
      data-doc-text
      // A held block is pressed too: the editor refuses it and says who is writing there.
      onClick={onOpen}
      onKeyDown={(event) => {
        if (!isHeld && event.key === "Enter") {
          event.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={isHeld ? -1 : 0}
    >
      {block.kind === "code" ? (
        block.text
      ) : (
        <InlineMarkdown text={block.text} />
      )}
    </div>
  );
}

/** The block being written in: its box, its keys, and the `/` menu. */
function ActiveBox({
  caret,
  controller,
  row,
}: {
  caret: number | "end";
  controller: DocController;
  row: DocRow;
}) {
  const { block, key } = row;
  const [menu, setMenu] = useState<{ query: string; selected: number } | null>(
    null,
  );
  const [isMenuDismissed, setIsMenuDismissed] = useState(false);
  const choices = menu ? menuMatches(menu.query, kindLabel) : [];
  const isMenuOpen = menu !== null && !isMenuDismissed && choices.length > 0;

  const choose = (kind: DocBlockKind) => {
    setMenu(null);
    controller.setKind(key, kind, "");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = isImeKey(event);
    if (isMenuOpen && !composing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setMenu({
          query: menu.query,
          selected: (menu.selected + step + choices.length) % choices.length,
        });
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const kind = choices[menu.selected];
        if (kind) choose(kind);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setIsMenuDismissed(true);
        return;
      }
    }
    const element = event.currentTarget;
    const action = blockKeyAction({
      key: event.key,
      shift: event.shiftKey,
      mod: event.metaKey || event.ctrlKey,
      alt: event.altKey,
      composing,
      value: element.value,
      selectionStart: element.selectionStart,
      selectionEnd: element.selectionEnd,
      kind: block.kind,
    });
    switch (action.type) {
      case "none":
        return;
      case "split":
        event.preventDefault();
        controller.split(key, action.head, action.tail);
        return;
      case "remove":
        event.preventDefault();
        controller.remove(key);
        return;
      case "merge-up":
        event.preventDefault();
        controller.mergeUp(key);
        return;
      case "to-paragraph":
        event.preventDefault();
        controller.setKind(key, "paragraph", element.value);
        return;
      case "focus-prev":
        event.preventDefault();
        controller.focusAbove(key);
        return;
      case "focus-next":
        event.preventDefault();
        controller.focusBelow(key);
        return;
      case "leave":
        event.preventDefault();
        element.blur();
        return;
    }
  };

  const handleText = (value: string, isComposing: boolean) => {
    if (!isComposing && block.kind === "paragraph") {
      const start = kindFromMarkdownStart(value);
      if (start) {
        controller.setKind(key, start.kind, start.rest);
        return;
      }
    }
    const query = block.kind === "code" ? null : slashQuery(value);
    if (query === null) {
      setMenu(null);
      setIsMenuDismissed(false);
    } else {
      setMenu({ query, selected: 0 });
    }
    controller.input(key, value);
  };

  return (
    <div className="relative">
      <BlockTextarea
        ariaLabel={kindLabel(block.kind)}
        caret={caret}
        className={kindClass(block.kind)}
        onBlur={() => {
          // A box that closes because the caret moved to another block is not leaving the page.
          if (controller.snapshot().activeKey === key) controller.leave();
        }}
        onCompositionEnd={(value) => controller.compositionEnd(key, value)}
        onCompositionStart={() => controller.compositionStart()}
        onKeyDown={handleKeyDown}
        onText={handleText}
        placeholder={
          block.text === "" && block.kind === "paragraph"
            ? t("Type / for a block kind")
            : undefined
        }
        reset={row.reset}
        text={block.text}
      />
      {isMenuOpen ? (
        <SlashMenu
          choices={choices}
          onChoose={choose}
          selected={Math.min(menu.selected, choices.length - 1)}
        />
      ) : null}
    </div>
  );
}
