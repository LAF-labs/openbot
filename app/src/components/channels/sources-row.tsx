import { IconExternalLink, IconWorld } from "@tabler/icons-react";
import { focusRing } from "@/components/ui/focus";
import { t } from "@/lib/i18n";
import type { Source } from "./sources";

/**
 * "출처 N개" under an answer, folding open to the pages it came from (Muse's pattern).
 *
 * Folded, because the answer is what a person reads and the pages are what they check; a list of
 * eight links under every price answer would bury the next message. A native `<details>`, so it
 * opens from the keyboard and a screen reader says whether it is open without anything written here.
 *
 * The links leave the app in a new window: the conversation is where the owner is working, and the
 * installed app has no Back to come home by.
 */
export function SourcesRow({ sources }: { sources: readonly Source[] }) {
  return (
    <details
      className="group mt-1 max-w-[min(100%,36rem)] text-muted-foreground text-xs"
      data-testid="answer-sources"
    >
      <summary
        className={`inline-flex w-fit cursor-pointer select-none items-center gap-1 rounded-full border border-border px-2 py-0.5 hover:text-foreground ${focusRing}`}
      >
        <IconWorld aria-hidden="true" className="size-3.5" />
        {t("{count} sources", { count: sources.length })}
      </summary>
      <ol className="mt-1.5 flex flex-col gap-1">
        {sources.map((source) => (
          <li className="min-w-0" key={source.url}>
            <a
              className={`inline-flex max-w-full items-center gap-1 underline-offset-2 hover:text-foreground hover:underline ${focusRing}`}
              href={source.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              {/*
               * The site first, because it is what a person trusts or does not; the page's title
               * after it where the browser reported one. It often does not — measured, a
               * navigation hands back an empty title — and the host twice read as a stutter.
               */}
              <span className="shrink-0 text-foreground/80">{source.host}</span>
              {source.title ? (
                <span className="truncate opacity-80">· {source.title}</span>
              ) : null}
              <IconExternalLink
                aria-hidden="true"
                className="size-3 shrink-0"
              />
            </a>
          </li>
        ))}
      </ol>
    </details>
  );
}
