import { useLocation } from "@tanstack/react-router";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { FeedbackDialog } from "@/components/help/feedback-dialog";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { LegalLinks } from "@/components/legal/legal-links";
import { documentLinkComponents } from "@/components/legal/legal-page";
import { VersionLine } from "@/components/settings/version-line";
import { Button } from "@/components/ui/button";
import guide from "@/help/guide.md?raw";
import { t } from "@/lib/i18n";
import {
  helpSectionFrom,
  helpSectionOfHeading,
  reportHelpOpened,
} from "@/lib/support/help-opened";

/** The words of a heading as Streamdown hands them over: a string, or strings in an array. */
const textOf = (children: ReactNode): string =>
  typeof children === "string"
    ? children
    : Array.isArray(children)
      ? children.map(textOf).join("")
      : "";

/**
 * A section heading of the guide, anchored at its key so `/help#routines` lands on 루틴.
 *
 * Streamdown's own `h2` with an `id` added, and its classes repeated rather than lost: replacing a
 * component replaces all of it, and a heading that silently dropped its size would be the guide
 * looking broken for the sake of an anchor. `scroll-mt-4` so the heading is not flush with the
 * top edge when it is scrolled to.
 */
const HelpHeading = ({
  children,
  node: _node,
  ...rest
}: ComponentProps<"h2"> & { node?: unknown }) => {
  const section = helpSectionOfHeading(textOf(children));
  return (
    <h2
      {...rest}
      className="mt-6 mb-2 scroll-mt-4 font-semibold text-2xl"
      data-streamdown="heading-2"
      id={section ?? undefined}
    >
      {children}
    </h2>
  );
};

const guideComponents = { ...documentLinkComponents, h2: HelpHeading };

/**
 * The help page: five short sections and a way to say something back.
 *
 * THE TEXT IS CONTENT, NOT COPY, the same arrangement as the two legal documents: Korean markdown
 * in `app/src/help/guide.md`, imported `?raw` and drawn with the same renderer a Bot's prose gets.
 * Every button name in it is bold, and `help-page.test.ts` checks each one against the Korean
 * dictionary — so the guide cannot name a button the app does not draw, which is the way a help
 * page goes quietly wrong.
 *
 * Inside the app shell rather than beside it, because the person reading it is signed in and
 * stuck, and the roster staying on the left is what lets them go back to the Bot they were stuck on.
 *
 * OPENING IT IS COUNTED, ONCE PER VISIT (`lib/support/help-opened.ts`): the launch plan asks whether
 * anybody reads the help, and nothing else could say. Once per mount, held by a ref — a re-render,
 * React's development double-run of effects, or a fragment changing under an open page is the same
 * visit, and leaving and coming back is a new one.
 */
export function HelpPage() {
  const [asking, setAsking] = useState(false);
  const hash = useLocation({ select: (location) => location.hash });
  const section = helpSectionFrom(hash);
  const counted = useRef(false);

  useEffect(() => {
    if (counted.current) return;
    counted.current = true;
    reportHelpOpened(section);
  }, [section]);

  useEffect(() => {
    if (section) document.getElementById(section)?.scrollIntoView();
  }, [section]);

  return (
    <PageShell
      action={
        <Button onClick={() => setAsking(true)} variant="outline">
          {t("Questions and feedback")}
        </Button>
      }
      description={t(
        "Making a Bot, connecting a site, answering it, setting a routine — and what to do when something goes wrong.",
      )}
      title={t("Help")}
    >
      <article className="text-base leading-7">
        <Streamdown
          components={guideComponents}
          controls={false}
          linkSafety={{ enabled: false }}
          mode="static"
          parseIncompleteMarkdown={false}
        >
          {guide}
        </Streamdown>
      </article>
      <PageSection title={t("Still stuck?")}>
        <Button onClick={() => setAsking(true)} variant="outline">
          {t("Questions and feedback")}
        </Button>
      </PageSection>
      <footer className="mt-12 space-y-2">
        <LegalLinks className="text-muted-foreground text-xs" />
        <VersionLine />
      </footer>
      <FeedbackDialog onOpenChange={setAsking} open={asking} />
    </PageShell>
  );
}
