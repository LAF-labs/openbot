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
import { ensure } from "@/lib/ensure";
import { activeLocale, t } from "@/lib/i18n";
import { computerResetRecheck } from "@/lib/rechecks";

type ComputerProfile = {
  botId: string;
  running: boolean;
  startedAt: string | null;
  egress: string | null;
  /**
   * Whether this viewer may act through the row's Bot, which is what stop and reset go through.
   * False for somebody else's Bot and for one deleted since (the computer keeps listing those).
   * Absent from a server that predates it, which is read as the old behaviour: both buttons.
   */
  mayDrive?: boolean;
};

export const Route = createFileRoute("/_authed/admin/computers")({
  component: ComputersPage,
});

/**
 * The list, read: the computers and how much they share, or the sentence for why not. Never throws.
 * Out here, like `pressComputer` below, because a component holding a `try` with a conditional in
 * it is left uncompiled — which this page was, behind its `finally`, until that went.
 */
async function readComputers(): Promise<
  | {
      computers: ComputerProfile[];
      isolation: "per-bot" | "shared" | null;
    }
  | { problem: string }
> {
  try {
    /*
     * AN ADDRESS THAT NAMES NO BOT. This asked `/api/computers/shared/computers`, filling the Bot id
     * with a word no Bot has; once the ownership guard stopped letting an administrator past on role
     * alone, that was a 404 for everybody, and this page drew a load error and no rows — so no Reset
     * button either (audit R3-04, R5-02, 2026-09-16). Stop and reset below still go through a row's
     * own Bot, which is a real one.
     */
    const response = await fetch("/api/computers", {
      credentials: "include",
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        code?: string;
      } | null;
      // The computer's facts are the pane's facts — unreachable, timed out — and have its words.
      return {
        problem: refusalText(
          SCREEN_PROBLEM_SAID,
          body?.code,
          t("The computers could not be listed."),
        ),
      };
    }
    const body = (await response.json()) as {
      computers: ComputerProfile[];
      isolation?: "per-bot" | "shared";
    };
    return { computers: body.computers, isolation: body.isolation ?? null };
  } catch {
    return { problem: t("The computers could not be reached.") };
  }
}

/**
 * One press of 탭 닫기 or 초기화 through a row's Bot: `null` when it worked, or the sentence for why
 * not. Out here because it holds the `try`, and a component that holds one is left uncompiled.
 */
async function pressComputer(
  botId: string,
  action: "stop" | "reset",
): Promise<string | null> {
  try {
    const response = await fetch(
      `/api/computers/${encodeURIComponent(botId)}/computers/${action}`,
      { method: "POST", credentials: "include" },
    );
    if (response.ok) return null;
    const body = (await response.json().catch(() => null)) as {
      code?: string;
    } | null;
    /*
     * Two sentences, not one template. `The computer could not be ${action}.` produced "The
     * computer could not be stop." — a string built by concatenating a verb into a sentence that
     * needed its past participle, and untranslatable either way.
     */
    return refusalText(
      SCREEN_PROBLEM_SAID,
      body?.code,
      action === "stop"
        ? t("The browser could not be stopped.")
        : t("The computer could not be reset."),
    );
  } catch {
    return t("The computer could not be reached.");
  }
}

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
  /** Bot id whose 탭 닫기 is in flight. A reset is the dialog's, and the dialog holds the page. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Reset deletes the one browser profile every Bot shares, so it requires confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const nameFor = useBotNames();

  const load = useCallback(async () => {
    const answer = await readComputers();
    if ("problem" in answer) {
      setProblem(answer.problem);
      return;
    }
    setComputers(answer.computers);
    setIsolation(answer.isolation);
    setProblem(null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 탭 닫기, on one row.
   *
   * WHAT THE PRESS CAME TO, KEPT PAST THE RELOAD BELOW. `load` clears the page's problem when the
   * list comes back — and it does come back — so a refused press set its sentence and lost it a
   * moment later. Measured 2026-09-16: Reset refused 404 closed its dialog and left the page as it
   * was, with nothing on it saying that nothing had happened.
   */
  const stop = useCallback(
    async (botId: string) => {
      setBusy(botId);
      // `try`…`finally`, the `finally` through `ensure`: the React Compiler cannot compile the
      // statement in a component. `pressComputer` catches everything, so what follows always runs.
      const refused = await ensure(
        () => pressComputer(botId, "stop"),
        () => setBusy(null),
      );
      await load();
      // A press that worked leaves whatever the reload said, its own failure to load included.
      if (refused) setProblem(refused);
    },
    [load],
  );

  /**
   * 초기화, for the dialog to await. A refusal is thrown and said inside the dialog, which stays
   * open until the reset has happened — it used to close on the press, and the refusal landed on
   * the page behind it.
   */
  const reset = async (botId: string) => {
    const refused = await pressComputer(botId, "reset");
    if (refused) throw new Error(refused);
    await load();
  };

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
                    {/*
                     * NO BUTTONS THAT COULD ONLY BE REFUSED. Both go through this row's Bot, and the
                     * server says whether this person may act through it. The row stays — the
                     * computer does hold it — and says why it has nothing to press.
                     */}
                    {computer.mayDrive === false ? (
                      <p className="text-muted-foreground text-xs">
                        {t(
                          "This is not one of your Bots, or it was deleted, so it cannot be stopped or reset from here.",
                        )}
                      </p>
                    ) : null}
                  </ItemContent>
                  {computer.mayDrive === false ? null : (
                    <ItemActions>
                      <Button
                        disabled={busy === computer.botId || !computer.running}
                        onClick={() => void stop(computer.botId)}
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
                  )}
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
        onConfirm={async () => {
          if (confirming) await reset(confirming);
        }}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        onStale={() => void load()}
        open={confirming !== null}
        pendingLabel={t("Resetting…")}
        recheck={async () =>
          confirming ? computerResetRecheck(confirming) : null
        }
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
