import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { ConnectionRow } from "@/components/connections/connection-row";
import {
  connectionFailureText,
  openConsent,
  refusalText,
} from "@/components/plugins/connections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OauthAccount } from "@/lib/connections/queries";
import { connectionKeys, PENDING_WINDOW_MS } from "@/lib/connections/queries";
import { activeLocale, t } from "@/lib/i18n";
import { catalogueCanKey, catalogueMark } from "@/lib/plugins/catalogue-copy";
import { beginConnect, disconnectServer } from "@/lib/plugins/queries";

/**
 * A row whose switch opens somebody else's consent screen.
 *
 * THE PRESS LEAVES THIS WINDOW, AND IN THE INSTALLED APP IT LEAVES THE APP. Google refuses embedded
 * user agents outright, so the shell hands the consent URL to the person's own browser and this
 * window stays where it is — with nothing to report until they come back, which is the whole reason
 * this row has a state between "off" and "on" at all. `openConsent` decides which of the two
 * happened and the row says the true one.
 *
 * WHAT THE PARENT OWNS. Whether the screen is polling. A row that started its own interval would be
 * seven intervals on a screen with seven vendors on it, all asking the same endpoint the same
 * question — the mistake `control-poll.ts` was written to undo. So the row reports that it is
 * waiting and the screen decides what to do about it.
 */
const asDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(activeLocale) : "";

/** Where the row is between the person's press and the vendor's answer. */
type Phase = "settled" | "naming" | "connecting" | "waiting";

export const OauthRow = ({
  account,
  onWaiting,
}: {
  account: OauthAccount;
  /**
   * Told whenever this row starts or stops waiting on another window, so the screen can re-ask.
   *
   * BOTH DIRECTIONS, which is the half that was missing and was measured: reporting only the start
   * left the screen polling every three seconds for the full five minutes after somebody pressed
   * 취소 — a row that had stopped waiting, and an endpoint that had nothing new to say, forty times
   * over.
   */
  onWaiting: (accountId: string, until: number | null) => void;
}) => {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>("settled");
  const [shopId, setShopId] = useState(account.account ?? "");
  const [note, setNote] = useState<string | null>(null);

  /*
   * The answer arriving is what ends the wait, and nothing else was ending it. A consent finished in
   * the other window comes back as a poll saying `connected`, and without this the row went on
   * saying "브라우저에서 동의를 마치는 중…" over an account that was already connected.
   */
  useEffect(() => {
    if (account.status === "not_connected") return;
    setPhase("settled");
  }, [account.status]);

  useEffect(() => {
    onWaiting(
      account.id,
      phase === "waiting" ? Date.now() + PENDING_WINDOW_MS : null,
    );
  }, [account.id, onWaiting, phase]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: connectionKeys.all });
  }, [queryClient]);

  const connect = useMutation({
    mutationFn: () =>
      beginConnect(
        account.id,
        "settings",
        account.needsInstanceName ? shopId.trim() : undefined,
      ),
    onMutate: () => {
      setNote(null);
      setPhase("connecting");
    },
    onSuccess: async (authorizationUrl) => {
      // A whole-page navigation, not a router one: the next screen belongs to the vendor — unless
      // the shell handed it to the person's own browser, which is what `openConsent` decides.
      const where = await openConsent(authorizationUrl, (url) =>
        window.location.assign(url),
      );
      if (where === "browser") setPhase("waiting");
    },
    onError: (thrown: Error) => {
      setPhase(account.needsInstanceName ? "naming" : "settled");
      setNote(refusalText(thrown));
    },
  });

  const disconnect = useMutation({
    mutationFn: () => disconnectServer(account.id),
    onSuccess: () => {
      setNote(null);
      setPhase("settled");
      refresh();
    },
    onError: () =>
      setNote(t("The connection could not be removed. Please try again.")),
  });

  const isConnected = account.status !== "not_connected";
  const isBusy = connect.isPending || disconnect.isPending;

  const handleToggle = useCallback(
    (next: boolean) => {
      if (!next) {
        // A press half-way through a consent is somebody changing their mind, not a disconnect.
        if (phase !== "settled") {
          setPhase("settled");
          setNote(null);
          return;
        }
        disconnect.mutate();
        return;
      }
      if (account.needsInstanceName && !account.account) {
        // The name BEFORE the press, because the press cannot work without it. Asking afterwards
        // would be a refusal in front of somebody who did nothing wrong.
        setNote(null);
        setPhase("naming");
        return;
      }
      connect.mutate();
    },
    [account.account, account.needsInstanceName, connect, disconnect, phase],
  );

  const status = (): { text: string; tone: "muted" | "good" | "warn" } => {
    if (phase === "connecting")
      return { text: t("Connecting…"), tone: "muted" };
    if (phase === "waiting") {
      return {
        text: t("Finish giving permission in the browser that opened."),
        tone: "muted",
      };
    }
    if (phase === "naming") {
      return {
        text: t("Type your shop's name, then press Connect."),
        tone: "muted",
      };
    }
    if (account.status === "needs_reconnect") {
      return {
        text: connectionFailureText(account.health.failureCode),
        tone: "warn",
      };
    }
    if (account.status === "connected") {
      const since = asDate(account.health.lastOkAt ?? account.connectedAt);
      const who = account.account;
      return {
        text: who
          ? t("Connected · {name} · last used {date}", {
              name: who,
              date: since,
            })
          : t("Connected · last used {date}", { date: since }),
        tone: "good",
      };
    }
    // Nothing, not 연결 안 됨. The switch beside it is off, and saying so twice buried the rows
    // that had something to report.
    return { text: "", tone: "muted" };
  };

  const said = status();

  return (
    <ConnectionRow
      can={t(catalogueCanKey(account.id, account.title))}
      isBusy={isBusy}
      isOn={isConnected || phase !== "settled"}
      mark={catalogueMark(account.id)}
      name={t(account.title)}
      note={note}
      onToggle={handleToggle}
      status={said.text}
      tone={said.tone}
      {...(isConnected && phase === "settled"
        ? {
            confirmText: t(
              "Disconnect this? The Bot will not be able to use this account any more.",
            ),
          }
        : {})}
    >
      {phase === "naming" ? (
        <div className="mt-2 space-y-2">
          <Input
            aria-label={t("Shop ID")}
            className="h-8 w-48 text-xs"
            onChange={(event) => setShopId(event.target.value)}
            placeholder={t("Shop ID")}
            value={shopId}
          />
          {/* Where to look for it, said once and only where it is asked for. Nobody knows their
              mall id by heart, and everybody has it open in another tab. */}
          <p className="text-muted-foreground text-xs">
            {t("The name in front of .cafe24.com in your shop's address.")}
          </p>
          <Button
            disabled={!shopId.trim() || connect.isPending}
            onClick={() => connect.mutate()}
            size="sm"
            type="button"
          >
            {t("Connect")}
          </Button>
        </div>
      ) : null}

      {phase === "waiting" ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            onClick={() => {
              setPhase("settled");
              refresh();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("Check again")}
          </Button>
          <Button
            onClick={() => setPhase("settled")}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("Cancel")}
          </Button>
        </div>
      ) : null}
    </ConnectionRow>
  );
};
