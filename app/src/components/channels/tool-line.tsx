import {
  IconBrowser,
  IconCircleDot,
  IconFileText,
  IconMessage,
  IconPlugConnected,
  IconSparkles,
  IconUser,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";

/**
 * What sort of thing a Bot did, which decides the icon.
 *
 * A KIND RATHER THAN AN ICON, so a caller names what happened and this file owns how it looks. The
 * alternative — every call site importing its own icon — is how a transcript ends up with four
 * different pictures for "read a page".
 */
export type ToolKind =
  | "browser"
  | "coworker"
  | "document"
  | "drawing"
  | "message"
  | "plugin"
  | "profile"
  | "unknown";

const ICONS: Record<ToolKind, typeof IconCircleDot> = {
  browser: IconBrowser,
  coworker: IconUser,
  document: IconFileText,
  drawing: IconSparkles,
  message: IconMessage,
  plugin: IconPlugConnected,
  profile: IconUser,
  // A tool this build has never heard of still happened, and still gets a mark on the line.
  unknown: IconCircleDot,
};

/**
 * One line for one thing a Bot did.
 *
 * Every tool call in the transcript draws through this, so a browser action, an MCP call and a
 * refusal read as the same kind of event. Detail stays behind a disclosure so the transcript keeps a
 * single-line action rhythm.
 *
 * While it is still running the text shimmers, which is the only signal that the Bot is working on
 * something with nothing to show yet.
 *
 * WHAT THESE LOOKED LIKE BEFORE, measured 2026-09-06: `파일 목록 조회  작업 공간에 항목 1개` —
 * two Korean phrases separated by a space and nothing else. No icon, no punctuation, no rule; the
 * verb and its result ran together into one string that reads as a sentence fragment somebody
 * forgot to finish. There is a mark at the start of the line now, and a `·` between what was done
 * and what came back, which is the smallest thing that makes two facts read as two facts.
 */
export function ToolLine({
  label,
  detail,
  kind = "unknown",
  running,
  refused,
  failed,
  children,
}: {
  /** What was done, in a couple of words: "Searched Slack", "Filled in", "Read the page". */
  label: string;
  /** What it was done to. Muted, and truncated rather than wrapped. */
  detail?: string;
  /** What sort of thing it was, for the icon. Defaults to a neutral mark. */
  kind?: ToolKind;
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
  const Icon = ICONS[kind];

  const text = (
    <span
      className={`inline-flex min-w-0 max-w-full items-center gap-1.5 text-sm ${tone} ${
        running ? "tool-line-running" : ""
      }`}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0 opacity-80" />
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
      {/*
       * The separator, and the reason there is one: the verb and its result used to be two Korean
       * phrases with a space between them, which reads as one unfinished sentence rather than as
       * "this was done, this came back". Rendered as its own element and hidden from a screen
       * reader, which gets the pause from the two spans regardless.
       */}
      {detail ? (
        <span aria-hidden="true" className="shrink-0 opacity-50">
          ·
        </span>
      ) : null}
      {/* No `opacity-70`: the object of the call measured 2.77:1 in light, and it is the payload. */}
      {detail ? <span className="truncate">{detail}</span> : null}
    </span>
  );

  // No margin: the transcript column is a `gap-6` flex, and a child's own margin adds to that gap.
  if (!children) return <div className="py-0.5">{text}</div>;

  return (
    <details className="tool-line min-w-0 py-0.5">
      {/*
       * Native <details> owns expansion because SDK tool renderers can be re-invoked independently
       * of this component's React state.
       */}
      <summary className="flex cursor-pointer list-none items-center gap-1.5">
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

/**
 * The kind a tool NAME belongs to, for the fallback line in the transcript.
 *
 * The rich renderers in `lib/copilot/*` know what they are and should say so directly; this is for
 * the path that has only a name — a tool with no registered renderer, which still happened and
 * still deserves a mark rather than a bare word.
 */
export function toolKindOf(name: string): ToolKind {
  const said = name.toLowerCase();
  if (said.startsWith("computer") || said.includes("browser")) return "browser";
  if (said.includes("ask_") || said.includes("coworker")) return "coworker";
  if (said.includes("component") || said.includes("draw")) return "drawing";
  if (said.includes("profile") || said.includes("remember")) return "profile";
  if (said.includes("message") || said.includes("send")) return "message";
  if (said.includes("doc") || said.includes("file")) return "document";
  if (said.includes("mcp") || said.includes("__")) return "plugin";
  return "unknown";
}
