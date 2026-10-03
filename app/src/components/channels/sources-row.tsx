import { IconExternalLink, IconWorld } from "@tabler/icons-react";
import { focusRing } from "@/components/ui/focus";
import { spokenText } from "@/lib/channels/spoken-text";
import { t } from "@/lib/i18n";
import { ko } from "@/lib/i18n-ko";
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

/**
 * Every way a provider's name is written, whatever language the screen is in: its key, which is
 * its English, and its Korean.
 *
 * The answer's language is the Bot's, not the screen's. Looked for only as the screen says it, an
 * English screen read "출처: 기상청" — what the model is told to write — as an answer with no
 * credit, and drew a second line in English under it; a Korean screen did the same to an answer
 * asked for in English (Codex on pull request 50).
 */
function writtenAs(name: string): string[] {
  return [...new Set([name, ko[name] ?? name])];
}

/**
 * The answer as the words a person reads, not as the markdown the Bot wrote.
 *
 * Looked for in what the Bot wrote, the line was found where nobody sees it — in a comment, in a
 * link's title — and the screen left its own out, and it was missed where everybody sees it:
 * `출처: **기상청**`, drawn bold, got a second line (Codex on pull request 50). The marks come off
 * the way they do for a screen reader (`spokenText`), and what HTML hides goes with its tags.
 * Not the drawn bubble itself: that is the renderer's, lazily, and this is decided as the row is.
 */
function wordsOf(text: string): string {
  return spokenText(
    text.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, ""),
  );
}

/** A source line the answer's own words already carry: "출처: 기상청", "자료 제공: 기상청". */
function alreadySays(text: string, name: string): boolean {
  const said = writtenAs(name)
    .map((written) => written.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(
    `(?:출처|자료(?:\\s*제공)?|source)\\s*[:：-]?\\s*(?:${said})`,
    "i",
  ).test(text);
}

/**
 * "출처: 기상청" under an answer said from data that must name its source (`creditsByAnswer`).
 *
 * NOT FOLDED, unlike the pages beside it: the rule is that the line is readable where the data is,
 * and a count to press is a link, not a line. Left out for a provider the answer's own words
 * already credit — the model is asked to write it — so the screen does not say it twice.
 */
export function CreditLine({
  names,
  text,
}: {
  names: readonly string[];
  text: string;
}) {
  const words = wordsOf(text);
  const owed = names
    .filter((name) => !alreadySays(words, name))
    .map((name) => t(name));
  if (owed.length === 0) return null;
  return (
    <p
      className="mt-1 text-muted-foreground text-xs"
      // What 복사 takes with the answer (`withSourceLine`): the line is a sibling of the bubble.
      data-slot="answer-credit"
      data-testid="answer-credit"
    >
      {t("Source: {names}", { names: owed.join(", ") })}
    </p>
  );
}
