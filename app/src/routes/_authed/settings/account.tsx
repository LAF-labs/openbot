import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { t } from "@/lib/i18n";

/**
 * Taking your data with you, and leaving.
 *
 * TWO ACTS ON ONE PAGE, and they belong together: the reason to put a download next to a deletion
 * is that somebody about to press the second one should have already seen the first. Splitting them
 * would make the export something you find afterwards, which is exactly too late.
 *
 * THE PAGE STAYS UP AFTER THE ACCOUNT IS GONE. Deleting removes the person's sessions, so the very
 * next request this browser makes answers 401 and every route bounces to sign-in. Navigating
 * anywhere on success would therefore land on a login screen with no explanation of what just
 * happened, which reads exactly like being logged out by a bug. So the final state is rendered
 * here, in place, by a component that needs no further request.
 */

/**
 * The refusals this API names, translated here because the code is a fact and this surface owns the
 * words — the same arrangement `ROUTINE_REFUSALS` uses.
 *
 * Walked by `app/tests/account-copy.test.ts`, because `t()` called on a variable is invisible to the
 * i18n coverage test.
 */
export const ACCOUNT_REFUSALS: Record<string, string> = {
  "laf:account_confirmation_required": "Type your email address to confirm.",
  "laf:account_confirmation_mismatch":
    "That is not the email address on this account.",
  "laf:account_not_found": "This account is already gone.",
  "laf:account_self_via_admin": "Leave from your own account page instead.",
};

const AccountPage = () => {
  const [typed, setTyped] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isGone, setIsGone] = useState(false);

  /*
   * The address is read back from the refusal rather than from the session query.
   *
   * The server already knows what it will accept and says so in `expects`; asking the browser to
   * compare against its own copy would mean two places deciding whether a confirmation matched, and
   * the one that matters is the server's. So the button is always live and the FIRST press is what
   * tells the person what to type — the same shape a wrong password takes.
   */
  const [expects, setExpects] = useState<string | null>(null);

  const handleDelete = async () => {
    setError(null);
    setIsDeleting(true);
    try {
      const response = await fetch("/api/me/delete", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: typed }),
      });
      const body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!response.ok) {
        if (typeof body?.expects === "string") setExpects(body.expects);
        const known =
          typeof body?.code === "string"
            ? ACCOUNT_REFUSALS[body.code]
            : undefined;
        setError(known ? t(known) : t("That did not go through. Try again."));
        return;
      }
      setIsGone(true);
    } catch {
      setError(t("That did not go through. Try again."));
    } finally {
      setIsDeleting(false);
    }
  };

  if (isGone) {
    return (
      <PageShell
        description={t(
          "Nothing of yours is left here. The record of what was done keeps a code instead of your name, and it is kept for a year.",
        )}
        title={t("Your account is gone")}
      >
        <PageSection>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t(
              "Backups taken in the last 30 days still hold a copy until they age out. Nothing new is written to them.",
            )}
          </p>
          <div className="mt-6">
            {/* A plain reload rather than a router navigation: every route here needs a session,
                and this browser no longer has one. */}
            <Button onClick={() => window.location.assign("/sign")}>
              {t("Back to the sign-in page")}
            </Button>
          </div>
        </PageSection>
      </PageShell>
    );
  }

  return (
    <PageShell
      description={t(
        "What this deployment holds about you, how to take a copy of it, and how to end it.",
      )}
      title={t("Your data")}
    >
      <PageSection title={t("Take a copy")}>
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>{t("Download everything")}</ItemTitle>
              {/*
               * `line-clamp-none`, and it is not decoration. `ItemDescription` clamps at two lines,
               * which is right for a roster row and wrong here: measured on the Korean page, the
               * sentence listing what is in the file ended in an ellipsis, so the one paragraph
               * telling somebody what they are about to download was the one they could not read.
               */}
              <ItemDescription className="line-clamp-none">
                {t(
                  "One file: your profile, your Bots and what they remember, every conversation, your routines and skills, and the record of what you did. No passwords, no connected-service keys, nobody else's data.",
                )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {/*
               * An anchor, not a fetch. The response is an attachment the browser streams straight
               * to disk; pulling a whole account through JavaScript first would hold it in memory
               * for no reason and lose the progress the browser shows for free.
               */}
              <Button
                render={(props) => <a href="/api/me/export" {...props} />}
                variant="outline"
              >
                {t("Download")}
              </Button>
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      {/*
       * NOT A ROW. Everything else on this screen is `Item` — a label on the left and a control on
       * the right — and that shape is wrong for this: it puts the most consequential button on the
       * page level with the middle of a paragraph nobody has finished reading, and it clipped both
       * paragraphs to two lines when drawn that way. A deletion is a short flow, so it is drawn as
       * one: what goes, what stays, the thing to type, and only then the button.
       */}
      <PageSection title={t("Leave")}>
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-destructive/25 p-4">
          <h3 className="font-medium text-sm">{t("Delete this account")}</h3>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t(
              "Your Bots and everything they learned, every conversation, your routines, your skills and the allowances you gave all go. Your Bots' browsers are wiped, so every site they were signed in to is signed out.",
            )}
          </p>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t(
              "What stays is the record of what was done, kept for a year under a code instead of your name — and backups taken in the last 30 days, until they age out.",
            )}
          </p>
          <p className="text-destructive text-sm leading-relaxed">
            {t("This cannot be undone. Take a copy first.")}
          </p>

          <label
            className="mt-2 text-muted-foreground text-sm"
            htmlFor="account-delete-confirm"
          >
            {expects
              ? t("Type {email} to confirm.", { email: expects })
              : t("Type your email address to confirm.")}
          </label>
          <Input
            autoComplete="off"
            id="account-delete-confirm"
            onChange={(event) => setTyped(event.target.value)}
            spellCheck={false}
            value={typed}
          />
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
          <div>
            <Button
              disabled={isDeleting || typed.trim().length === 0}
              onClick={handleDelete}
              variant="destructive"
            >
              {isDeleting ? t("Deleting…") : t("Delete everything")}
            </Button>
          </div>
        </div>
      </PageSection>
    </PageShell>
  );
};

// Below the component it names: a `const` arrow is not hoisted, and naming it above is a TDZ error.
export const Route = createFileRoute("/_authed/settings/account")({
  component: AccountPage,
});
