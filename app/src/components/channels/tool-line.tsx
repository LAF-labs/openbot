import type { ReactNode } from "react";
import { t } from "@/lib/i18n";

/**
 * One line for one thing a Bot did.
 *
 * Every tool call in the transcript draws through this, so a browser action, an MCP call and a
 * refusal read as the same kind of event. Detail stays behind a disclosure so the transcript keeps a
 * single-line action rhythm.
 *
 * While it is still running the text shimmers, which is the only signal that the Bot is working on
 * something with nothing to show yet.
 */
export function ToolLine({
  label,
  detail,
  running,
  refused,
  failed,
  children,
}: {
  /** What was done, in a couple of words: "Searched Slack", "Filled in", "Read the page". */
  label: string;
  /** What it was done to. Muted, and truncated rather than wrapped. */
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
  /** Shown when the line is expanded. Without it the line is not expandable. */
  children?: ReactNode;
}) {
  const tone = refused
    ? "text-destructive"
    : failed
      ? "text-warning"
      : "text-muted-foreground";

  const text = (
    <span
      className={`inline-flex min-w-0 max-w-full items-baseline gap-1.5 text-sm ${tone} ${
        running ? "tool-line-running" : ""
      }`}
    >
      {/*
       * THE OUTCOME, IN THE READER'S LANGUAGE. "Blocked" and ", didn't work" were English literals
       * in the middle of an otherwise Korean transcript — and "Blocked" threw the label away, so a
       * refused line said only that something had been stopped, not what.
       *
       * Whole sentences as keys, because Korean does not append a clause to a noun the way English
       * does; the translator needs the shape of the finished line, not two halves to glue.
       */}
      <span className="shrink-0">
        {refused
          ? t("{action}, blocked", { action: label })
          : failed
            ? t("{action}, didn't work", { action: label })
            : label}
      </span>
      {/* No `opacity-70`: the object of the call measured 2.77:1 in light, and it is the payload. */}
      {detail ? <span className="truncate">{detail}</span> : null}
    </span>
  );

  // No margin: the transcript column is a `gap-6` flex, and a child's own margin adds to that gap.
  if (!children) return <div>{text}</div>;

  return (
    <details className="tool-line min-w-0">
      {/*
       * Native <details> owns expansion because SDK tool renderers can be re-invoked independently
       * of this component's React state.
       */}
      <summary className="flex cursor-pointer list-none items-baseline gap-1.5">
        <span
          aria-hidden
          className="tool-line-chevron shrink-0 text-xs text-muted-foreground transition-transform"
        >
          ▸
        </span>
        {text}
      </summary>
      {/*
       * Headings are cut down to the size of the surrounding text. A tool result is markdown a
       * server wrote for a model, so its `#` is a section marker rather than a page title.
       */}
      <div className="mt-2 max-h-80 overflow-auto border-l pl-3 text-xs [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium">
        {children}
      </div>
    </details>
  );
}
