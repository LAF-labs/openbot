import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { t } from "@/lib/i18n";

/**
 * One of the two legal documents, drawn from its markdown file.
 *
 * THE TEXT IS CONTENT, NOT COPY. It lives in `app/src/legal/*.md`, in Korean, with the draft banner
 * at its head, and is imported `?raw` — so replacing the draft after counsel is replacing one file,
 * and the i18n walk (which reads literal `t()` calls out of `.tsx`) never sees a legal sentence it
 * would want a dictionary entry for. This component owns only the words around the document.
 *
 * The same renderer as a Bot's prose, in static mode: the chat already renders markdown in both
 * themes through it, and a second markdown pipeline for two pages would be a second set of heading
 * sizes to keep in step.
 */

type LegalDocument = "terms" | "privacy";

const TITLES: Record<LegalDocument, () => string> = {
  terms: () => t("Terms of Service"),
  privacy: () => t("Privacy Policy"),
};

const NAV_LINK_CLASS = "hover:text-foreground";

/**
 * Links inside the documents. The two point at each other by path, and those stay inside the app;
 * anything else is somebody else's site and opens in a new tab, as a Bot's links do.
 */
const components = {
  a: ({ href, children, ...rest }: ComponentProps<"a">) => {
    const className = "underline underline-offset-2 hover:no-underline";
    if (href === "/legal/terms" || href === "/legal/privacy") {
      return (
        <Link className={className} to={href}>
          {children}
        </Link>
      );
    }
    return (
      <a
        {...rest}
        className={className}
        href={href}
        rel="noreferrer noopener"
        target="_blank"
      >
        {children}
      </a>
    );
  },
};

export function LegalPage({
  document,
  markdown,
}: {
  document: LegalDocument;
  markdown: string;
}) {
  const other: LegalDocument = document === "terms" ? "privacy" : "terms";
  return (
    /*
     * Its own scroller and its own measure, because this page has no app shell around it: it is
     * reachable before sign-in and after leaving. 65ch is the prose column every configuration
     * screen already uses (`page-shell.tsx`), and a legal text is the one thing on this product
     * somebody may actually read top to bottom.
     */
    <div className="min-h-dvh w-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[65ch] flex-col gap-8 px-4 py-12">
        <nav
          aria-label={t("Legal")}
          className="flex flex-wrap items-center gap-3 text-muted-foreground text-sm"
        >
          <Link className={NAV_LINK_CLASS} to="/">
            {t("Back to app")}
          </Link>
          <span aria-hidden="true">·</span>
          <span aria-current="page" className="font-medium text-foreground">
            {TITLES[document]()}
          </span>
          <span aria-hidden="true">·</span>
          <Link className={NAV_LINK_CLASS} to={`/legal/${other}`}>
            {TITLES[other]()}
          </Link>
        </nav>
        <article className="text-base leading-7">
          <Streamdown
            components={components}
            controls={false}
            linkSafety={{ enabled: false }}
            mode="static"
            parseIncompleteMarkdown={false}
          >
            {markdown}
          </Streamdown>
        </article>
      </div>
    </div>
  );
}
