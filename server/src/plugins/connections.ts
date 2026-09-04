import { and, asc, eq } from "drizzle-orm";
import { recordAuditEvent } from "../audit";
import {
  CredentialUnavailableError,
  decryptCredentialForUse,
  decryptSecret,
  encryptSecret,
} from "../credentials";
import {
  credentials as credentialRows,
  mcpServers,
  mcpUserCredentials,
} from "../db/schema";
import {
  authEndpointsFor,
  type CatalogueEntry,
  catalogueEntry,
} from "./catalogue";
import { type OAuthClients, TOKEN_TIMEOUT_MS } from "./oauth-client";
import {
  iso,
  type OAuthClient,
  type PluginContext,
  PluginRefusedError,
  type StoredClient,
  type Transaction,
} from "./store";

/**
 * One person's own access to one vendor: the grant they consented to, and the token a call goes out
 * with.
 *
 * There is deliberately no fallback anywhere in here. A `user-oauth` server answers as the person
 * asking or it does not answer, because the alternative — assembling a confident answer out of
 * whatever the deployment, or the last person to connect, happened to be able to see — is
 * indistinguishable from a correct answer to everybody who reads it.
 */
export function createConnections(
  context: PluginContext,
  oauthClients: OAuthClients,
) {
  const { database, auditStore, credentials, encryptionKey } = context;

  /*
   * One exchange at a time per (server, person). A rotating vendor invalidates the refresh
   * token it was shown, so two concurrent calls that both present the old one would have the
   * second refused through no fault of anybody's. The chain serialises them; the map entry is
   * removed when the chain drains so the map cannot grow past the set of active connections.
   */
  const exchangeChains = new Map<string, Promise<unknown>>();
  function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = exchangeChains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    exchangeChains.set(key, next);
    /*
     * The refusal belongs to the caller, who is holding `next` and will see it. This branch exists
     * only to forget the key, so it swallows before it cleans up: `next.finally(…)` on its own
     * derives a SECOND rejected promise that nobody is holding, and a refused call — a withdrawn
     * credential, say — then surfaces as an unhandled rejection somewhere unrelated.
     */
    void next
      .catch(() => {})
      .finally(() => {
        if (exchangeChains.get(key) === next) exchangeChains.delete(key);
      });
    return next;
  }

  /**
   * A credential out of the vault, decrypted for one call and never held.
   *
   * A revoked credential is turned into a refusal rather than left as the vault's thrown error. The
   * two reach a person very differently: an error becomes "that tool could not be called", which is
   * what a vendor being down looks like, while a withdrawn grant is nobody's fault and has an
   * obvious next step. `onRevoked` says which of the two to name.
   *
   * WHICH of the two is decided on the vault's own error CLASS, never on the words in it. It used to
   * be `message.includes("revoked") || message.includes("not found")` against sentences written for
   * a person — the same read-the-prose pattern the store's note on `INVALID_CLIENT` records removing
   * for exactly this reason. Rewording `credentials.ts`, or translating it, would have turned every
   * withdrawn grant into "that tool could not be called" with every test still green.
   *
   * Everything else is rethrown untouched. A bad envelope or a key that will not decrypt is this
   * deployment being broken, and telling somebody to connect again would send them round a loop
   * that cannot end.
   */
  async function secretFor(
    credentialId: string,
    onRevoked: string,
  ): Promise<string> {
    try {
      return await decryptCredentialForUse(
        encryptionKey,
        credentials,
        credentialId,
      );
    } catch (error) {
      if (error instanceof CredentialUnavailableError) {
        throw new PluginRefusedError(onRevoked, null);
      }
      throw error;
    }
  }

  /**
   * Carry a connection over to the refresh token the vendor rotated to.
   *
   * In place, in the vault row the connection already points at — deliberately NOT the swap
   * {@link swapUserCredential} performs. A rotating vendor issues a new refresh token on every
   * exchange, so a swap here would mint a row and revoke a row per tool call, forever, on the
   * hottest path there is. And the revocation would have nothing to withdraw: the token just spent
   * was dead at the vendor the moment it answered, so the only live grant is the one being written.
   *
   * Deliberately WITHOUT the `mcp.account_connected` row, for the same reason as ever: rotation is
   * the vendor's plumbing, not a person's act, and a trail that records it as one reads as a
   * re-consent that nobody performed.
   *
   * The scope and the row are left alone. Nothing about what the vendor granted has changed — only
   * which token presents it.
   */
  async function rotateConnectionToken(
    input: {
      credentialId: string;
      refreshToken: string;
    },
    /**
     * The transaction the caller spent the token in, and this write belongs to it.
     *
     * The caller holds a `FOR UPDATE` lock on the very row being written. On its own pooled
     * connection this write would be a second session waiting for a lock only the caller can
     * release, and the caller cannot release it while awaiting this — so it would hang to the
     * statement timeout rather than rotate.
     */
    executor?: Transaction,
  ): Promise<void> {
    await credentials.updateSecret(
      input.credentialId,
      await encryptSecret(encryptionKey, input.refreshToken),
      executor,
    );
  }

  /**
   * The token one call goes out with, and whose it is.
   *
   * For a `deployment-bearer` server this is what it always was: the one credential an administrator
   * gave the server, used for everybody.
   *
   * For a `user-oauth` server it is the asker's own, and every branch that cannot prove it has the
   * asker's grant refuses. There is deliberately no fallback. A fallback is the one bug this design
   * exists to make impossible: answering out of whatever the deployment, or the last person to
   * connect, happened to be able to see — which returns a confident answer assembled from documents
   * the person asking cannot open, and looks exactly like a correct answer.
   *
   * Nothing is cached. The refresh token is exchanged for an access token per call and the access
   * token is thrown away, so there is no stored copy of anybody's access for a disconnect to have to
   * find. That costs a round trip to the vendor's token endpoint on every call, which is the price
   * of revocation being complete by construction rather than by cleanup.
   */
  async function connectionTokenFor(
    row: { id: string; url: string; credentialId: string | null },
    entry: CatalogueEntry | null,
    actorId: string,
  ): Promise<{ token?: string | undefined }> {
    if (entry?.auth.kind !== "user-oauth") {
      const token = row.credentialId
        ? await secretFor(
            row.credentialId,
            `${row.id} needs a credential this deployment no longer holds. An administrator has to add it again.`,
          )
        : undefined;
      return { token };
    }

    /*
     * The anonymous actor is the empty string, and an empty string must never match a row.
     *
     * Letting it reach the lookup would mean a run nobody can be held accountable for picking up
     * whichever grant sorted first, so it is refused before the query rather than trusted to miss.
     */
    if (!actorId) {
      throw new PluginRefusedError(
        `${row.id} answers as the person asking, and this run is not attributed to anybody.`,
        null,
      );
    }

    /*
     * Whether this person has connected at all, which is a refusal worth reaching before anything
     * queues behind another call. WHICH credential they hold is read again inside the critical
     * section below, because a reconnection can move it while this call waits its turn — and even
     * when the row stays put, the secret inside it does not.
     */
    const [held] = await database
      .select({ credentialId: mcpUserCredentials.credentialId })
      .from(mcpUserCredentials)
      .where(
        and(
          eq(mcpUserCredentials.serverId, row.id),
          eq(mcpUserCredentials.userId, actorId),
        ),
      )
      .limit(1);

    if (!held) {
      throw new PluginRefusedError(
        `You have not connected your ${entry.title} account. Connect it in Settings and ask again.`,
        null,
        "laf:not_connected",
      );
    }

    /*
     * The vendor's token endpoint, with a per-instance vendor's own host filled in.
     *
     * Read from the entry AND the stored row rather than from the entry alone: Cafe24 serves one
     * token endpoint per mall, so `entry.auth.tokenUrl` is a template and the address a refresh
     * token is actually sent to is the mall's. Null means the row does not name a host this entry
     * would be pointed at, which is a refusal — a refresh token must never be posted to an address
     * that failed the admissibility check.
     */
    const endpoints = authEndpointsFor(entry, row.url);
    if (!endpoints) {
      throw new PluginRefusedError(
        `${entry.title} is not at an address this deployment will send a credential to.`,
        null,
        "laf:vendor_address_unusable",
      );
    }
    // Held before the critical section, because narrowing does not survive into a closure and this
    // is where the entry is known to be a `user-oauth` one.
    const { tokenUrl } = endpoints;
    const { tokenAuth } = entry.auth;
    const { title } = entry;
    /**
     * The fleet's own application for this vendor, when the entry consents under one.
     *
     * Read before anything touches the vault, because for these entries the vault holds no client
     * at all: LAF registered the application once and every VM carries the same pair in its
     * environment. Absent here means the deployment was configured without it, and the vault path
     * below says so in the words of whoever can fix it.
     */
    const shared = entry.auth.sharedClient
      ? context.sharedClient(entry.auth.sharedClient)
      : null;
    /*
     * Where to register again, for a vendor that issues its own clients — and undefined for one an
     * administrator registered with by hand, where there is nothing this deployment could do about a
     * client the vendor no longer honours.
     */
    const registrationUrl =
      entry.auth.clientRegistration === "dynamic"
        ? entry.auth.registrationUrl
        : undefined;

    /*
     * What to tell the person when the deployment holds no client they can be called on, in the
     * words of whoever can actually change that.
     *
     * A hand-registered client is an administrator's paperwork — they pasted it in from the vendor's
     * console, and only they can paste one in again. A self-registered one is nobody's paperwork:
     * there is no console entry to re-create, and the deployment introduces itself again the next
     * time somebody connects. Naming an administrator there would send the person to somebody with
     * no step to take, which is worse than saying nothing.
     */
    const noClient = registrationUrl
      ? `${title} has no OAuth client for this deployment, so this cannot be called. Connect ${title} again in Settings: the deployment registers itself with the vendor when somebody connects.`
      : `${title} has no OAuth client registered for this deployment, so this cannot be called. An administrator has to add one.`;
    const unusableClient = registrationUrl
      ? `${title} has no usable OAuth client for this deployment. Connect ${title} again in Settings: the deployment registers itself with the vendor on the next connect.`
      : `${title} has no usable OAuth client for this deployment. An administrator has to add one again.`;
    /**
     * What to say when the vendor has forgotten the client this person's grant was issued under.
     *
     * The same register as the two above, and the same instruction, because it is the same situation
     * from the person's side: nothing they can be called on. What is different is that the
     * deployment CAN do its half — introduce itself again — and has, by the time this is thrown. So
     * the sentence says that too, otherwise "connect again" reads as a thing to keep trying.
     *
     * Their refresh token is not carried across. A grant belongs to the client it was issued to (RFC
     * 6749 §6, §10.4), so re-presenting it under the new client is a request a conforming vendor
     * refuses — and one that only ever appears to work against a vendor whose acceptance would
     * itself be the vulnerability. A new consent is the only thing that produces a usable grant.
     */
    const clientReplaced = `${title} no longer recognises this deployment's OAuth client, so this cannot be called. The deployment has registered itself again — connect ${title} again in Settings.`;

    if (!shared && !row.credentialId) {
      // The person did their part; the deployment has not. Refused before anything queues, because
      // a deployment holding no client has the same answer for everybody asking.
      throw new PluginRefusedError(noClient, null);
    }

    /**
     * The client as the deployment holds it right now, or the refusal for holding none.
     *
     * Read from the server row each time rather than from the row this call came in with: a retry
     * that registered again — this connection's own, a moment ago — replaced it, and the pointer
     * carried in from before the queue names the evicted one.
     */
    async function currentClient(): Promise<StoredClient> {
      /*
       * The fleet's application short-circuits the vault entirely.
       *
       * `registeredAt: null` is the honest answer and it matters downstream: the eviction recovery
       * measures its backoff against when this deployment last registered ITSELF, and it never
       * registered this one. A shared application that a vendor stops recognising is the fleet's to
       * fix in one console, not something a tool call should try to replace on its own.
       */
      if (shared) return { client: shared, registeredAt: null };

      /*
       * When the client was stored comes back with it, from the vault row itself rather than from a
       * column of our own. It is what the retry below measures its backoff against, and a left join
       * keeps it one query: a server pointing at nothing is the refusal on the next line, and a
       * pointer to a row that is no longer there is `secretFor`'s to refuse.
       */
      const [server] = await database
        .select({
          credentialId: mcpServers.credentialId,
          registeredAt: credentialRows.createdAt,
        })
        .from(mcpServers)
        .leftJoin(
          credentialRows,
          eq(credentialRows.id, mcpServers.credentialId),
        )
        .where(eq(mcpServers.id, row.id))
        .limit(1);
      if (!server?.credentialId) {
        throw new PluginRefusedError(noClient, null);
      }
      return {
        client: JSON.parse(
          await secretFor(server.credentialId, unusableClient),
        ) as OAuthClient,
        registeredAt: server.registeredAt,
      };
    }

    /*
     * The exchange, one call at a time for this connection, reading the connection fresh inside.
     *
     * Both halves of what goes out are read in here rather than carried in from above, because both
     * can move while this call waits its turn. The refresh token rotates, and the token read a
     * moment ago is then already spent — presenting it would be refused by the vendor for no reason
     * the person could act on. The client is replaced by a re-registration, and presenting the
     * evicted one would have every queued call discover that separately and register around it.
     *
     * TWO things serialise this, and they are not redundant. The map above queues calls made in THIS
     * process, which on this deployment model — one API process per VM, by decision — is every call
     * there is. The row lock below still matters: it also serialises against a person reconnecting
     * (`credentials.rotate` takes the same lock), and it keeps the invariant honest rather than
     * dependent on the process count staying one.
     *
     * An evicted client is handled AFTER the transaction rather than inside it. Nothing about
     * re-registering needs this person's lock — the client is per server — and doing it inside would
     * have a second pooled connection opened while this one holds a row lock, which is the shape the
     * pool note in `db/client.ts` is about.
     */
    return await serialized(`${row.id}:${actorId}`, async () => {
      /*
       * The client, read before the transaction opens rather than inside it.
       *
       * It is per SERVER and is not what the lock protects, and reading it here keeps the vault read
       * off a second pooled connection while this call holds one open for the whole exchange. Still
       * inside the critical section, so the ordering that matters is unchanged: a queued call reads
       * the client after whatever ran before it replaced it.
       */
      const stored = await currentClient();

      /*
       * The vault row, locked for as long as the token it holds is being spent.
       *
       * A rotating vendor kills the refresh token it was shown, so two writers that both read the
       * stored token and both present it do not merely race: the second presentation looks to the
       * vendor like a stolen token being replayed, and refresh-token-reuse detection answers it by
       * revoking the whole token family. The connection is then bricked, and nobody did anything
       * wrong. `SELECT … FOR UPDATE` is what makes the second writer wait for the first, exactly as
       * a person reconnecting already waits (`credentials.rotate`).
       *
       * Yes, the lock is held across an HTTP call to the vendor — bounded by the exchange's own
       * timeout. That is the point rather than an oversight: the lock IS the serialisation, and a
       * lock released before the exchange would serialise nothing.
       *
       * The read comes AFTER the lock, never before. A caller that woke from the lock and used a
       * token it had read on the way in would present the one the previous caller just spent, which
       * is the very double-spend this exists to prevent.
       */
      try {
        return await database.transaction(async (transaction) => {
          const [current] = await transaction
            .select({
              credentialId: mcpUserCredentials.credentialId,
              scope: mcpUserCredentials.scope,
            })
            .from(mcpUserCredentials)
            .where(
              and(
                eq(mcpUserCredentials.serverId, row.id),
                eq(mcpUserCredentials.userId, actorId),
              ),
            )
            .limit(1);

          // Disconnected while this call was queued. The same sentence as above: nothing is broken,
          // and connecting again is the thing to do.
          if (!current) {
            throw new PluginRefusedError(
              `You have not connected your ${title} account. Connect it in Settings and ask again.`,
              null,
              "laf:not_connected",
            );
          }

          const [locked] = await transaction
            .select({
              encryptedValue: credentialRows.encryptedValue,
              revokedAt: credentialRows.revokedAt,
            })
            .from(credentialRows)
            .where(eq(credentialRows.id, current.credentialId))
            .for("update");
          /*
           * A row that is gone or revoked, said the way `secretFor` says it: withdrawn access is
           * nobody's fault and connecting again is the step. Reached by a caller that waited here
           * while somebody disconnected, as well as by one that was told after the fact.
           */
          if (!locked || locked.revokedAt) {
            throw new PluginRefusedError(
              `Your ${title} access was withdrawn. Connect it again in Settings.`,
              null,
            );
          }
          const refreshToken = await decryptSecret(
            encryptionKey,
            locked.encryptedValue,
          );

          const minted = await context.exchangeRefreshToken({
            tokenUrl,
            client: stored.client,
            refreshToken,
            ...(tokenAuth ? { tokenAuth } : {}),
          });

          /*
           * A vendor that sent nothing back, or sent back the token we presented, rotated nothing —
           * and writing either would be inventing a rotation, at the cost of a needless
           * re-encryption of every connection on every call.
           */
          if (minted.refreshToken && minted.refreshToken !== refreshToken) {
            /*
             * The vendor rotated the grant: the token we were just shown is now the only valid one.
             * Persisting it is not optional bookkeeping — failing to would strand the connection on
             * the next call — so a failure here refuses THIS call rather than returning an access
             * token whose refresh token is already spent.
             *
             * In this transaction, so it commits with the lock that made the exchange ours: written
             * outside it, the next caller in line would wake to the token this one just spent.
             */
            await rotateConnectionToken(
              {
                credentialId: current.credentialId,
                refreshToken: minted.refreshToken,
              },
              transaction,
            );
          }

          return { token: minted.accessToken };
        });
      } catch (error) {
        /*
         * Outside the transaction, so the row lock is already released and the vault read this does
         * is not a second connection held behind this one's.
         *
         * Rethrows anything that is not the vendor disowning our client, which is every ordinary
         * failure: a withdrawn grant, a vendor being down, a disconnect mid-queue.
         */
        return await oauthClients.refuseAndReplaceEvictedClient({
          error,
          clientRegisteredAt: stored.registeredAt,
          registrationUrl,
          serverId: row.id,
          refusal: clientReplaced,
        });
      }
    });
  }

  /**
   * Point one person's connection at a new refresh token, revoking the one it replaces.
   *
   * For a person connecting, which is where a new row earns its keep: what they held before this is
   * still a live grant at the vendor, and the revocation is how it stops being one. A vendor's own
   * rotation is the other case entirely, and goes through {@link rotateConnectionToken}.
   *
   * Upserted on the pair, so it is the same act whether they are connecting or reconnecting. The
   * credential the row used to point at is revoked in the same breath: a refresh token nothing
   * points at is still a live grant at the vendor, and leaving it behind would mean somebody had two
   * valid grants and could only ever see one of them to withdraw it.
   *
   * Says whether it replaced something, which is the one fact the caller writing the trail needs
   * and cannot recover afterwards.
   *
   * ONE TRANSACTION, because these are two writes and one decision. The secret goes into the vault
   * and the connection row is pointed at it; separately, a failure between them leaves the pointer
   * naming the credential the rotation had just revoked — a connection that reads as live on the
   * settings page and refuses every call, with the person's actual grant retired and no way back to
   * it. `credentials.rotate` and `credentials.create` already accept the caller's executor for
   * exactly this, and the pointer write runs on the same one.
   */
  async function swapUserCredential(input: {
    serverId: string;
    userId: string;
    refreshToken: string;
    scope: string;
  }): Promise<{ replaced: boolean }> {
    const key = {
      kind: "mcp_user_token" as const,
      provider: input.serverId,
      keyId: input.userId,
    };
    const value = {
      ...key,
      metadata: { server: input.serverId, scope: input.scope },
      // Encrypted before the transaction opens: it is arithmetic, and it has no business happening
      // while a pooled connection is held open behind row locks.
      encryptedValue: await encryptSecret(encryptionKey, input.refreshToken),
    };

    return await database.transaction(async (transaction) => {
      /*
       * `credentials_active_key_idx` holds one live credential per key, so a second insert for the
       * same person and server would be refused. Asked of the key rather than of the connection row,
       * because the row can name a credential that has already been revoked while the key itself is
       * free, and it is the key the index constrains.
       */
      const live = await credentials.findLiveByKey(key, transaction);
      const stored = live
        ? await credentials.rotate(
            { ...value, previousCredentialId: live.id },
            transaction,
          )
        : await credentials.create(value, transaction);

      await transaction
        .insert(mcpUserCredentials)
        .values({
          serverId: input.serverId,
          userId: input.userId,
          credentialId: stored.id,
          scope: input.scope,
        })
        .onConflictDoUpdate({
          target: [mcpUserCredentials.serverId, mcpUserCredentials.userId],
          set: {
            credentialId: stored.id,
            scope: input.scope,
            updatedAt: new Date(),
          },
        });

      return { replaced: live !== null };
    });
  }

  return {
    connectionTokenFor,

    /**
     * Record that one person connected their own account to one server.
     *
     * The credential swap is {@link swapUserCredential}, and this is its only caller: a person
     * connecting or reconnecting is exactly when there is an older grant to revoke. Rotation writes
     * the same connection in place instead ({@link rotateConnectionToken}). What is only here is
     * the audit row: this one IS somebody's act, and the trail should say so.
     */
    async recordConnection(input: {
      serverId: string;
      userId: string;
      refreshToken: string;
      scope: string;
    }): Promise<void> {
      const { replaced } = await swapUserCredential(input);

      await recordAuditEvent(auditStore, {
        eventType: "mcp.account_connected",
        targetType: "mcp_server",
        targetId: input.serverId,
        payload: {
          actor: input.userId,
          server: input.serverId,
          // What the vendor granted, so a later refusal for want of a scope can be explained.
          scope: input.scope,
          reconnected: replaced,
        },
      });
    },

    /** Which `user-oauth` servers this person has connected, for their own settings page. */
    async connectionsFor(
      userId: string,
    ): Promise<{ serverId: string; scope: string; connectedAt: string }[]> {
      const rows = await database
        .select({
          serverId: mcpUserCredentials.serverId,
          scope: mcpUserCredentials.scope,
          connectedAt: mcpUserCredentials.connectedAt,
        })
        .from(mcpUserCredentials)
        .where(eq(mcpUserCredentials.userId, userId))
        .orderBy(asc(mcpUserCredentials.serverId));

      return rows.map((row) => ({
        serverId: row.serverId,
        scope: row.scope,
        connectedAt: iso(row.connectedAt) ?? "",
      }));
    },

    /**
     * One person disconnecting their own account from one server.
     *
     * The vault credential is revoked and the join row removed, so the settings page stops claiming
     * a connection this deployment can no longer use. Vendor-side revocation is attempted with the
     * refresh token BEFORE it is retired here, and best-effort: a vendor that will not answer does
     * not keep somebody's disconnect from taking effect at our side.
     */
    async disconnectAccount(input: {
      serverId: string;
      userId: string;
    }): Promise<{ disconnected: boolean }> {
      const [held] = await database
        .select({ credentialId: mcpUserCredentials.credentialId })
        .from(mcpUserCredentials)
        .where(
          and(
            eq(mcpUserCredentials.serverId, input.serverId),
            eq(mcpUserCredentials.userId, input.userId),
          ),
        )
        .limit(1);
      if (!held) return { disconnected: false };

      const entry = catalogueEntry(input.serverId);
      /*
       * The address a revocation is sent to, resolved the same way the refresh is: from the entry
       * AND the row, so a per-instance vendor's revoke endpoint is the mall's own. A row that names
       * no admissible host leaves `endpoints` null, and the local half below still runs — a
       * disconnect must never be held hostage by an address we would not post to anyway.
       */
      const [stored] = await database
        .select({ url: mcpServers.url })
        .from(mcpServers)
        .where(eq(mcpServers.id, input.serverId))
        .limit(1);
      const endpoints = entry
        ? authEndpointsFor(entry, stored?.url ?? null)
        : null;
      let vendorRevoked = false;
      if (entry?.auth.kind === "user-oauth" && endpoints) {
        /*
         * Read for one purpose and never returned: telling the vendor this grant is over. The
         * client goes with it because RFC 7009 lets a vendor demand client authentication, and a
         * public client's id alone satisfies the ones that do.
         */
        try {
          const refreshToken = await decryptCredentialForUse(
            encryptionKey,
            credentials,
            held.credentialId,
          );
          /*
           * The fleet's application first, because for these entries there is no vault client to
           * find and RFC 7009 lets a vendor demand the client on a revocation.
           */
          const client =
            (entry.auth.sharedClient
              ? context.sharedClient(entry.auth.sharedClient)
              : null) ?? (await oauthClients.storedOAuthClient(input.serverId));
          const params = new URLSearchParams({
            token: refreshToken,
            token_type_hint: "refresh_token",
          });
          if (client) {
            params.set("client_id", client.clientId);
            if (client.clientSecret) {
              params.set("client_secret", client.clientSecret);
            }
          }
          const response = await fetch(endpoints.revokeUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: params,
            redirect: "manual",
            signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
          });
          vendorRevoked = response.ok;
        } catch {
          // The vendor being unreachable must not hold somebody's disconnect hostage; the local
          // revocation below still makes the grant unusable BY US, and the trail says which half
          // happened.
        }
      }

      // Tolerant of a credential another path already retired: the join row is still the thing to
      // remove, and a second revoke refusing must not stop that.
      await credentials.revoke(held.credentialId).catch(() => {});
      await database
        .delete(mcpUserCredentials)
        .where(
          and(
            eq(mcpUserCredentials.serverId, input.serverId),
            eq(mcpUserCredentials.userId, input.userId),
          ),
        );

      await recordAuditEvent(auditStore, {
        eventType: "mcp.account_disconnected",
        targetType: "mcp_server",
        targetId: input.serverId,
        payload: {
          actor: input.userId,
          server: input.serverId,
          owner: input.userId,
          reason: "person_disconnected",
          vendorRevoked,
        },
      });
      return { disconnected: true };
    },

    /**
     * Retire every connector credential belonging to one person.
     *
     * "We removed their access" has to be true of the thing that matters, which is the refresh
     * token sitting in this deployment's vault. LOOKED UP IN THE VAULT, NOT THROUGH THE JOIN TABLE:
     * `mcp_user_credentials.user_id` cascades on a user row being deleted, so by the time somebody
     * is gone the join row can be gone too and the credential is orphaned — unrevoked, referenced
     * by nothing, reachable from no screen. `credentials.key_id` holds the user id for an
     * `mcp_user_token`, so the vault can still be asked directly.
     *
     * NOT vendor-side revocation. That needs the vendor's revoke endpoint per grant and belongs
     * with disconnect. This is the half that stops us holding the secret; the grant at the vendor
     * outlives it until somebody revokes it there. Said plainly rather than implied, because the
     * difference matters to whoever has to answer for it.
     */
    async retireConnectionsFor(
      userId: string,
      by: string,
    ): Promise<{ retired: number }> {
      if (!userId) return { retired: 0 };

      const owned = await database
        .select({
          id: credentialRows.id,
          provider: credentialRows.provider,
          revokedAt: credentialRows.revokedAt,
        })
        .from(credentialRows)
        .where(
          and(
            eq(credentialRows.kind, "mcp_user_token"),
            eq(credentialRows.keyId, userId),
          ),
        );

      let retired = 0;
      for (const credential of owned) {
        // Already revoked is not a failure. Retiring twice is something an administrator can
        // legitimately do, and the second time should be quiet rather than an error.
        if (credential.revokedAt) continue;
        await credentials.revoke(credential.id);
        retired += 1;
        await recordAuditEvent(auditStore, {
          eventType: "mcp.account_disconnected",
          targetType: "mcp_server",
          targetId: credential.provider,
          payload: {
            actor: by,
            server: credential.provider,
            owner: userId,
            reason: "person_removed",
            vendorRevoked: false,
          },
        });
      }

      await database
        .delete(mcpUserCredentials)
        .where(eq(mcpUserCredentials.userId, userId));

      return { retired };
    },
  };
}

export type Connections = ReturnType<typeof createConnections>;
