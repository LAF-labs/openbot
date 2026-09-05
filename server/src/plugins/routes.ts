import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import {
  authEndpointsFor,
  CATALOGUE,
  type CatalogueEntry,
  catalogueEntry,
} from "./catalogue";
import type { ConnectFailureReason } from "./connected-page";
import {
  authorizationUrlFor,
  challengeFor,
  connectedAccountsUrlFor,
  type ConnectOrigin,
  createVerifier,
  redeemAuthorizationCode,
  redeemConnectState,
  redirectUriFor,
  relayRedirectUriFor,
  relayStateFor,
  sealedPartOf,
  sealConnectState,
  shellConnectedUrlFor,
} from "./oauth";
import {
  connectableCatalogue,
  entryIsConnectable,
  NO_SHARED_CLIENTS,
  type SharedClientLookup,
} from "./shared-clients";
import {
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  type OAuthClient,
  PluginNeedsApprovalError,
  PluginRefusedError,
  type PluginStore,
} from "./store";

/**
 * What the connect flow needs from the deployment, and nothing else.
 *
 * `publicUrl` is where a vendor sends the browser back — it has to match what was registered with
 * the vendor character for character, so it comes from configuration and never from a request.
 * `appUrl` is where a person lands afterwards, for the local split where the app and this server
 * are two origins; absent means same-origin and relative redirects are right.
 *
 * `personHasAccess` is asked when the callback lands, not when the flow began: the callback carries
 * no session — identity comes from the sealed state — and access can end inside the state's ten
 * minutes. Without it, a consent finishing after an offboarding writes a fresh refresh token for
 * somebody who no longer has access.
 */
export type ConnectConfig = {
  publicUrl?: string | undefined;
  appUrl?: string | undefined;
  encryptionKey: string;
  personHasAccess: (userId: string) => Promise<boolean>;
  /**
   * The OAuth applications LAF registered once for the whole fleet. Absent means none, which leaves
   * every entry that consents under one out of the catalogue this surface offers.
   */
  sharedClient?: SharedClientLookup;
  /**
   * The fleet's relay, and this deployment's own name in front of it.
   *
   * Absent means every vendor is told this deployment's own callback, which is correct on a laptop
   * and for a vendor that registers a client per deployment (Notion). Present, an entry marked
   * `relay` is told the relay's address instead — the only value a fleet-wide application can have
   * registered, since `*.agent.laf-co.com` is not a redirect URI any vendor will accept.
   *
   * `slug` is derived from `PUBLIC_ORIGIN` at boot and refuses to start when the origin is not under
   * the product domain (`server/src/config.ts`), so by the time it is here it names a customer the
   * fleet can look up.
   */
  relay?: { url: string; slug: string };
};

/**
 * The Plugins surface: what this deployment has added, and which Bots may use it.
 *
 * What a Bot can reach is an administrator's; what it is told is not. Adding an MCP server stores a
 * credential and opens a path into another company's system, and enabling one on a Bot is the same
 * decision one step later, so both are an administrator's. A skill only ever asks for tools the Bot
 * already holds, and every one of those calls is still decided, policy-checked and audited, so
 * anybody may write one for themselves and put it on a Bot they own.
 *
 * Reading is open to any signed-in person either way: what a Bot can reach is not a secret from the
 * person talking to it.
 *
 * The call endpoint asks again. The list of tools a run was offered is a snapshot taken when the run
 * started, so a grant revoked a second later is still in the model's hands. Deciding at call time is
 * what makes revocation immediate rather than nearly immediate, and it is where a refusal becomes a
 * row somebody can read.
 */
export function createPluginRoutes(
  store: PluginStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  connect?: ConnectConfig,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  const sharedClient = connect?.sharedClient ?? NO_SHARED_CLIENTS;

  /** The fleet's application for this entry, or null when it consents under one of its own. */
  const sharedClientFor = (entry: CatalogueEntry): OAuthClient | null =>
    entry.auth.kind === "user-oauth" && entry.auth.sharedClient
      ? sharedClient(entry.auth.sharedClient)
      : null;

  /**
   * Whether this consent goes through the fleet's relay, and under whose name.
   *
   * Both halves have to be true: the entry says its vendor checks `redirect_uri` against one
   * registered value, and this deployment knows where the relay is. A deployment without a relay
   * configured — a laptop — sends its own callback, which is what a vendor registered against
   * `http://localhost:3001` expects.
   */
  const relayFor = (entry: CatalogueEntry) =>
    entry.relay && connect?.relay ? connect.relay : null;

  /**
   * Where this vendor is told to send the browser back.
   *
   * The SAME value in both legs, which is the property that matters: a vendor compares the
   * `redirect_uri` on the token exchange against the one on the authorization request and refuses
   * the exchange if they differ. Written once here so the two call sites cannot drift.
   */
  const redirectUriOf = (entry: CatalogueEntry, publicUrl: string): string => {
    const relayed = relayFor(entry);
    if (!relayed) return redirectUriFor(publicUrl);
    // The shared APPLICATION's name, not the entry's: five Google connectors consent under one
    // Google application, which has one registered redirect URI between them.
    const family =
      entry.auth.kind === "user-oauth" ? entry.auth.sharedClient : undefined;
    return relayRedirectUriFor(relayed.url, family ?? entry.key);
  };

  /**
   * The first label of a stored per-instance URL — the mall id somebody typed, read back.
   *
   * Only for an entry that HAS one. Every hostname has a first label, so reading it unconditionally
   * answered "sheets" for Google Sheets and "mybusiness" for Business Profile: a name the person
   * never typed, sent to a surface that would have shown it back to them as their own.
   */
  const instanceNameOf = (
    entry: CatalogueEntry,
    url: string | undefined,
  ): string | null => {
    if (entry.host !== null || !url) return null;
    try {
      const label = new URL(url).hostname.split(".")[0];
      return label || null;
    } catch {
      return null;
    }
  };

  const actorEmail = (context: { var: AppVariables }) =>
    context.var.actor?.email ?? "unknown";

  const skillActor = (context: { var: AppVariables }) => ({
    id: context.var.actor.id,
    isAdmin: context.var.actor.role === "admin",
  });

  /**
   * May this person write, edit or delete this skill?
   *
   * An administrator may touch anything. Everybody else may touch their own and nothing else, which
   * includes not editing a deployment skill an administrator wrote for everyone.
   */
  async function skillRefusal(
    context: { var: AppVariables },
    slug: string,
  ): Promise<string | null> {
    const actor = skillActor(context);
    if (actor.isAdmin) return null;
    const owner = await store.skillOwner(slug);
    if (owner === undefined) return null; // A new skill. Ownership is decided on the way in.
    if (owner === null) {
      return `${slug} belongs to this deployment. An administrator looks after it.`;
    }
    return owner === actor.id ? null : `${slug} is somebody else's skill.`;
  }

  /** Everything the Plugins page draws: the catalogue, what is added, and the skills. */
  routes.get("/", requireUser, async (context) =>
    context.json({
      catalogue: CATALOGUE.map((entry) => ({
        key: entry.key,
        title: entry.title,
        vendor: entry.vendor,
        summary: entry.summary,
        docsUrl: entry.docsUrl,
        /** Whose credential reaches it, so the surface offers the right gesture: a token field for
         * `deployment-bearer`, a connect button for `user-oauth`, nothing for `none`. */
        auth: entry.auth.kind,
        /** Whether the deployment registers its own OAuth client, so the screen can hide the
         * paste-a-client form where there is nothing for it to collect. */
        dynamicClient:
          entry.auth.kind === "user-oauth" &&
          entry.auth.clientRegistration === "dynamic",
        perInstance: entry.host === null,
      })),
      servers: await store.listServers(),
      // Scoped: the deployment's skills plus this person's own. An administrator sees them all.
      skills: await store.listSkills(skillActor(context)),
    }),
  );

  /** Add a curated server. The URL comes from the catalogue, never from the request. */
  routes.post("/servers", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      key?: string;
      instanceHost?: string;
      credentialId?: string;
    } | null;
    if (!body?.key) {
      return context.json({ error: "A catalogue key is required." }, 400);
    }

    try {
      const server = await store.addServer({
        key: body.key,
        instanceHost: body.instanceHost,
        credentialId: body.credentialId,
        by: actorEmail(context),
      });
      return context.json({ server });
    } catch (error) {
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  /**
   * Add a server by URL.
   *
   * Its own endpoint rather than a flag on the one above, so that "an administrator pointed this
   * deployment at an address of their own" is a distinct act in the code, in the audit trail and in
   * anything that reads either.
   */
  routes.post("/servers/custom", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      id?: string;
      title?: string;
      url?: string;
      credentialId?: string;
    } | null;
    if (!body?.id || !body.title || !body.url) {
      return context.json(
        { error: "A name, a title and a URL are required." },
        400,
      );
    }

    try {
      const server = await store.addCustomServer({
        id: body.id,
        title: body.title,
        url: body.url,
        credentialId: body.credentialId,
        by: actorEmail(context),
      });
      return context.json({ server });
    } catch (error) {
      if (
        error instanceof CustomServerRefusedError ||
        error instanceof CatalogueEntryUnknownError
      ) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  routes.delete("/servers/:id", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    await store.removeServer(context.req.param("id"), actorEmail(context));
    return context.json({ ok: true });
  });

  /** Ask a server what it offers now. Reported rather than thrown, so the page can say what broke. */
  /**
   * A person reviewed a changed tool definition and consents to it as it now
   * is. Until this is pressed the tool refuses to run — the pause is the
   * feature, so only an administrator may end it.
   */
  routes.post(
    "/servers/:id/tools/:name/approve",
    requireUser,
    async (context) => {
      const forbidden = requireAdmin(context);
      if (forbidden) {
        return forbidden;
      }
      const approved = await store.approveToolDefinition(
        context.req.param("id"),
        context.req.param("name"),
        context.var.actor.id,
      );
      return approved
        ? context.json({ ok: true })
        : context.json({ error: "No such tool" }, 404);
    },
  );

  routes.post("/servers/:id/refresh", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    try {
      // The refresher's own id: a `user-oauth` server's tool list is asked for on the grant of
      // whoever pressed refresh, because the deployment holds no credential of its own to ask with.
      const result = await store.refreshTools(
        context.req.param("id"),
        context.var.actor.id,
      );
      const servers = await store.listServers();
      return context.json({
        tools: result.tools,
        server: servers.find((server) => server.id === context.req.param("id")),
      });
    } catch (error) {
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  /**
   * Which `user-oauth` servers this person has connected, and which they could.
   *
   * `available` is the 연결 screen's whole list, and it is the CATALOGUE rather than what an
   * administrator has added: on a one-person deployment there is nobody else to add anything, and a
   * screen that said "an administrator has to set one up first" would be pointing at the person
   * reading it. An entry only appears once this deployment actually holds the application behind it
   * — see {@link entryIsConnectable} — because a 연결 button in front of a vendor with no
   * credentials is a control that cannot do the thing it offers.
   *
   * FACTS ONLY, no prose. `title` is the vendor's own brand name, which is theirs in every language;
   * `summary` is this file's English and the surface is expected to replace it from its own table
   * (`app/src/lib/plugins/catalogue-copy.ts`), which is why it is sent as a fallback rather than as
   * the words to draw. The rest is which entries exist, whether one needs a mall id typed in, and
   * what is stored for it now.
   */
  routes.get("/connections", requireUser, async (context) => {
    const connections = await store.connectionsFor(context.var.actor.id);
    const stored = await store.listServers();
    return context.json({
      connections,
      available: connectableCatalogue(sharedClient).map((entry) => ({
        id: entry.key,
        title: entry.title,
        summary: entry.summary,
        docsUrl: entry.docsUrl,
        /** True for a vendor that gives every customer their own hostname (Cafe24's mall id). */
        needsInstanceHost: entry.host === null,
        /**
         * The name this deployment already has for a per-instance vendor, so somebody reconnecting
         * is not asked to remember their own mall id. Null when nothing is stored yet.
         */
        instanceName: instanceNameOf(
          entry,
          stored.find((server) => server.id === entry.key)?.url,
        ),
      })),
      // Shown to an administrator so they can register a client at the vendor with the exact value
      // this deployment will send. Null means the deployment has no public URL and cannot connect.
      redirectUri: connect?.publicUrl
        ? redirectUriFor(connect.publicUrl)
        : null,
    });
  });

  /**
   * Store an OAuth client an administrator registered at the vendor by hand.
   *
   * For vendors without dynamic registration (Google). Admin-only, because the client identifies
   * the whole deployment, and replacing it invalidates every existing consent.
   */
  routes.post("/servers/:id/oauth-client", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      clientId?: string;
      clientSecret?: string;
    } | null;
    if (!body?.clientId) {
      return context.json({ error: "A client id is required." }, 400);
    }

    try {
      await store.registerOAuthClient({
        serverId: context.req.param("id"),
        client: {
          clientId: body.clientId.trim(),
          clientSecret: body.clientSecret?.trim() ?? "",
        },
        by: actorEmail(context),
      });
      return context.json({ ok: true });
    } catch (error) {
      if (
        error instanceof CustomServerRefusedError ||
        error instanceof CatalogueEntryUnknownError
      ) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  /**
   * Begin connecting one person's own account.
   *
   * Answers with a URL rather than redirecting, so the browser decides when to leave the page. The
   * state is minted here, from the session, and the person's identity never comes off the callback.
   */
  routes.post("/servers/:id/connect", requireUser, async (context) => {
    const serverId = context.req.param("id");
    if (!connect?.publicUrl) {
      return context.json(
        {
          error:
            "This deployment has no public URL configured, so it cannot complete a consent flow. Set BETTER_AUTH_URL.",
          code: "laf:no_public_url",
        },
        503,
      );
    }

    const entry = catalogueEntry(serverId);
    if (entry?.auth.kind !== "user-oauth") {
      return context.json(
        {
          error: `${serverId} is not connected as an individual person.`,
          code: "laf:not_a_personal_connection",
        },
        400,
      );
    }

    /*
     * The fleet never configured this vendor, so there is no application to consent under.
     *
     * Refused rather than attempted, and it is the same refusal the catalogue listing acts on: an
     * entry that reaches this point without credentials would send somebody to a consent screen
     * that ends in `invalid_client`, which reads as their own account being at fault.
     */
    if (!entryIsConnectable(entry, sharedClient)) {
      return context.json(
        {
          error: `${entry.title} is not configured on this deployment.`,
          code: "laf:connector_not_configured",
        },
        409,
      );
    }

    /*
     * The one thing a person types, for a vendor that gives every customer its own hostname.
     *
     * Not a secret — a mall id is on the shop's own address bar — which is why it is a plain field
     * on the card and is stored as part of the server's URL rather than in the vault. It is checked
     * against the entry's anchored pattern before anything is stored, by `addServer`, so what
     * arrives here can only ever become a host this entry was reviewed for.
     */
    const body = (await context.req.json().catch(() => null)) as {
      instanceName?: unknown;
    } | null;
    const instanceName =
      typeof body?.instanceName === "string" ? body.instanceName.trim() : "";
    if (entry.host === null && !instanceName) {
      return context.json(
        {
          error: `${entry.title} needs the name of the shop this deployment should connect to.`,
          code: "laf:instance_name_required",
        },
        400,
      );
    }

    /*
     * The server row, created on the spot if this is the first press.
     *
     * WHY THE PRESS IS ENOUGH. Adding a curated server used to be an administrator's act, and on a
     * deployment shared by a company it still reads that way. This one is not shared: one VM per
     * person (docs/laf/deployment-model.md), the entry is reviewed in code with a pinned host, and
     * the application it consents under is the fleet's rather than anything typed here. What is
     * left for an administrator to decide is nothing, and making somebody visit an admin page to
     * unlock a button on their own settings page is ceremony in front of a decision nobody makes.
     *
     * The audit row `addServer` writes still says who did it and when.
     */
    let serverUrl: string;
    try {
      const ensured = await store.ensureCatalogueServer({
        key: serverId,
        ...(instanceName ? { instanceName } : {}),
        by: actorEmail(context),
      });
      serverUrl = ensured.url;
    } catch (error) {
      if (
        error instanceof CustomServerRefusedError ||
        error instanceof CatalogueEntryUnknownError
      ) {
        return context.json(
          { error: error.message, code: "laf:instance_name_refused" },
          400,
        );
      }
      throw error;
    }

    /*
     * The vendor's three addresses, with a per-instance vendor's own host filled in. Null means the
     * stored row does not name a host this entry would be pointed at, which cannot happen right
     * after `ensureCatalogueServer` accepted it and is refused rather than assumed away.
     */
    const endpoints = authEndpointsFor(entry, serverUrl);
    if (!endpoints) {
      return context.json(
        {
          error: `${entry.title} is not at an address this deployment will send a consent to.`,
          code: "laf:instance_name_refused",
        },
        400,
      );
    }

    /*
     * A dynamic entry introduces the deployment itself on first use; a manual one still waits for
     * an administrator. Registration lives here, on the one handler that already refuses without a
     * public URL — the redirect URI it registers is guaranteed to exist.
     *
     * A vendor in the catalogue that nobody has added to this deployment reaches here, gets past
     * every check above — the entry is real — and then asks the store for a client it cannot have,
     * because there is no server row to hold one. `ensureOAuthClient` says so by throwing, and
     * unhandled that was a 500 on the one path where a person is trying to connect their account.
     */
    let client: OAuthClient | null;
    try {
      client =
        // The fleet's own application first: it is not in the vault and never will be, so a lookup
        // there would find nothing and send the person off to register something themselves.
        sharedClientFor(entry) ??
        (await store.oauthClientFor(serverId)) ??
        (entry.auth.clientRegistration === "dynamic"
          ? await store.ensureOAuthClient(serverId, actorEmail(context))
          : null);
    } catch (error) {
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json(
          {
            error: `${entry.title} has not been added to this deployment yet. An administrator has to add it first.`,
            code: "laf:server_not_added",
          },
          409,
        );
      }
      throw error;
    }
    if (!client) {
      if (entry.auth.clientRegistration === "dynamic") {
        return context.json(
          {
            error: `${entry.title} refused this deployment's registration. Try again, and check the vendor's status if it persists.`,
            code: "laf:registration_refused",
          },
          502,
        );
      }
      return context.json(
        {
          error: `${entry.title} has no OAuth client registered yet. An administrator has to add one first.`,
          code: "laf:no_oauth_client",
        },
        409,
      );
    }

    /*
     * Where to come back to, as one of two names rather than a URL the caller chose.
     *
     * Read from the query and narrowed immediately, so an unrecognised value is the default rather
     * than something carried into a sealed state. See {@link ConnectOrigin} in oauth.ts: a
     * destination that could name another origin is an open redirect with a consent screen in
     * front of it.
     */
    const asked = context.req.query("returnTo");
    /*
     * Three names now, and `shell` is the one that is not a page of this app: it lands on this
     * server's own session-free `/connected`, because in the desktop shell the consent goes out to
     * the person's OWN browser and the app has no session there. Sent by the app when
     * `window.__TAURI__` is present (`lib/plugins/queries.ts`), and still narrowed here rather
     * than trusted — an unrecognised value is the default, never something carried into a sealed
     * state.
     */
    const returnTo: ConnectOrigin =
      asked === "admin" ? "admin" : asked === "shell" ? "shell" : "settings";

    const verifier = createVerifier();
    const sealed = await sealConnectState(
      { userId: context.var.actor.id, serverId, verifier, returnTo },
      connect.encryptionKey,
    );
    const relayed = relayFor(entry);
    return context.json({
      authorizationUrl: authorizationUrlFor({
        auth: { ...entry.auth, authorizationUrl: endpoints.authorizationUrl },
        clientId: client.clientId,
        redirectUri: redirectUriOf(entry, connect.publicUrl),
        /*
         * The customer's name in front of the sealed state, and ONLY when the consent is relayed.
         *
         * The relay reads that name to know which of the fleet's deployments to hand the browser
         * back to; it cannot read anything else, because the rest is sealed with a key only this
         * deployment holds. A vendor that answers us directly is told a bare state, so nothing about
         * which customer this is travels where it is not needed.
         */
        state: relayed ? relayStateFor(relayed.slug, sealed) : sealed,
        codeChallenge: challengeFor(verifier),
      }),
    });
  });

  /**
   * One person disconnecting their own account from one server.
   *
   * And the grants their Bots held on it, which the credential's retirement does not take:
   * `plugin_grants.ref` is `<server>/<tool>` as plain text with no key behind it. Left standing,
   * every Bot they own would keep being offered a tool whose only possible answer is now
   * `laf:not_connected` — a capability that exists only to say no. The partner disconnect learned
   * this the same way (`875662d`), by somebody pressing 연결 해제 and then reading the table.
   *
   * The server ROW stays. It is the deployment's, and on a shared one somebody else is connected to
   * it — which is the one place this and the partner disconnect differ.
   */
  routes.post("/servers/:id/disconnect", requireUser, async (context) => {
    const serverId = context.req.param("id");
    const outcome = await store.disconnectAccount({
      serverId,
      userId: context.var.actor.id,
    });
    if (outcome.disconnected) {
      await store.withdrawToolsFrom(
        serverId,
        context.var.actor.id,
        actorEmail(context),
      );
    }
    return context.json(outcome);
  });

  /**
   * Where the vendor sends somebody back.
   *
   * Deliberately not behind `requireUser`. The person arrives on a redirect from another company's
   * server, and whose connection this is comes from the sealed state rather than from whatever
   * session the browser happens to be carrying — which is what stops a callback delivered to the
   * wrong browser from attaching one person's account to another person's row.
   *
   * Having no session is what makes the access check below necessary. Every other route asks the
   * question by being behind a guard; this one has to ask it out loud.
   *
   * Every failure ends at the same PLACE, with nothing written — and now with one of five words
   * for which kind it was. `failed` alone was all anybody got: a consent they declined, a link
   * they came back to twice, a tab left open over lunch and a vendor refusing the exchange all
   * produced the same sentence, none of which said what to do next.
   *
   * THE WORDS ARE OURS AND THERE ARE FIVE, so this is not the old "spelling out which is which
   * tells a prober how far they got" being reversed. A prober learns nothing they could not
   * measure by timing: the two states-related words are the only ones reachable without a real
   * consent behind them, and they say the same thing to anybody — that this URL is spent. Nothing
   * a vendor wrote reaches the query, which is the property that always mattered.
   */
  routes.get("/oauth/callback", async (context) => {
    /*
     * Where a failure lands, and it depends on where the flow began — which is only known once the
     * state has been opened. Before that, the app is the honest guess: a shell flow whose state
     * cannot be read is indistinguishable from a browser one, and `/settings/connected-accounts`
     * is at least a page the person can reach in the browser they are holding.
     */
    const failedAt = (
      reason: ConnectFailureReason,
      returnTo: ConnectOrigin = "settings",
    ) =>
      returnTo === "shell" && connect?.publicUrl
        ? shellConnectedUrlFor(connect.publicUrl, { failed: true, reason })
        : connectedAccountsUrlFor(
            connect?.appUrl,
            { failed: true, reason },
            returnTo,
          );

    // A deployment with no public URL registered nothing at any vendor, so nothing here can
    // complete. `mismatch`, in the sense every branch below uses it: the request cannot be honoured
    // as it stands.
    if (!connect?.publicUrl) return context.redirect(failedAt("mismatch"));

    /*
     * No code is the vendor sending somebody back without one, which is what declining looks like —
     * `?error=access_denied` on Google, an empty return elsewhere. Nobody did anything wrong, and
     * "취소됐습니다" is the only honest thing to say about it.
     */
    const code = context.req.query("code");
    if (!code) return context.redirect(failedAt("denied"));

    /*
     * Redeemed, not merely read: a state stands for one attempt and is spent here whatever happens
     * next. The callback URL is held by every log, proxy and browser history it passes through, so
     * without this a second walk down the same URL was refused only if the VENDOR happened to refuse
     * the spent code — somebody else's implementation detail deciding whether a replay attached a
     * second grant.
     *
     * The refusal carries a code (`laf:state_replayed` and `laf:state_unreadable`) which is
     * deliberately not shown: every failure ends the same way, because telling a caller which of
     * them it was tells anybody probing this endpoint how far they got.
     */
    const opened = await redeemConnectState(
      /*
       * The sealed half, whatever the relay left in front of it.
       *
       * The relay is expected to strip the customer's name before handing the browser back, and one
       * that forwards the state verbatim is a working relay too. Nothing before the first dot is
       * believed either way: this deployment's own seal is the only thing here that decides
       * anything, and it names the person, the server and the PKCE verifier itself.
       */
      sealedPartOf(context.req.query("state") ?? ""),
      connect.encryptionKey,
    );
    if (!opened.ok) {
      /*
       * The one place the two state refusals are told apart for a person, because their next moves
       * differ: an expired state is worth starting again immediately, and a replayed one means the
       * connection they are worried about probably already happened.
       *
       * A replay still knows where it began — it opened, and was then found spent — so it lands
       * where the flow started. An unreadable state names nothing, and the app is the honest guess.
       */
      return context.redirect(
        opened.fact === "laf:state_replayed"
          ? failedAt("reused", opened.returnTo ?? "settings")
          : failedAt("expired"),
      );
    }
    const { state } = opened;
    // Every failure from here on knows where the flow began, so it can land where the person is.
    const returnTo = state.returnTo ?? "settings";

    /*
     * Is the person in the state still somebody here?
     *
     * Asked here, before the code is redeemed and before anything is written, because a state is
     * good for ten minutes and access can end inside them. Without this, a consent finishing after
     * an offboarding writes a fresh, live refresh token belonging to somebody who no longer has
     * access, which nothing downstream will ever revoke because nothing knows it was created.
     *
     * The same anonymous failure as an unreadable state. Whether somebody has access is not a fact
     * this endpoint owes an unauthenticated caller.
     */
    if (!(await connect.personHasAccess(state.userId))) {
      return context.redirect(failedAt("mismatch", returnTo));
    }

    /*
     * `mismatch` for the three below as well: the state is real and this deployment cannot honour
     * what it names — the entry is not one people connect, the client is gone, the row names a host
     * this entry would not be pointed at. Deliberately one word for all of them. They are the same
     * thing to the person (nothing they typed is wrong, and pressing 연결 again is the move) and
     * telling them apart would be this endpoint narrating its own configuration to anybody.
     */
    const entry = catalogueEntry(state.serverId);
    if (entry?.auth.kind !== "user-oauth") {
      return context.redirect(failedAt("mismatch", returnTo));
    }

    const client =
      sharedClientFor(entry) ?? (await store.oauthClientFor(state.serverId));
    if (!client) return context.redirect(failedAt("mismatch", returnTo));

    /*
     * The token endpoint, resolved against the row the connect handler ensured. A per-instance
     * vendor's is its own, and a row naming a host this entry would not be pointed at ends the flow
     * here rather than posting a code to it.
     */
    const endpoints = authEndpointsFor(
      entry,
      await store.storedServerUrl(state.serverId),
    );
    if (!endpoints) return context.redirect(failedAt("mismatch", returnTo));

    const grant = await redeemAuthorizationCode({
      tokenUrl: endpoints.tokenUrl,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      code,
      // The SAME value the consent went out with, relay and all: a vendor compares the two and
      // refuses an exchange whose redirect URI does not match the request that earned the code.
      redirectUri: redirectUriOf(entry, connect.publicUrl),
      verifier: state.verifier,
      ...(entry.auth.tokenAuth ? { tokenAuth: entry.auth.tokenAuth } : {}),
    });
    /*
     * The vendor refused the exchange, which is the failure that happens AFTER the person has
     * already consented — a mismatched redirect URI, a code that took too long, a token endpoint
     * having a bad afternoon. Its own word, because "다시 시도해 주세요" is genuinely the right
     * advice here and is not the right advice for a state that was replayed.
     */
    if (!grant) return context.redirect(failedAt("exchange", returnTo));

    await store.recordConnection({
      serverId: state.serverId,
      userId: state.userId,
      refreshToken: grant.refreshToken,
      scope: grant.scope,
    });

    /*
     * And the tools, on every Bot this person owns — the half that was missing.
     *
     * Until this, consenting stored a credential and reached nothing: the settings page said 연결됨
     * and every Bot still had no Google Sheets tool, because the only thing that refreshed a
     * `user-oauth` server's tool list was the admin-only `POST /servers/:id/refresh`. A partner
     * connect has granted since it shipped (`partner-routes.ts`); this path simply never did.
     *
     * AFTER `recordConnection` because it needs the grant: listing a `user-oauth` server's tools
     * means asking the vendor as somebody, and the person who has just consented is the only
     * somebody there is. Never fails the callback — see `servers.ts`.
     */
    /*
     * `by` is the person's own id rather than their email, because this request carries no session
     * — identity here comes from the sealed state, which names the id and nothing else. The trail
     * says who, which is what it is for; it does not get to invent an address for them.
     */
    await store.offerToolsTo(state.serverId, state.userId, state.userId);

    /*
     * And back — to the app for a browser flow, and to this server's own session-free page for one
     * the desktop shell started, which is where the shell's whole problem was: the consent goes out
     * to the person's OWN browser, so the app's redirect lands somewhere with no session and says
     * 로그인하세요 over a connection that worked perfectly. See `connected-page.ts`.
     */
    return context.redirect(
      returnTo === "shell"
        ? shellConnectedUrlFor(connect.publicUrl, {
            serverId: state.serverId,
            title: entry.title,
          })
        : connectedAccountsUrlFor(
            connect.appUrl,
            { serverId: state.serverId },
            // From the sealed state, so the destination is one this deployment chose, not the
            // browser.
            returnTo,
          ),
    );
  });

  /**
   * Write a skill.
   *
   * Not admin-only. A skill is an instruction, not a capability: it can only ask a
   * Bot to use tools that Bot was already granted, and every one of those calls is still decided,
   * policy-checked and audited. Adding an MCP server is the opposite, and stays an administrator's.
   *
   * A person's skill is their own. `global` writes one for the whole deployment, which an
   * administrator may do and nobody else.
   */
  routes.post("/skills", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      slug?: string;
      title?: string;
      summary?: string;
      instructions?: string;
      global?: boolean;
    } | null;
    if (!body?.slug || !body.title || !body.instructions) {
      return context.json(
        { error: "A slug, a title and instructions are required." },
        400,
      );
    }
    if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(body.slug)) {
      return context.json(
        { error: "A slug is lower-case letters, numbers and hyphens." },
        400,
      );
    }

    const actor = skillActor(context);
    if (body.global && !actor.isAdmin) {
      return context.json(
        { error: "Only an administrator writes a skill for the deployment." },
        403,
      );
    }

    // Editing an existing slug, which is what a repeated save is, needs the right to edit that
    // skill. Without this, saving over somebody else's name would silently take it.
    const refusal = await skillRefusal(context, body.slug);
    if (refusal) return context.json({ error: refusal }, 403);

    await store.installSkill({
      slug: body.slug,
      title: body.title,
      summary: body.summary ?? "",
      instructions: body.instructions,
      ownerUserId: body.global ? null : actor.id,
      by: actorEmail(context),
    });
    return context.json({ skills: await store.listSkills(actor) });
  });

  routes.delete("/skills/:slug", requireUser, async (context) => {
    const slug = context.req.param("slug");
    const refusal = await skillRefusal(context, slug);
    if (refusal) return context.json({ error: refusal }, 403);

    await store.uninstallSkill(slug, actorEmail(context));
    return context.json({ ok: true });
  });

  /**
   * Grant and revoke, for both kinds, through one pair of endpoints.
   *
   * The store keeps one grant table because the question is the same either way; the API says the
   * same thing, so a reader is never left wondering whether skills are governed differently.
   */

  /**
   * May this person put this on that Bot?
   *
   * MCP is an administrator's, always: it reaches another company's system with a stored credential.
   * A skill is an instruction, so somebody may put their own skill on a Bot they own, and neither
   * half alone is enough. Both are checked here rather than in the store, because this is the only
   * place that knows who is asking.
   */
  async function enablementRefusal(
    context: { var: AppVariables },
    kind: "mcp" | "skill",
    ref: string,
    agentId: string,
  ): Promise<string | null> {
    const actor = skillActor(context);
    if (actor.isAdmin) return null;
    if (kind === "mcp") {
      return "An administrator decides which Bots may reach a tool.";
    }

    const owner = await store.skillOwner(ref);
    if (owner === undefined) return `There is no skill called ${ref}.`;
    if (owner !== actor.id) {
      return owner === null
        ? `${ref} belongs to this deployment. An administrator decides which Bots use it.`
        : `${ref} is somebody else's skill.`;
    }

    const botOwner = await store.agentOwner(agentId);
    if (botOwner === undefined) return "There is no such Bot.";
    if (botOwner !== actor.id) {
      // Including the shared Bots this deployment publishes, which have no owner at all: a skill
      // one person wrote would otherwise change how a Bot answers everybody.
      return "You can only put your own skills on Bots you own.";
    }
    return null;
  }

  routes.post("/grants", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      kind?: "mcp" | "skill";
      ref?: string;
      agentId?: string;
    } | null;
    if (!body?.kind || !body.ref || !body.agentId) {
      return context.json(
        { error: "A kind, a ref and a Bot are required." },
        400,
      );
    }
    const refusal = await enablementRefusal(
      context,
      body.kind,
      body.ref,
      body.agentId,
    );
    if (refusal) return context.json({ error: refusal }, 403);

    await store.grant(body.kind, body.ref, body.agentId, actorEmail(context));
    return context.json({ ok: true });
  });

  routes.delete("/grants", requireUser, async (context) => {
    const kind = context.req.query("kind");
    const ref = context.req.query("ref");
    const agentId = context.req.query("agentId");
    if ((kind !== "mcp" && kind !== "skill") || !ref || !agentId) {
      return context.json(
        { error: "A kind, a ref and a Bot are required." },
        400,
      );
    }
    const refusal = await enablementRefusal(context, kind, ref, agentId);
    if (refusal) return context.json({ error: refusal }, 403);

    await store.revoke(kind, ref, agentId, actorEmail(context));
    return context.json({ ok: true });
  });

  /** What one Bot holds. The runtime reads this to decide what to offer a model. */
  routes.get("/for/:agentId", requireUser, async (context) =>
    context.json(await store.listForAgent(context.req.param("agentId"))),
  );

  /**
   * A Bot reading one of its skills, from the browser's `skill_view` tool.
   *
   * The grant is checked and the `skill.viewed` row written inside the store, so this route cannot
   * satisfy one and skip the other. A refusal is 403 with the code the model reads and the surface
   * translates — never a sentence.
   */
  routes.post(
    "/for/:agentId/skills/:slug/view",
    requireUser,
    async (context) => {
      const viewed = await store.viewSkill({
        slug: context.req.param("slug"),
        agentId: context.req.param("agentId"),
        actorId: context.var.actor.id,
      });
      if (!viewed.allowed) {
        return context.json({ error: viewed.reason, code: viewed.reason }, 403);
      }
      return context.json(viewed.skill);
    },
  );

  /**
   * Call a tool, as a Bot.
   *
   * The grant, the policy and the audit row all happen inside the store, so this endpoint cannot
   * accidentally satisfy one of them and skip another. A refusal comes back as 403 with the reason
   * the model and the person are both shown, which is the same sentence written to the trail.
   */
  routes.post("/call", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      ref?: string;
      args?: Record<string, unknown>;
      agentId?: string;
      approvalId?: unknown;
    } | null;
    if (!body?.ref || !body.agentId) {
      return context.json({ error: "A tool and a Bot are required." }, 400);
    }

    try {
      const result = await store.callTool({
        ref: body.ref,
        args: body.args ?? {},
        botId: body.agentId,
        /*
         * The user id, not the email. A `user-oauth` server is answered with the asker's own
         * grant, keyed on `users.id`; the email stays what configuration acts are signed with.
         */
        actorId: context.var.actor.id,
        // Passed through without being looked at. An approval means something only against the call
        // the store is about to make, and a route that judged it would be a second place deciding.
        ...(typeof body.approvalId === "string" && body.approvalId
          ? { approvalId: body.approvalId }
          : {}),
      });
      return context.json(result);
    } catch (error) {
      /**
       * A boundary that wants a person, reported as 409 rather than 403.
       *
       * 403 already means one thing to everything downstream: a boundary refused you, and that is
       * final. The surface renders it as a refusal and the model is told to stop and say so. This is
       * the opposite condition, so reusing 403 would make every ask rule about a tool call read to a
       * Bot as a deny rule, and the turn would be thrown away on work the deployment was willing to
       * permit. The same status and the same body shape the computer's acting routes use, because
       * the surface waits for both in the same way.
       */
      if (error instanceof PluginNeedsApprovalError) {
        return context.json(
          {
            // A code rather than a sentence, and the facts beside it: the card is Korean and this
            // server does not write Korean. See `computer/approvals.ts` AskSubject.
            error: error.message,
            awaitingApproval: true,
            approvalId: error.approvalId,
            subject: error.subject,
            rule: error.rule,
            scope: error.scope,
            expiresAt: error.expiresAt,
          },
          409,
        );
      }
      if (error instanceof PluginRefusedError) {
        return context.json(
          { error: error.message, rule: error.rule, code: error.code },
          403,
        );
      }
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json({ error: error.message }, 404);
      }
      // A server that failed is not a refusal, and saying so matters: one means the deployment
      // decided against it, the other means somebody else's software did not answer.
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "The server did not answer.",
          failed: true,
        },
        502,
      );
    }
  });

  return routes;
}
