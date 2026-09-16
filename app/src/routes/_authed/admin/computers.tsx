import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { LoadFailed, RowsSkeleton } from "@/components/admin/admin-states";
import { ConfirmDialog } from "@/components/layout/confirm-dialog";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useBotNames } from "@/lib/agents/bot-names";
import { refusalText } from "@/lib/computer/refusals";
import { SCREEN_PROBLEM_SAID } from "@/lib/computer/screen-problems";
import { activeLocale, t } from "@/lib/i18n";

type ComputerProfile = {
  botId: string;
  running: boolean;
  startedAt: string | null;
  egress: string | null;
};

/** API placeholder id; the list endpoint returns all computers. */
const COMPUTER_ID = "shared";

export const Route = createFileRoute("/_authed/admin/computers")({
  component: ComputersPage,
});

function ComputersPage() {
  const [computers, setComputers] = useState<ComputerProfile[] | null>(null);
  /**
   * What the computer says about how much the Bots share.
   *
   * `"per-bot"` is still in the shape because it is in the wire's, and an older container is
   * allowed to say it; nothing draws it any more. See the banner below.
   */
  const [isolation, setIsolation] = useState<"per-bot" | "shared" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Bot id currently running a stop/reset request. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Reset deletes the one browser profile every Bot shares, so it requires confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const nameFor = useBotNames();

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/computers/${COMPUTER_ID}/computers`, {
        credentials: "include",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          code?: string;
        } | null;
        // The computer's facts are the pane's facts — unreachable, timed out — and have its words.
        setProblem(
          refusalText(
            SCREEN_PROBLEM_SAID,
            body?.code,
            t("The computers could not be listed."),
          ),
        );
        return;
      }
      const body = (await response.json()) as {
        computers: ComputerProfile[];
        isolation?: "per-bot" | "shared";
      };
      setComputers(body.computers);
      setIsolation(body.isolation ?? null);
      setProblem(null);
    } catch {
      setProblem(t("The computers could not be reached."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (botId: string, action: "stop" | "reset") => {
      setBusy(botId);
      setConfirming(null);
      try {
        const response = await fetch(
          `/api/computers/${encodeURIComponent(botId)}/computers/${action}`,
          { method: "POST", credentials: "include" },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            code?: string;
          } | null;
          /*
           * Two sentences, not one template. `The computer could not be ${action}.` produced "The
           * computer could not be stop." — a string built by concatenating a verb into a sentence
           * that needed its past participle, and untranslatable either way.
           */
          setProblem(
            refusalText(
              SCREEN_PROBLEM_SAID,
              body?.code,
              action === "stop"
                ? t("The browser could not be stopped.")
                : t("The computer could not be reset."),
            ),
          );
        } else {
          setProblem(null);
        }
      } catch {
        setProblem(t("The computer could not be reached."));
      } finally {
        setBusy(null);
        await load();
      }
    },
    [load],
  );

  return (
    <PageShell
      description={t(
        "The one browser your Bots share, and the profile it keeps. That profile is what makes them still signed in tomorrow, and resetting it signs every one of them out.",
      )}
      title={t("Computers")}
    >
      {problem ? (
        <p
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {problem}
        </p>
      ) : null}

      {/*
       * ONE BANNER, BECAUSE THERE IS ONE ANSWER. The other branch drew "Each Bot has a computer of
       * its own: its own container, its own files and its own browser profile." — which this
       * deployment could never say, and, from 2026-09-16, no deployment this repository can produce
       * can say either. A screen that can draw a claim the product cannot back is a control that
       * saves and does nothing, one paragraph further on.
       */}
      {isolation === "shared" ? (
        <p className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <span className="font-medium">
            {t("Every Bot is sharing one computer.")}
          </span>{" "}
          {t(
            "They share its logins, its files and its session, so a Bot can reach what another signed into. That is the design — one computer per account — and what keeps a Bot in bounds is the boundary in front of it, not a separate computer.",
          )}
        </p>
      ) : null}

      <PageSection title={t("Computers in this deployment")}>
        {computers === null && problem ? (
          <LoadFailed
            message={t("The list could not be loaded.")}
            onRetry={() => void load()}
          />
        ) : computers === null ? (
          // Two rows, not ten: this deployment has one computer, and a longer placeholder would be
          // a claim about how much is coming.
          <RowsSkeleton rows={2} />
        ) : computers.length === 0 ? (
          <PageEmpty>
            {t(
              "No computers yet. One appears the first time a Bot opens a page.",
            )}
          </PageEmpty>
        ) : (
          <PageRows>
            {computers.map((computer, index) => (
              <StaggerItem index={index} key={computer.botId}>
                <Item size="sm">
                  <ItemContent>
                    {/*
                     * The Bot's name in the tooltip too. It carried the raw `botId` — a uuid — so
                     * hovering a name to find out more was answered with less.
                     */}
                    <ItemTitle title={nameFor(computer.botId)}>
                      {nameFor(computer.botId)}
                    </ItemTitle>
                    <ItemDescription>
                      {/*
                       * `toLocaleTimeString()` with no locale follows the machine rather than the
                       * person, so a Korean screen showed an English clock. The three sentences
                       * around it had no `t()` at all — a template literal is invisible to the
                       * coverage walk, which is exactly how they survived.
                       */}
                      {/*
                       * "running" is this Bot having a tab open, not a browser of its own: there is
                       * one browser and it closes once the last Bot's tabs do.
                       */}
                      {computer.running
                        ? t("A tab open since {time}", {
                            time: new Date(
                              computer.startedAt ?? "",
                            ).toLocaleTimeString(activeLocale),
                          })
                        : t(
                            "No tab open. One opens when this Bot next needs it.",
                          )}
                      {" · "}
                      {computer.egress
                        ? t("Leaves through {egress}", {
                            egress: computer.egress,
                          })
                        : t("Leaves directly")}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      disabled={busy === computer.botId || !computer.running}
                      onClick={() => void run(computer.botId, "stop")}
                      size="sm"
                      variant="outline"
                    >
                      {busy === computer.botId
                        ? t("Working…")
                        : t("Close its tabs")}
                    </Button>
                    <Button
                      disabled={busy === computer.botId}
                      onClick={() => setConfirming(computer.botId)}
                      size="sm"
                      variant="outline"
                    >
                      {t("Reset")}
                    </Button>
                  </ItemActions>
                </Item>
                {index !== computers.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>

      {/*
       * A DIALOG RATHER THAN AN INLINE CONFIRM. Resetting signs a Bot out of everything it has ever
       * logged into and cannot be undone, and the row it was confirmed on was one of several
       * identical-looking rows. The dialog names the Bot, so the sentence somebody agrees to says
       * which computer it destroys.
       *
       * THE SHARED ONE, and it is not a tidy-up: this dialog had its own copy of the two things
       * `ConfirmDialog` was written after finding broken in all three of its siblings — focus that
       * never entered the popup, so a keyboard could not reach either answer on the one control here
       * that destroys something, and a destructive button drawn in a wash so pale it reads as
       * disabled.
       */}
      {/*
       * THE DIALOG NAMES WHAT GOES, WHICH IS NOT THE BOT ON THE ROW. It used to say "Reset
       * {name}'s computer?" and describe one Bot being signed out, from a row among several
       * identical-looking ones — and since 2026-09-16 there is one profile and pressing it signs
       * every Bot out of everything. The row somebody pressed it from decides who is recorded as
       * asking; it does not decide whose logins go, and a dialog that implied otherwise would be the
       * screen lying about the most destructive button on it.
       */}
      <ConfirmDialog
        confirmLabel={t("Reset it")}
        description={t(
          "Your Bots share one browser, so this signs all of them out of every service they had logged into and starts clean. This cannot be undone.",
        )}
        onConfirm={() => {
          if (confirming) void run(confirming, "reset");
        }}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        open={confirming !== null}
        pending={busy === confirming}
        pendingLabel={t("Resetting…")}
        title={t("Reset the computer every Bot shares?")}
      />

      {/*
       * Whole sentences, not a sentence with a <strong> sewn into the middle of it. The English was
       * written as five JSX fragments around two bold words and a link, so `t()` could not reach
       * any of it — the paragraph was English on every Korean screen — and no translator could have
       * moved the clauses anyway, which Korean needs to.
       */}
      <p className="mt-4 text-muted-foreground text-sm">
        {t(
          "Stop closes that Bot's tabs and keeps the logins: the next thing it does opens a page again where it left off.",
        )}{" "}
        {t(
          "Reset deletes the one profile they all share, so every Bot is signed out of everything and starts clean.",
        )}{" "}
        {t("Both are recorded in Audit.")}{" "}
        <Link className="underline" to="/admin/audit">
          {t("Open the audit trail")}
        </Link>
      </p>
    </PageShell>
  );
}
