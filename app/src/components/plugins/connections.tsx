import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { activeLocale, t } from "@/lib/i18n";
import { openExternal } from "@/lib/notifications/shell";
import {
  beginConnect,
  ConnectRefusedError,
  connectionsQueryOptions,
  disconnectServer,
  pluginKeys,
  saveOauthClient,
} from "@/lib/plugins/queries";

/**
 * What a refused connect means, in this deployment's own words.
 *
 * The server's sentence is English prose aimed at whoever reads a log; this screen is Korean-first
 * for people who do not write software. So the status is the fact taken from the server and the
 * words are ours — and the three statuses are three genuinely different situations. Saying "try
 * again" in front of a deployment that has no public address at all is how a connector that nobody
 * can ever complete looks like a flaky button.
 */
export const refusalText = (thrown: Error): string => {
  const refused = thrown instanceof ConnectRefusedError ? thrown : null;
  const status = refused?.status ?? 0;

  /*
   * The code first, where the server sent one. The status alone puts two different mistakes of the
   * person's own behind one 400 — a mall id left blank and a mall id that is not one — and reading
   * only the status is how "가게 주소를 확인해 주세요" appeared in front of somebody who had
   * typed nothing at all.
   */
  const byCode: Record<string, string> = {
    "laf:instance_name_required": t("Type your shop's name first."),
    "laf:instance_name_refused": t("Check the shop ID and try again."),
    /*
     * NOT "an administrator has to set it up". On a one-person deployment the reader IS that
     * person, and there is no screen they could go to: which services this machine can offer is
     * decided by the fleet before they ever see it. Said as a fact, with what actually happens
     * next, rather than as a job somebody is waiting on.
     */
    "laf:connector_not_configured": t(
      "This service is not available on this machine yet. Nothing here needs fixing — get in touch and we will turn it on.",
    ),
    "laf:no_oauth_client": t(
      "This service is not available on this machine yet. Nothing here needs fixing — get in touch and we will turn it on.",
    ),
    "laf:no_public_url": t(
      "This deployment has no public address, so a connection cannot be finished here.",
    ),
    "laf:registration_refused": t(
      "The service refused this deployment's registration. Please try again in a moment.",
    ),
    "laf:server_not_added": t(
      "The connection could not be started. Please try again.",
    ),
  };
  const said = refused?.code ? byCode[refused.code] : undefined;
  if (said) return said;

  if (status === 503) {
    return t(
      "This deployment has no public address, so a connection cannot be finished here.",
    );
  }
  if (status === 409) {
    return t(
      "This service is not available on this machine yet. Nothing here needs fixing — get in touch and we will turn it on.",
    );
  }
  if (status === 502) {
    return t(
      "The service refused this deployment's registration. Please try again in a moment.",
    );
  }
  /*
   * The one refusal the PERSON can act on, which is why it is a sentence about their shop and not
   * about the deployment. A mall id is on the address bar of the shop itself, so the fix is to look
   * and type it again rather than to ask anybody.
   */
  if (status === 400) {
    return t("Check the shop ID and try again.");
  }
  return t("The connection could not be started. Please try again.");
};

/**
 * Why a connection this deployment holds has stopped working, in the person's own terms.
 *
 * A `needs_reconnect` row is the one place on this screen where nothing the person did is at fault
 * and something of theirs has nevertheless stopped: a grant withdrawn at the vendor, a password
 * changed, a refresh refused. The sentence has to end in the thing to do, because the switch is
 * already sitting on and "다시 연결 필요" alone reads as a fault report rather than an instruction.
 */
export const connectionFailureText = (code: string | null): string => {
  const said: Record<string, string> = {
    "laf:refresh_refused": t(
      "Your account signed this out. Turn it off and on again to reconnect.",
    ),
    "laf:credential_missing": t(
      "The connection is gone from this machine. Turn it off and on again to reconnect.",
    ),
    "laf:scope_missing": t(
      "This connection is missing something it needs. Turn it off and on again, and say yes to everything the service asks.",
    ),
  };
  return (
    (code ? said[code] : undefined) ??
    t("This connection has stopped working. Turn it off and on again.")
  );
};

/**
 * Where a vendor's consent screen is opened, and what that leaves this window doing.
 *
 * IN THE DESKTOP SHELL IT GOES TO THE REAL BROWSER. The installed app is the product here, and a
 * webview is the one place an OAuth consent cannot be relied on to work: Google refuses embedded
 * user agents outright (`disallowed_useragent`), and a vendor that does allow one leaves the person
 * in a window with no address bar, no password manager and no session they are already signed into.
 *
 * Safe precisely because of how the callback is built: identity comes from the SEALED STATE and
 * never from the session on the request, so finishing in a different browser still attaches the
 * grant to the person who started it — the state is the only thing that could say who that is.
 *
 * A pure decision with the navigation injected, because the property worth pinning is which of the
 * two happened: in the shell this window must NOT navigate, or the person loses the app behind a
 * consent screen that was handed to their browser anyway.
 */
export async function openConsent(
  authorizationUrl: string,
  navigate: (url: string) => void,
): Promise<"browser" | "here"> {
  if (await openExternal(authorizationUrl)) return "browser";
  navigate(authorizationUrl);
  return "here";
}

/**
 * The OAuth client an administrator registered at the vendor by hand.
 *
 * Only for a vendor that will not register one itself. The redirect address is shown rather than
 * described because it has to be registered character for character — a vendor compares the string
 * it was given against the one this deployment sends, and a trailing slash is a different address.
 */
const OAuthClientForm = ({
  serverId,
  redirectUri,
  onSaved,
}: {
  serverId: string;
  redirectUri: string | null;
  onSaved: () => void;
}) => {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({ clientId: "", clientSecret: "" });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      saveOauthClient(
        serverId,
        draft.clientId.trim(),
        draft.clientSecret.trim(),
      ),
    onSuccess: () => {
      setError(null);
      setDraft({ clientId: "", clientSecret: "" });
      onSaved();
      void queryClient.invalidateQueries({ queryKey: pluginKeys.all });
    },
    onError: () =>
      setError(t("That client could not be saved. Please try again.")),
  });

  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-muted-foreground text-xs leading-relaxed">
        {t(
          "This service does not register clients on its own. Register one in the service's console with exactly the address below, then paste what it gives you.",
        )}
      </p>
      {redirectUri ? (
        /* `select-all` so one click takes the whole address: it has to be copied exactly, and a
         * half-selected URL registered at a vendor fails only at the end of somebody's consent. */
        <code className="mt-2 block select-all break-all rounded-md bg-foreground/5 px-2 py-1 font-mono text-xs">
          {redirectUri}
        </code>
      ) : (
        <p className="mt-2 text-destructive text-xs">
          {t(
            "This deployment has no public address yet, so there is no address to register.",
          )}
        </p>
      )}
      <FieldGroup className="mt-3">
        <Field>
          <FieldLabel htmlFor={`oauth-client-id-${serverId}`}>
            {t("Client ID")}
          </FieldLabel>
          <Input
            id={`oauth-client-id-${serverId}`}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                clientId: event.target.value,
              }))
            }
            value={draft.clientId}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`oauth-client-secret-${serverId}`}>
            {t("Client secret")}
          </FieldLabel>
          {/* Masked on the way in, like every other secret this page collects. */}
          <Input
            id={`oauth-client-secret-${serverId}`}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                clientSecret: event.target.value,
              }))
            }
            type="password"
            value={draft.clientSecret}
          />
        </Field>
      </FieldGroup>
      {error ? (
        <p className="mt-2 text-destructive text-xs" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        className="mt-3"
        disabled={!draft.clientId.trim() || save.isPending}
        onClick={() => save.mutate()}
        size="sm"
        type="button"
      >
        {t("Save")}
      </Button>
    </div>
  );
};

/**
 * One person's connection to one server they consent to for themselves.
 *
 * The same strip on the admin Plugins page and on the personal Connected accounts page, because it
 * is the same fact on both: an administrator's Notion connection is theirs, not the deployment's,
 * and a screen that implied otherwise would be claiming everybody is connected because one person
 * is. Only the paste-a-client half belongs to an administrator, which is why that is a prop.
 */
export const ConnectionStrip = ({
  serverId,
  returnTo,
  canRegisterClient = false,
  dynamicClient = false,
  hasCredential = false,
  needsInstanceHost = false,
  instanceName = null,
}: {
  serverId: string;
  /** Which screen the vendor sends this person back to when they are done. */
  returnTo: "admin" | "settings";
  /** Whether to offer the client form. Plugins is admin-only; Connected accounts is not. */
  canRegisterClient?: boolean;
  /** Whether the deployment registers its own client. False is what makes the form worth drawing. */
  dynamicClient?: boolean;
  hasCredential?: boolean;
  /**
   * Whether this vendor gives every customer their own hostname, so the person types its name.
   *
   * A Cafe24 mall id and nothing else. It is not a secret — it is on the address bar of the shop —
   * which is why it is a plain field here rather than anything the credential vault holds.
   */
  needsInstanceHost?: boolean;
  /** What the deployment already has, so a reconnect does not ask for it again. */
  instanceName?: string | null;
}) => {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery(connectionsQueryOptions());
  const [error, setError] = useState<string | null>(null);
  const [shopId, setShopId] = useState(instanceName ?? "");
  /*
   * The server said there is nothing to send anybody to consent with. Read ALONGSIDE
   * `hasCredential` rather than instead of it: a client that was stored and then revoked still
   * reads as present in the list, and only the refusal knows it cannot be spent.
   */
  const [clientRefused, setClientRefused] = useState(false);
  /*
   * The consent screen was handed to the person's own browser, so this window is not going to
   * navigate anywhere and the strip has to say what is happening. See the shell branch below.
   */
  const [waitingInBrowser, setWaitingInBrowser] = useState(false);

  const connection =
    data?.connections.find((row) => row.serverId === serverId) ?? null;

  const connect = useMutation({
    mutationFn: () =>
      beginConnect(
        serverId,
        returnTo,
        needsInstanceHost ? shopId.trim() : undefined,
      ),
    onSuccess: async (authorizationUrl) => {
      // A whole-page navigation, not a router one: the next screen belongs to the vendor — unless
      // the shell handed it to the person's own browser, which is what `openConsent` decides.
      const where = await openConsent(authorizationUrl, (url) =>
        window.location.assign(url),
      );
      if (where === "browser") setWaitingInBrowser(true);
    },
    onError: (thrown: Error) => {
      setError(refusalText(thrown));
      if (thrown instanceof ConnectRefusedError && thrown.status === 409) {
        setClientRefused(true);
      }
    },
  });

  const disconnect = useMutation({
    mutationFn: () => disconnectServer(serverId),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({
        queryKey: pluginKeys.connections(),
      });
    },
    onError: () =>
      setError(t("The connection could not be removed. Please try again.")),
  });

  const wantsClient =
    canRegisterClient && !dynamicClient && (!hasCredential || clientRefused);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {isPending ? (
          /* Never "not connected" before the answer is in: this row is the only thing on screen
           * saying whether somebody's account is reachable, and a wrong guess is a lie about it. */
          <span className="text-muted-foreground text-xs">
            {t("Checking the connection…")}
          </span>
        ) : connection ? (
          <>
            <span className="font-medium text-xs">{t("Connected")}</span>
            <span className="text-muted-foreground text-xs">
              {new Date(connection.connectedAt).toLocaleDateString(
                activeLocale,
              )}
            </span>
            <Button
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("Disconnect")}
            </Button>
          </>
        ) : waitingInBrowser ? (
          /*
           * The consent is happening in another window, so this one has nothing to report until the
           * person comes back. The query re-asks on focus, which covers the ordinary path; the
           * button is for a browser that never took focus away from this window.
           */
          <>
            <span className="text-muted-foreground text-xs">
              {t("Finish in the browser that just opened, then come back.")}
            </span>
            <Button
              onClick={() => {
                setWaitingInBrowser(false);
                void queryClient.invalidateQueries({
                  queryKey: pluginKeys.connections(),
                });
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("Check again")}
            </Button>
          </>
        ) : (
          <>
            {/*
             * BEFORE the button, because it is what the button needs. A vendor that gives every
             * customer their own hostname cannot be reached without this, and asking for it after
             * the press would be a refusal in front of somebody who did nothing wrong.
             */}
            {needsInstanceHost ? (
              <Input
                aria-label={t("Shop ID")}
                className="h-8 w-40 text-xs"
                onChange={(event) => setShopId(event.target.value)}
                placeholder={t("Shop ID")}
                value={shopId}
              />
            ) : null}
            <Button
              disabled={
                connect.isPending || (needsInstanceHost && !shopId.trim())
              }
              onClick={() => connect.mutate()}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("Connect")}
            </Button>
          </>
        )}
      </div>

      {/* Where to look for it, said once and only where it is asked for. Nobody knows their mall id
          by heart, and everybody has it open in another tab. */}
      {needsInstanceHost && !connection ? (
        <p className="text-muted-foreground text-xs">
          {t("The name in front of .cafe24.com in your shop's address.")}
        </p>
      ) : null}

      {/* The vendor's own words for what it handed over, shown and not interpreted. A vendor whose
          consent screen is the scoping sends none, and inventing one would assert a control that
          does not exist. */}
      {connection?.scope ? (
        <p className="text-muted-foreground text-xs">
          {t("Granted access")}{" "}
          <code className="break-all font-mono">{connection.scope}</code>
        </p>
      ) : null}

      {error ? (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      ) : null}

      {wantsClient ? (
        <OAuthClientForm
          onSaved={() => setClientRefused(false)}
          redirectUri={data?.redirectUri ?? null}
          serverId={serverId}
        />
      ) : null}
    </div>
  );
};

/**
 * What the vendor's redirect said, kept on screen after the parameter carrying it is gone.
 *
 * The parameter is cleared the moment it is read, because the address bar now holds the URL a
 * vendor sent somebody back to — reloading or sharing it would re-announce a connection that
 * happened once. Latching the value into state first is what keeps the sentence up while the
 * address loses it.
 */
export const ConnectOutcome = ({
  connected,
  onClear,
  titleFor,
  onConnected,
}: {
  connected: string | undefined;
  onClear: () => void;
  /** The server's title, so the notice names what was connected rather than its slug. */
  titleFor: (serverId: string) => string;
  /**
   * What to do once, on the way back from a consent that worked.
   *
   * The admin page asks the server for its tool list here, and that is not a nicety: a `user-oauth`
   * server has no tools until somebody who has connected asks it for them, so the page a person
   * lands on after connecting said "Connected" above a connector offering nothing, with a button
   * they had no reason to know they must press. Absent on the personal page, where refreshing is an
   * administrator's endpoint and there is nothing this person could do with it.
   */
  onConnected?: (serverId: string) => void;
}) => {
  const [outcome, setOutcome] = useState<string | null>(null);

  useEffect(() => {
    // `outcome !== null` and not just the parameter: clearing takes a navigation, and without this
    // every render in between would fire another one. It is also what makes `onConnected` fire once
    // whatever identity the parent passes — in development StrictMode remounts this component, so
    // the latch is rebuilt and the effect genuinely does run twice there and once in a build.
    if (!connected || outcome !== null) return;
    setOutcome(connected);
    onClear();
    if (connected !== "failed") onConnected?.(connected);
  }, [connected, outcome, onClear, onConnected]);

  if (outcome === null) return null;
  return outcome === "failed" ? (
    <p className="mt-4 text-destructive text-sm" role="alert">
      {t(
        "The connection did not finish, and nothing was saved. Please try again.",
      )}
    </p>
  ) : (
    <p className="mt-4 text-muted-foreground text-sm" role="status">
      {t("Connected to {name}.", { name: titleFor(outcome) })}
    </p>
  );
};
