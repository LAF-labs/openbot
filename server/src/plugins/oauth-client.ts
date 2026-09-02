import { eq, sql } from "drizzle-orm";
import { recordAuditEvent } from "../audit";
import {
  decryptCredentialForUse,
  decryptSecret,
  encryptSecret,
} from "../credentials";
import { credentials as credentialRows, mcpServers } from "../db/schema";
import { McpServerError } from "./mcp";
import type { Servers } from "./servers";
import {
  type AccessToken,
  CustomServerRefusedError,
  INVALID_CLIENT,
  type OAuthClient,
  type PluginContext,
  PluginRefusedError,
  TokenRefusedError,
  type Transaction,
} from "./store";

/**
 * The deployment's own identity at one vendor: the OAuth client it introduces itself with.
 *
 * A client is per SERVER and per deployment, never per person — a person's grant is a refresh token
 * and lives with the connection. The distinction is the reason this is its own module: everything
 * here is about a row every connection to that vendor is bound to, so replacing one is an act that
 * reaches everybody who ever consented, and the locking exists to make sure exactly one writer
 * decides that at a time.
 */

/** How long a vendor's token endpoint gets. Shorter than a call: it is one round trip, or nothing. */
export const TOKEN_TIMEOUT_MS = 10_000;

/**
 * How long a freshly stored OAuth client is left alone after `invalid_client`.
 *
 * Re-registering once per refusal is right for one call and wrong for a deployment: a vendor that is
 * simply down answers every exchange `invalid_client`, and every tool call anywhere then mints a
 * client of its own, because each of them is the first refusal IT has seen. A client younger than
 * this was already the product of a re-registration, so registering again inside the window is
 * amplification rather than recovery — the honest answer is the vendor's refusal, unedited.
 */
const CLIENT_REREGISTRATION_BACKOFF_MS = 5 * 60_000;

/**
 * Trade a refresh token for a short-lived access token, at the vendor's own token endpoint.
 *
 * `tokenUrl` comes from the catalogue entry and never from a caller, for the same reason the MCP
 * host does not: this request carries the deployment's client secret and somebody's refresh token,
 * so where it goes is a reviewed decision rather than a runtime one.
 *
 * The vendor's error body is deliberately not passed through — it is written for whoever registered
 * the client, not for the person who asked a Bot a question, and it can name the client id. Its
 * `error` CODE is, though, and only that: `invalid_client` is what tells a client the vendor has
 * forgotten apart from a grant somebody withdrew, and those two have entirely different answers.
 * It goes out as a field on {@link TokenRefusedError} as well as in the sentence, because the field
 * is the copy the recovery reads.
 *
 * Exported for its own tests rather than for a caller. Every path through the store reaches it as
 * the default `exchangeRefreshToken`, and the store's own suites inject a stub in its place — which
 * leaves what this function does with a REAL vendor reply, honest or garbled, untested unless it can
 * be called directly.
 */
export async function exchangeRefreshTokenOverHttp(input: {
  tokenUrl: string;
  client: OAuthClient;
  refreshToken: string;
}): Promise<AccessToken> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.client.clientId,
  });
  // A public (DCR) client proves itself without one, and some vendors refuse an unexpected empty
  // field outright. The same guard the authorization-code redemption in `oauth.ts` uses.
  if (input.client.clientSecret) {
    params.set("client_secret", input.client.clientSecret);
  }

  const response = await fetch(input.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
    /*
     * A redirect is a refusal here too. This request carries the client secret AND somebody's
     * refresh token — the most a single request in this module ever carries — and following a 302
     * would hand both to whatever address the answer named. The same rule the code redemption and
     * the registration already state; this one had been left to the default.
     */
    redirect: "manual",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  if (!response.ok) {
    /*
     * The code, when the refusal is JSON and carries one. Read defensively: a token endpoint that
     * is refusing may be refusing with an HTML error page, and a parse failure here would replace
     * the vendor's status — the one fact we do have — with a syntax error.
     */
    const refusal = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    /*
     * Capped where it is read, because everything downstream of here shows it to somebody: the
     * person who asked, the model, the connector's `lastError` on the admin page, and an audit
     * payload. It is a short token in the protocol and vendor-controlled in fact, and nothing on
     * those paths is a promise about length.
     */
    const code =
      typeof refusal?.error === "string" ? refusal.error.slice(0, 64) : null;
    throw new TokenRefusedError(
      `The vendor would not renew this access (${response.status}).${code ? ` (${code})` : ""}`,
      code,
    );
  }

  /*
   * A 200 is not a promise of JSON.
   *
   * The refusal above already parses defensively; a CDN interstitial or a maintenance page
   * answering 200 with HTML would otherwise throw a SyntaxError from here — out through `callTool`,
   * which records the failure with the thrower's message, and the parser's message quotes the body
   * it choked on. So a vendor's HTML would reach an audit payload and the person who asked, as a
   * crash rather than as the refusal every other unusable reply produces.
   */
  const body = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
    refresh_token?: unknown;
  } | null;
  if (!body) {
    throw new McpServerError(
      "The vendor answered this renewal with something other than a token.",
    );
  }
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new McpServerError("The vendor renewed this access with no token.");
  }
  return {
    accessToken: body.access_token,
    expiresInSeconds:
      typeof body.expires_in === "number" ? body.expires_in : undefined,
    /*
     * Only when the vendor sent one, and only a non-empty one.
     *
     * A rotating vendor replies with a new refresh token and invalidates the one it was shown; a
     * vendor that does not rotate sends none. Reading an absent or empty field as a rotation would
     * repoint a working connection at nothing.
     */
    refreshToken:
      typeof body.refresh_token === "string" && body.refresh_token
        ? body.refresh_token
        : undefined,
  };
}

export function createOAuthClients(
  context: PluginContext,
  /**
   * The server registry, reached lazily.
   *
   * The three modules under `plugins/` that touch a connection genuinely need each other — a client
   * is persisted against a server row, a refresh reads a person's connection, and a connection
   * replaces the deployment's client — so one of the three edges has to be resolved after the set is
   * built rather than while it is being built. This is that edge, and it is only ever followed
   * inside a call.
   */
  servers: () => Servers,
) {
  const { database, auditStore, credentials, encryptionKey, options } = context;

  /** The one vault key a server's OAuth client is ever stored under. */
  const oauthClientKey = (serverId: string) => ({
    kind: "mcp_oauth_client" as const,
    provider: serverId,
    keyId: `oauth-client-${serverId}`,
  });

  /**
   * One writer at a time for one server's OAuth client, across the whole deployment.
   *
   * Everything that stores a client reads "is there a live one" and then writes accordingly, and the
   * gap between those two must be serialised. `POST /connect` is `requireUser`, so two people
   * pressing Connect on a fresh connector is not a rare interleaving: both read no live client, and
   * then the second `create` meets the first on `credentials_active_key_idx` as a raw 23505 — a 500
   * where a consent URL belonged — or, when there was a client to replace, the second `rotate` finds
   * its own predecessor already revoked and says so.
   *
   * An ADVISORY lock rather than a row lock, because the thing being protected is the ABSENCE of a
   * row as much as a row: there is nothing to lock `FOR UPDATE` on a first registration. Held for
   * the transaction, so it is released by the commit or the rollback and never by us forgetting.
   *
   * `hashtext` collisions are harmless here. Two servers sharing a hash would take turns registering
   * clients, which is slower and not wrong.
   */
  async function withOAuthClientLock<T>(
    serverId: string,
    work: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    return await database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`oauth-client-${serverId}`}))`,
      );
      return await work(transaction);
    });
  }

  /**
   * {@link storedOAuthClient}'s question, asked on the caller's own transaction.
   *
   * The same question deliberately — the server row's pointer, and the row it names being live —
   * because the callback redeems against `oauthClientFor`, which reads exactly that. A read that
   * accepted a live client the server row does NOT name would hand somebody a consent screen for a
   * client the callback then cannot find, and the connect would fail after the vendor said yes.
   *
   * On the transaction rather than through `storedOAuthClient` because the caller is inside
   * {@link withOAuthClientLock} and holding a pooled connection: a read on a second connection would
   * be a session queueing behind sessions that cannot finish until it returns.
   */
  async function heldOAuthClient(
    transaction: Transaction,
    serverId: string,
  ): Promise<OAuthClient | null> {
    const [server] = await transaction
      .select({ credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    if (!server?.credentialId) return null;

    const [held] = await transaction
      .select({
        encryptedValue: credentialRows.encryptedValue,
        revokedAt: credentialRows.revokedAt,
      })
      .from(credentialRows)
      .where(eq(credentialRows.id, server.credentialId))
      .limit(1);
    if (!held || held.revokedAt) return null;

    try {
      return JSON.parse(
        await decryptSecret(encryptionKey, held.encryptedValue),
      ) as OAuthClient;
    } catch {
      // Unreadable is the same as none: there is nothing to send anybody to consent with.
      return null;
    }
  }

  /**
   * The two writes that store a client, on one transaction: the vault row, and the pointer to it.
   *
   * One transaction because they are one decision. Separately, a failure between them leaves
   * `mcp_servers.credential_id` naming the credential the rotation had just revoked — a connector
   * that looks configured on every screen and cannot complete a consent flow.
   *
   * The caller is expected to hold {@link withOAuthClientLock}, which is what makes the read below
   * safe to act on.
   */
  async function writeOAuthClient(
    input: { serverId: string; client: OAuthClient },
    transaction: Transaction,
  ): Promise<{ replaced: boolean }> {
    const key = oauthClientKey(input.serverId);
    const value = {
      ...key,
      metadata: { server: input.serverId, clientId: input.client.clientId },
      encryptedValue: await encryptSecret(
        encryptionKey,
        JSON.stringify(input.client),
      ),
    };

    const live = await credentials.findLiveByKey(key, transaction);
    const stored = live
      ? await credentials.rotate(
          { ...value, previousCredentialId: live.id },
          transaction,
        )
      : await credentials.create(value, transaction);

    await transaction
      .update(mcpServers)
      .set({ credentialId: stored.id, updatedAt: new Date() })
      .where(eq(mcpServers.id, input.serverId));

    return { replaced: live !== null };
  }

  /**
   * The trail row for a client this deployment now holds.
   *
   * Written AFTER the transaction that stored it, not inside. The audit store has its own handle on
   * the database, so writing from inside would open a second pooled connection while the first is
   * held — the shape the pool note in `db/client.ts` warns about, and the one that turns a busy
   * deployment into a hang. A trail row lost to a crash in that window is a worse trade than a
   * deadlock, but only just, and this way round the client is at least the thing that is certain.
   */
  async function recordClientRegistered(
    input: { serverId: string; client: OAuthClient; by: string },
    replaced: boolean,
  ): Promise<void> {
    await recordAuditEvent(auditStore, {
      eventType: "mcp.oauth_client_registered",
      targetType: "mcp_server",
      targetId: input.serverId,
      payload: {
        actor: input.by,
        server: input.serverId,
        // The id, never the secret. It identifies the client that was registered, which is what
        // somebody reading the trail needs in order to check it against the vendor's console.
        clientId: input.client.clientId,
        replaced,
      },
    });
  }

  /**
   * Store the deployment's OAuth client for a `user-oauth` server, whoever obtained it.
   *
   * Both halves go into one encrypted value, so a single vault read yields a usable client. The id
   * is copied into `metadata` as well — it is not a secret, and a page listing what the deployment
   * holds should be able to name it without decrypting anything.
   *
   * Replacing a client revokes the previous one rather than orphaning it, so "what does this
   * deployment hold" keeps having one answer per server. Nobody's connection breaks in the sense
   * that matters here — a refresh token is the person's — but nobody's connection SURVIVES either: a
   * grant belongs to the client it was issued to, so replacing the client is asking everybody to
   * connect again. That is why the two callers that replace one both say so to whoever is listening.
   *
   * Shared by an administrator pasting one in and by the deployment registering its own, so `by` is
   * the only difference between the two in the trail — which is the honest one.
   */
  async function persistOAuthClient(input: {
    serverId: string;
    client: OAuthClient;
    by: string;
  }): Promise<void> {
    const { entry } = await servers().requireServer(input.serverId);
    if (entry?.auth.kind !== "user-oauth") {
      throw new CustomServerRefusedError(
        `${input.serverId} is not reached with an OAuth client.`,
      );
    }

    const { replaced } = await withOAuthClientLock(
      input.serverId,
      (transaction) =>
        writeOAuthClient(
          { serverId: input.serverId, client: input.client },
          transaction,
        ),
    );

    await recordClientRegistered(input, replaced);
  }

  /**
   * The deployment's OAuth client for a server as it stands, or null if there is none to read.
   *
   * Decrypted, because both halves are needed: the id to build a consent URL and the secret to
   * redeem the code it comes back with. Held for the length of one request, like every other secret
   * this module reads.
   */
  async function storedOAuthClient(
    serverId: string,
  ): Promise<OAuthClient | null> {
    const [row] = await database
      .select({ credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    if (!row?.credentialId) return null;

    try {
      return JSON.parse(
        await decryptCredentialForUse(
          encryptionKey,
          credentials,
          row.credentialId,
        ),
      ) as OAuthClient;
    } catch {
      // A revoked, missing or unreadable client is the same as none for every caller: there is
      // nothing to send anybody to consent with, and the answer is to obtain one again.
      return null;
    }
  }

  /**
   * The vendor has disowned this deployment's client: fix the deployment, refuse the call.
   *
   * `invalid_client` is the vendor saying the CLIENT is the problem, and for a client the deployment
   * issued to itself there is nobody to tell — no console entry an administrator could re-create, so
   * every connection to that server would otherwise sit behind a refusal nothing here can act on.
   * Introducing itself again is the same act as the first registration, and it is worth doing: it is
   * what makes the next CONSENT possible.
   *
   * IT DOES NOT MAKE THIS CALL POSSIBLE. A refresh token is bound to the client it was issued to —
   * RFC 6749 §6 has the token endpoint verify exactly that, and §10.4 is why — so a conforming
   * vendor refuses a retry under the new client, and the only vendor it can work against is one
   * whose acceptance would itself be the vulnerability. So the grant is never carried across, and
   * the person is told the one thing that helps: connect again.
   *
   * The re-registration is still bounded by {@link CLIENT_REREGISTRATION_BACKOFF_MS}, and that bound
   * is the whole protection here rather than a nicety. This runs for any non-admin's tool call, and
   * it REPLACES the client every other connection in the deployment is bound to; a vendor that is
   * simply down answers every exchange `invalid_client`, so without the window one outage would have
   * each call in turn rotate the deployment-wide client. A client younger than the window is the
   * product of the last refusal's re-registration, and is left exactly alone.
   *
   * Always throws. The refusal it raises when it did register is the caller's answer; anything it
   * cannot act on is rethrown untouched, because the vendor's own words are better than ours.
   */
  async function refuseAndReplaceEvictedClient(input: {
    error: unknown;
    /** When the client that was just refused was stored. */
    clientRegisteredAt: Date | null;
    registrationUrl: string | undefined;
    serverId: string;
    /** What to tell the person once the deployment has registered itself again. */
    refusal: string;
  }): Promise<never> {
    const { error, registrationUrl, serverId } = input;
    /*
     * The code, off the error itself. Never the sentence: that is written for a person, and a
     * recovery that read it would be one rewording away from silently never running again.
     */
    const code = error instanceof TokenRefusedError ? error.code : null;
    const { redirectUri } = options;
    if (code !== INVALID_CLIENT || !registrationUrl || !redirectUri) {
      throw error;
    }

    const registeredAt = input.clientRegisteredAt;
    if (
      registeredAt &&
      Date.now() - registeredAt.getTime() < CLIENT_REREGISTRATION_BACKOFF_MS
    ) {
      throw error;
    }

    const fresh = await context.registerClient({
      registrationUrl,
      redirectUri,
    });
    // The vendor would not have us either. The first refusal is the one worth reporting: it says
    // what actually stopped the call, where this one says what stopped the recovery.
    if (!fresh) throw error;

    await persistOAuthClient({ serverId, client: fresh, by: "deployment" });
    throw new PluginRefusedError(input.refusal, null);
  }

  return {
    persistOAuthClient,
    storedOAuthClient,
    refuseAndReplaceEvictedClient,

    /**
     * The client to send somebody to the vendor with, registering one first if that is this
     * vendor's way of getting one.
     *
     * A dynamically registered client is not paperwork anybody did: there is no console entry to
     * paste, so "none yet" is the ordinary state of a server nobody has connected — and the answer
     * is for the deployment to introduce itself, which is what it would have to do eventually
     * anyway. Where an administrator registers by hand instead, and where the deployment has no
     * public URL to be sent back to, the answer stays null: inventing a client at a vendor that
     * never offered to issue one, or registering a redirect URI that resolves to nothing, would
     * both leave behind a client that can never complete a consent flow.
     *
     * ONE CLIENT PER DEPLOYMENT EVEN WHEN TWO PEOPLE ASK AT ONCE. This is `requireUser`'s handler,
     * so two first connects racing is the ordinary first hour of a connector. Registering twice is
     * not merely wasteful: the loser's consent screen names a client the vault no longer holds, so
     * that person consents and their callback then redeems the code against the client that
     * replaced it — a connect that fails after the vendor already said yes. So the registration
     * happens under {@link withOAuthClientLock}, with the "do we hold one" question asked AGAIN
     * inside it, and the second caller finds the first one's client and is handed the same one.
     *
     * The lock is held across the registration request to the vendor, deliberately. It is one round
     * trip with its own timeout, and a lock released before it would serialise nothing.
     */
    async ensureOAuthClient(
      serverId: string,
      by: string,
    ): Promise<OAuthClient | null> {
      const stored = await storedOAuthClient(serverId);
      if (stored) return stored;

      const { entry } = await servers().requireServer(serverId);
      if (
        entry?.auth.kind !== "user-oauth" ||
        entry.auth.clientRegistration !== "dynamic" ||
        !entry.auth.registrationUrl ||
        !options.redirectUri
      ) {
        return null;
      }
      // Held before the lock, because narrowing does not survive into the closure below.
      const { registrationUrl } = entry.auth;
      const { redirectUri } = options;

      const outcome = await withOAuthClientLock(
        serverId,
        async (transaction) => {
          /*
           * Asked again, under the lock. The read above was a fast path taken without one, and by
           * now the caller we were racing has committed a client of its own — which is the one this
           * deployment holds, so it is the one to consent against.
           */
          const held = await heldOAuthClient(transaction, serverId);
          if (held) return { client: held, registered: false, replaced: false };

          const registered = await context.registerClient({
            registrationUrl,
            redirectUri,
          });
          if (!registered) return null;

          const { replaced } = await writeOAuthClient(
            { serverId, client: registered },
            transaction,
          );
          return { client: registered, registered: true, replaced };
        },
      );

      if (!outcome) return null;
      // Only what this call actually did. A trail row for handing back somebody else's client
      // would claim a registration that never happened.
      if (outcome.registered) {
        await recordClientRegistered(
          { serverId, client: outcome.client, by },
          outcome.replaced,
        );
      }
      return outcome.client;
    },
  };
}

export type OAuthClients = ReturnType<typeof createOAuthClients>;
