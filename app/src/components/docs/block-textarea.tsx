import { type KeyboardEvent, useEffect, useRef } from "react";
import { focusRingBare } from "@/components/ui/focus";
import { cn } from "@/lib/utils";

/**
 * The box one block is written in: a plain `<textarea>`, as tall as its text.
 *
 * THE BOX OWNS ITS VALUE. It is uncontrolled — React gives it its text once, when it opens, and
 * never again on a render — because a Korean syllable is assembled inside the box by the input
 * method, and a value written back into a box mid-syllable breaks it into jamo (measured on the
 * composer, `composer-korean-ime.test.tsx`). What the person types goes out through `onText`; the
 * box is never told it.
 *
 * THE ONE TIME THE PAGE MUST CHANGE THE TEXT — a save refused because a colleague saved first,
 * reopened with theirs, or a `# ` that turned the block into a heading — arrives as a new `reset`
 * number with the text to show. During a composition it waits for `compositionend`, and is written
 * then; never under the person's hands. `app/tests/doc-block-ime.test.tsx` holds both.
 *
 * As tall as its text: `field-sizing: content` where the engine has it (Chrome), and the height
 * measured on each change where it does not (the Mac app's WebKit).
 */
export function BlockTextarea({
  ariaLabel,
  caret,
  className,
  onBlur,
  onCompositionEnd,
  onCompositionStart,
  onKeyDown,
  onText,
  placeholder,
  reset,
  text,
}: {
  ariaLabel: string;
  caret: number | "end";
  className?: string;
  onBlur: () => void;
  onCompositionEnd: (value: string) => void;
  onCompositionStart: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onText: (value: string, isComposing: boolean) => void;
  placeholder?: string;
  reset: number;
  text: string;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const isComposing = useRef(false);
  const shownReset = useRef(reset);
  /** A reset that arrived mid-syllable, written at `compositionend`. */
  const waiting = useRef<string | null>(null);

  // Opened: the caret where the editor asked (the end, the start of a new block, a join point).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the box opens.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    element.focus();
    const at = caret === "end" ? element.value.length : caret;
    element.setSelectionRange(at, at);
    fit(element);
  }, []);

  useEffect(() => {
    const element = box.current;
    if (!element || reset === shownReset.current) return;
    shownReset.current = reset;
    if (isComposing.current) {
      waiting.current = text;
      return;
    }
    write(element, text);
  }, [reset, text]);

  return (
    <textarea
      aria-label={ariaLabel}
      className={cn(
        "field-sizing-content block w-full resize-none overflow-hidden bg-transparent p-0 outline-none placeholder:text-muted-foreground/70",
        focusRingBare,
        className,
      )}
      data-doc-box
      defaultValue={text}
      onBlur={onBlur}
      onChange={(event) => {
        fit(event.currentTarget);
        onText(event.currentTarget.value, isComposing.current);
      }}
      onCompositionEnd={(event) => {
        isComposing.current = false;
        const element = event.currentTarget;
        if (waiting.current !== null) {
          write(element, waiting.current);
          waiting.current = null;
        }
        onCompositionEnd(element.value);
      }}
      onCompositionStart={() => {
        isComposing.current = true;
        onCompositionStart();
      }}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      ref={box}
      rows={1}
    />
  );
}

function write(element: HTMLTextAreaElement, value: string) {
  if (element.value === value) return;
  element.value = value;
  const end = value.length;
  element.setSelectionRange(end, end);
  fit(element);
}

const SIZES_ITSELF =
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("field-sizing", "content");

/** The height of the text, where the engine does not size a box to its content itself. */
function fit(element: HTMLTextAreaElement) {
  if (SIZES_ITSELF) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}
