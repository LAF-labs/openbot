import { useState } from "react";
import { Streamdown } from "streamdown";
import { FeedbackDialog } from "@/components/help/feedback-dialog";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { LegalLinks } from "@/components/legal/legal-links";
import { documentLinkComponents } from "@/components/legal/legal-page";
import { Button } from "@/components/ui/button";
import guide from "@/help/guide.md?raw";
import { t } from "@/lib/i18n";

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
 */
export function HelpPage() {
  const [asking, setAsking] = useState(false);

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
          components={documentLinkComponents}
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
      <footer className="mt-12">
        <LegalLinks className="text-muted-foreground text-xs" />
      </footer>
      <FeedbackDialog onOpenChange={setAsking} open={asking} />
    </PageShell>
  );
}
