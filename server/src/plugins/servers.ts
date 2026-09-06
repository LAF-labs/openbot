import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { recordAuditEvent } from "../audit";
import {
  credentials as credentialRows,
  mcpServers,
  mcpTools,
} from "../db/schema";
import {
  type CatalogueEntry,
  catalogueEntry,
  classifyTool,
  hostAdmissible,
  resolvedCustomUrlRefusal,
  resolveServerUrl,
  serverCredentialKind,
} from "./catalogue";
import type { Connections } from "./connections";
import {
  classifyDeclaredTool,
  definitionHashOf,
  type ToolAnnotations,
} from "./laf-contract";
import { log } from "../log";
import { McpServerError } from "./mcp";
import { botsOwnedBy, type SkillsAndGrants } from "./skills-and-grants";
import {
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  iso,
  type PluginContext,
  type ServerRecord,
} from "./store";

/**
 * Which servers this deployment will talk to, and what each of them says it offers.
 *
 * Two ways in, and only one of them can be reviewed in advance: a curated entry names a vendor at a
 * pinned host, and a custom server is an address somebody typed. Everything in here that looks
 * defensive is about the second one.
 */

/**
 * Advertised tool names this deployment's write list does not name, where that list is the whole
 * barrier.
 *
 * WHY THIS IS WORTH A ROW. {@link classifyTool} reads an advertised name absent from `writeTools` as
 * a READ. So under-inclusion is the failure mode of that list, and it is silent: a write the vendor
 * offers and the entry forgot is offered to a model as a read, and nothing anywhere says so.
 * Notion's entry says reconciling its list against the live tool list "is required, not cosmetic" —
 * this is the mechanical half of that, so the reconciliation is somebody reading a trail rather than
 * somebody remembering.
 *
 * Only where the list stands alone. A vendor that expresses SCOPES has something behind the list: a
 * tool missing from Drive's `writeTools` still cannot write, because `drive.readonly` refuses it at
 * the vendor. Naming those would be noise in front of the one case that has no second barrier at
 * all — Notion, whose access is per-page on a consent screen and whose `scopes` are therefore empty.
 *
 * A server with no catalogue entry is not reconciled either, and for the opposite reason: nothing
 * reviewed says any tool of theirs only reads, so all of them are already writes.
 *
 * Sorted, so two readings of the same listing produce the same row.
 */
export function unlistedAdvertisedTools(
  entry: CatalogueEntry | null,
  advertised: readonly string[],
): string[] {
  if (!entry || entry.writeTools.length === 0) return [];
  if (entry.auth.kind !== "user-oauth" || entry.auth.scopes.length > 0) {
    return [];
  }
  const writes = new Set(entry.writeTools);
  return advertised.filter((name) => !writes.has(name)).sort();
}

/**
 * Where this server actually is, when the stored row and the catalogue disagree.
 *
 * `mcp_servers.url` is written once, when a server is added, by copying what the catalogue said at
 * the time. That makes it a cache of a reviewed decision — and a cache nothing invalidates. Moving
 * Google Drive from its preview MCP host to its GA REST host changed the catalogue and left every
 * deployment that had already added Drive calling the old address, with no way to tell from any
 * screen: the row looks exactly as intentional as it did the day it was written.
 *
 * So for an entry with a PINNED host, the catalogue wins. It is the reviewed source contract, and a
 * host it no longer names is a host this deployment has decided not to talk to. Editing the
 * catalogue is the act of changing where a first-party server is, and it should take effect.
 *
 * The stored value still wins for the two cases where it is the only truth: a custom server an
 * administrator added by URL, which has no entry at all, and a per-instance vendor whose `host` is
 * null because the customer's own hostname is the answer.
 */
export function effectiveUrl(
  row: { id: string; url: string },
  entry: CatalogueEntry | null,
): string {
  if (!entry || entry.host === null) return row.url;
  return resolveServerUrl(row.id)?.url ?? row.url;
}

export function createServers(
  context: PluginContext,
  connections: Connections,
  grants: SkillsAndGrants,
) {
  const { database, auditStore, credentials } = context;

  async function requireServer(serverId: string) {
    const [row] = await database
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    if (!row) throw new CatalogueEntryUnknownError(serverId);

    const entry = catalogueEntry(row.id);
    if (row.provenance === "first-party" && !entry) {
      // The row outlived its catalogue entry, which means a build removed a vendor while a
      // deployment still had it added. Refused rather than reached: the pinned host that made it
      // admissible no longer exists to check against, so there is nothing left that says this URL
      // is one we agreed to talk to.
      throw new CatalogueEntryUnknownError(row.id);
    }
    // Null for a custom server, and every caller handles that by assuming the worst about it.
    return { row, entry };
  }

  /**
   * The credential a server is being pointed at is of the kind that server can spend.
   *
   * Both add paths dereference the pointer before they return, so this is checked where the pointer
   * is accepted rather than where it is used. `mcp` is the only kind that answers "this server's own
   * token". A `mcp_user_token` is one person's grant and a `mcp_oauth_client` identifies the
   * deployment to a vendor; spending either here uses a credential on behalf of somebody who never
   * agreed to it.
   *
   * The shape is checked before the lookup because `credentials.id` is a `uuid` column, so a value
   * that is not one makes the query itself fail rather than return no rows, and the caller gets a
   * database error where a refusal belongs.
   *
   * One message for both "wrong kind" and "no such credential", deliberately. A caller who can tell
   * those apart can ask this endpoint which credential ids are real.
   */
  async function requireCredentialOfKind(
    serverTitle: string,
    serverId: string,
    credentialId: string,
    kind: "mcp" | null,
  ): Promise<void> {
    /*
     * A server that takes no credential when it is added is refused here rather than at the caller,
     * so that offering an id is one question with one answer wherever it is asked. The wording says
     * what is true of both kinds that reach it: a `user-oauth` server's client arrives through the
     * call that mints it, and a server needing no credential has nothing to be given.
     */
    if (!kind) {
      throw new CustomServerRefusedError(
        `${serverTitle} takes no credential when it is added.`,
      );
    }

    const looksLikeId =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        credentialId,
      );
    /*
     * Live, as well as the right kind and the right owner.
     *
     * A revoked credential cannot be decrypted, so attaching one only ever produced a server that
     * fails on its next call. Refusing it here says so at the moment somebody can still act on it,
     * and it closes the case where a token was retired precisely because it should stop being used.
     */
    const named = looksLikeId
      ? await database
          .select({
            kind: credentialRows.kind,
            provider: credentialRows.provider,
          })
          .from(credentialRows)
          .where(
            and(
              eq(credentialRows.id, credentialId),
              isNull(credentialRows.revokedAt),
            ),
          )
      : [];

    /*
     * Whose it is, as well as what it is.
     *
     * `provider` is the server a token was minted for. Without this, any `mcp` row in the vault
     * could be attached to any server, and since the call spends it against that server's address, a
     * token given to one vendor was deliverable to another. Reading a credential back is otherwise
     * impossible by design, so this closes the one field that accepts a reference to a secret rather
     * than the secret itself.
     */
    if (named[0]?.kind !== kind || named[0].provider !== serverId) {
      throw new CustomServerRefusedError(
        "That is not a credential this server can use. Add the server's own token instead.",
      );
    }
  }

  /**
   * Ask a server what it offers and replace what we hold.
   *
   * Replaced wholesale on the name level, never merged — a tool a vendor withdrew has to stop
   * being offered — while consent survives per tool: a definition whose hash changed is paused
   * for review rather than silently inheriting the old approval.
   *
   * `actorId` is who is asking, and whether it is needed at all is the transport's answer rather
   * than an assumption here. Where listing means asking a remote server — MCP — a `user-oauth`
   * vendor has no deployment credential to ask with, so the listing runs on the grant of whoever
   * pressed refresh, and an administrator who has not connected gets a refusal that lands in
   * `lastError`. That is the honest state: until somebody has connected, this deployment genuinely
   * does not know what that server offers.
   *
   * Where the tool list is this deployment's own code, nothing is asked and no credential is
   * consulted. Requiring one anyway is what made setting Drive up a round trip through an
   * administrator's personal settings page for a token that was then discarded.
   *
   * Absent for the refresh that happens right after a server is added, where nobody can have
   * connected yet. It makes no difference to a `deployment-bearer` server, which never consults
   * it.
   */
  async function refreshTools(
    serverId: string,
    actorId = "",
  ): Promise<{ tools: number; paused?: number }> {
    const { row, entry } = await requireServer(serverId);

    try {
      /*
       * The entry decides the protocol. For a custom server there is no entry, and MCP is right.
       *
       * Asked of the context rather than of the registry, because a partner entry's transport is
       * this repository's own code assembled by the process — see `store.ts`.
       */
      const transport = context.transportFor(entry);

      /*
       * A credential only when listing actually needs one.
       *
       * Where it is needed, it is taken from the same selection the call path uses rather than by
       * decrypting `row.credentialId` — which for a `user-oauth` server would send the
       * deployment's OAuth client secret to the vendor as somebody's access token. One answer to
       * "what token does this server get", and it cannot be a secret of the wrong kind.
       */
      const token = transport.listNeedsCredential
        ? (await connections.connectionTokenFor(row, entry, actorId)).token
        : undefined;

      const tools = await transport.listTools({
        url: effectiveUrl(row, entry),
        token,
      });

      /*
       * Consent-preserving sync, not delete-and-reinsert.
       *
       * The first sync is the registration a person is consenting to, so
       * everything lands approved. After that, a tool whose definition hash
       * changed — schema, description or annotations — is paused for review
       * instead of silently inheriting the old consent, and a tool that
       * appears later is a new capability nobody approved yet. A vanished
       * tool is simply removed; there is nothing to consent to.
       */
      const existing = await database
        .select()
        .from(mcpTools)
        .where(eq(mcpTools.serverId, serverId));
      const existingByName = new Map(existing.map((tool) => [tool.name, tool]));
      const firstSync = existing.length === 0 && row.toolsRefreshedAt === null;
      const fetchedNames = new Set(tools.map((tool) => tool.name));
      let paused = 0;

      for (const tool of tools) {
        const hash = await definitionHashOf({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        });
        const known = existingByName.get(tool.name);
        if (!known) {
          const needsReview = !firstSync;
          if (needsReview) {
            paused += 1;
          }
          await database.insert(mcpTools).values({
            serverId,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
            definitionHash: hash,
            needsReview,
            reviewReason: needsReview ? "appeared after registration" : null,
          });
          if (needsReview) {
            await recordAuditEvent(auditStore, {
              eventType: "mcp.tool_definition_changed",
              targetType: "mcp_tool",
              targetId: `${serverId}/${tool.name}`,
              payload: {
                server: serverId,
                tool: tool.name,
                change: "appeared",
              },
            });
          }
          continue;
        }
        if (known.definitionHash === hash && !known.needsReview) {
          continue;
        }
        const changed = known.definitionHash !== hash;
        if (changed) {
          paused += 1;
          await recordAuditEvent(auditStore, {
            eventType: "mcp.tool_definition_changed",
            targetType: "mcp_tool",
            targetId: `${serverId}/${tool.name}`,
            payload: {
              server: serverId,
              tool: tool.name,
              change: "definition",
            },
          });
        }
        await database
          .update(mcpTools)
          .set({
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
            definitionHash: hash,
            ...(changed
              ? { needsReview: true, reviewReason: "definition changed" }
              : {}),
          })
          .where(
            and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, tool.name)),
          );
      }

      for (const known of existing) {
        if (!fetchedNames.has(known.name)) {
          await database
            .delete(mcpTools)
            .where(
              and(
                eq(mcpTools.serverId, serverId),
                eq(mcpTools.name, known.name),
              ),
            );
        }
      }

      await database
        .update(mcpServers)
        .set({
          toolsRefreshedAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, serverId));

      /*
       * A grant left pointing at nothing goes in the trail, at the moment it starts pointing at
       * nothing.
       *
       * Reporting it on a screen answers "what is true now", which somebody has to go and look
       * at. This answers "when did it stop being offered, and what was holding it" — the question
       * asked after a transport is swapped back and a name starts resolving again. Without the
       * row, the only record of the gap is its absence.
       *
       * Not a refusal and not an error, so `configuration.changed` rather than a new event type:
       * nothing was denied and the refresh succeeded. Written after the tool list is replaced, so
       * what it names is what is actually left over.
       */
      const advertised = new Set(tools.map((tool) => tool.name));
      const stranded = [
        ...(await grants.mcpGrantsForServers([serverId])).entries(),
      ]
        .filter(([ref]) => !advertised.has(ref.slice(serverId.length + 1)))
        .sort(([left], [right]) => left.localeCompare(right));

      if (stranded.length > 0) {
        await recordAuditEvent(auditStore, {
          eventType: "configuration.changed",
          targetType: "mcp_server",
          targetId: serverId,
          payload: {
            actor: actorId,
            change: "grants_not_advertised",
            server: serverId,
            // The refs, because that is what a grant is keyed on and what an administrator
            // revokes.
            refs: stranded.map(([ref]) => ref),
            bots: [...new Set(stranded.flatMap(([, agents]) => agents))],
            note: "Held by a Bot and not offered to any model, because this server no longer advertises the tool. Offered again if it starts.",
          },
        });
      }

      /*
       * Tools the vendor advertises that this deployment's write list does not name.
       *
       * The mechanical half of the reconciliation Notion's catalogue entry says is required. See
       * {@link unlistedAdvertisedTools} for why only that shape of vendor is named here: an
       * advertised tool absent from `writeTools` classifies as a READ, so an under-inclusive list
       * is silent, and for a vendor with no scope strings there is nothing else standing behind
       * it.
       */
      const unlisted = unlistedAdvertisedTools(entry, [...advertised]);
      if (unlisted.length > 0) {
        await recordAuditEvent(auditStore, {
          eventType: "configuration.changed",
          targetType: "mcp_server",
          targetId: serverId,
          payload: {
            actor: actorId,
            change: "unlisted_tools_advertised",
            server: serverId,
            tools: unlisted,
            note: "Advertised by this server and not named in its reviewed write list, so each is offered to models as a read. This vendor has no read-only scope behind that list, so anything here that writes should be added to the entry.",
          },
        });
      }

      return { tools: tools.length, paused };
    } catch (error) {
      const message =
        error instanceof McpServerError || error instanceof Error
          ? error.message
          : String(error);
      // The failure is recorded rather than thrown away, because a server with no tools and no
      // explanation reads as a server that offers nothing, and an operator would go looking in
      // the wrong place. The tools already held are left alone: a vendor being briefly
      // unreachable is not a reason to revoke what Bots are using.
      await database
        .update(mcpServers)
        .set({
          /*
           * Capped at the same 400 characters `callTool` caps its recorded failure at. Parts of
           * this sentence come from a vendor, and it is drawn on the admin page — neither is a
           * promise about length.
           */
          lastError: message.slice(0, 400),
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, serverId));
      return { tools: 0 };
    }
  }

  async function listServers(): Promise<ServerRecord[]> {
    const rows = await database
      .select()
      .from(mcpServers)
      .orderBy(asc(mcpServers.title));
    if (rows.length === 0) return [];

    const tools = await database
      .select()
      .from(mcpTools)
      .where(
        inArray(
          mcpTools.serverId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(mcpTools.name));

    /*
     * Every grant on these servers, not only the ones matching a tool that is still advertised.
     * Asking about the advertised refs answers "who holds what is offered", which cannot report
     * the grants that are the point here — see `mcpGrantsForServers`.
     */
    const held = await grants.mcpGrantsForServers(rows.map((row) => row.id));
    const advertised = new Set(
      tools.map((tool) => `${tool.serverId}/${tool.name}`),
    );

    return rows.map((row) => {
      const entry = catalogueEntry(row.id);
      return {
        id: row.id,
        title: row.title,
        vendor: row.vendor,
        url: effectiveUrl(row, entry),
        summary: entry?.summary ?? "",
        docsUrl: entry?.docsUrl ?? "",
        provenance: row.provenance,
        hasCredential: row.credentialId !== null,
        toolsRefreshedAt: iso(row.toolsRefreshedAt),
        lastError: row.lastError,
        addedBy: row.addedBy,
        // A custom server has no entry and is reached with the one token the deployment holds.
        authKind: entry?.auth.kind ?? "deployment-bearer",
        dynamicClient:
          entry?.auth.kind === "user-oauth" &&
          entry.auth.clientRegistration === "dynamic",
        tools: tools
          .filter((tool) => tool.serverId === row.id)
          .map((tool) => {
            const ref = `${tool.serverId}/${tool.name}`;
            const declared =
              entry === null
                ? classifyDeclaredTool(tool.annotations as ToolAnnotations)
                : null;
            return {
              serverId: tool.serverId,
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema as Record<string, unknown>,
              ref,
              effect: declared
                ? declared.effect
                : classifyTool(entry, tool.name, true),
              grantedTo: held.get(ref) ?? [],
              needsReview: tool.needsReview,
              reviewReason: tool.reviewReason,
              guard:
                entry !== null
                  ? null
                  : declared
                    ? declared.guard
                    : "unannotated",
            };
          }),
        /*
         * Sorted by ref so the list is stable between reads, which matters because this is the
         * one place a discrepancy is reported and a reader comparing two visits should see the
         * same order.
         */
        withdrawn: [...held.entries()]
          .filter(
            ([ref]) => ref.startsWith(`${row.id}/`) && !advertised.has(ref),
          )
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([ref, agents]) => ({
            ref,
            name: ref.slice(row.id.length + 1),
            grantedTo: agents,
          })),
      };
    });
  }

  /**
   * The URL this deployment stored for a server, or null when it holds none.
   *
   * A read of one column rather than {@link requireServer}, because the callback that needs it has
   * nothing useful to do with a thrown error: every failure there ends the same way, back at the app
   * with nothing written.
   */
  async function storedServerUrl(serverId: string): Promise<string | null> {
    const [row] = await database
      .select({ url: mcpServers.url })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    return row?.url ?? null;
  }

  /*
   * Named rather than returned anonymously, because one of these calls another: the ensure below is
   * the add path with an existence check in front of it, and reaching it through `this` would break
   * the moment the store re-exported the method on its own (`store.ts` does exactly that).
   */
  const registry = {
    requireServer,
    requireCredentialOfKind,
    refreshTools,
    listServers,
    storedServerUrl,

    /**
     * A connection somebody just made, on every Bot they own.
     *
     * WHY A CONNECT GRANTS AT ALL — the same argument the partner connects already make, and it is
     * the deployment model's: one VM per person, and the person has just come back from a consent
     * screen that said what it was for. Sending them to find an admin page to switch on the tools
     * they connected a second ago is ceremony in front of a decision nobody makes. The `grant` rows
     * still name them and the moment.
     *
     * WHAT SHIPPED WITHOUT THIS. A partner connect granted (`partner-routes.ts`); the OAuth
     * callback did not, and the only thing that could refresh a `user-oauth` server's tool list was
     * `POST /servers/:id/refresh`, which is admin-only and called from the admin page. So a person
     * connected Google Sheets from Settings, the page said 연결됨, and every Bot they owned still
     * had nothing: the connection was real and reached nobody.
     *
     * THE REFRESH IS ON THIS PERSON'S GRANT, and has to be. Listing a `user-oauth` server's tools
     * means asking the vendor as somebody, and the person who just consented is the only somebody
     * this deployment has for it — which is also why this runs AFTER `recordConnection` rather than
     * beside it.
     *
     * GRANTING IS NOT PERMISSION TO ACT UNASKED. A guard floor is decided on the call
     * (`call.ts`/`laf-contract.ts`), not on the grant, so a tool the catalogue marks `destructive`,
     * `external` or `money` still stops and asks the first time a Bot reaches for it. This makes
     * the tool reachable; it does not make it quiet.
     *
     * NEVER FAILS THE CONNECT. By the time this runs the grant at the vendor exists and the vault
     * holds the refresh token. A vendor that will not list, or a grant row that would not write, is
     * recoverable by pressing 연결 again — and a throw here would tell somebody their account had
     * not been connected when it had.
     */
    async offerToolsTo(
      serverId: string,
      userId: string,
      by: string,
    ): Promise<void> {
      try {
        await refreshTools(serverId, userId);
        const advertised = await database
          .select({ name: mcpTools.name })
          .from(mcpTools)
          .where(eq(mcpTools.serverId, serverId));
        const bots = await botsOwnedBy(database, userId);
        for (const tool of advertised) {
          for (const botId of bots) {
            await grants.grant("mcp", `${serverId}/${tool.name}`, botId, by);
          }
        }
      } catch (error) {
        log.error("connection_tools_not_offered", {
          server: serverId,
          reason: error,
        });
      }
    },

    /**
     * The other direction: the grants back, from the Bots of the person who disconnected.
     *
     * THEIR BOTS ONLY, and never the server row. A `user-oauth` server is the deployment's — a
     * second person can be connected to it — so removing it here would take somebody else's
     * connector with it. That is the one difference from the partner disconnect, where the server
     * belongs to the single person the key was registered for.
     *
     * READ FROM THE GRANT TABLE, not from the advertised tool list. A tool the vendor has since
     * withdrawn still has a grant row, and a withdrawal that walked the live list would leave it
     * behind — drawn on the admin Plugins page as a discrepancy somebody should look into, which
     * would be a lie: the person pressed 연결 해제.
     *
     * NEVER FAILS THE DISCONNECT, for the mirror of the reason above: the credential is already
     * retired by the time this runs, and telling somebody their account is still connected when it
     * is not is the worse lie.
     */
    async withdrawToolsFrom(
      serverId: string,
      userId: string,
      by: string,
    ): Promise<void> {
      try {
        const bots = new Set(await botsOwnedBy(database, userId));
        if (bots.size === 0) return;
        const held = await grants.mcpGrantsForServers([serverId]);
        for (const [ref, agentIds] of held) {
          for (const agentId of agentIds) {
            if (!bots.has(agentId)) continue;
            await grants.revoke("mcp", ref, agentId, by);
          }
        }
      } catch (error) {
        log.error("connection_tools_not_withdrawn", {
          server: serverId,
          reason: error,
        });
      }
    },

    /**
     * Add a server from the catalogue.
     *
     * The URL is resolved from the catalogue rather than accepted from the caller, so the only thing
     * a person can influence is which entry and, for a per-instance vendor, their own instance
     * hostname, which is then checked against that vendor's anchored pattern before anything is
     * stored.
     */
    async addServer(input: {
      key: string;
      instanceHost?: string;
      credentialId?: string;
      by: string;
    }): Promise<ServerRecord> {
      const resolved = resolveServerUrl(input.key, input.instanceHost);
      if (!resolved) throw new CatalogueEntryUnknownError(input.key);

      /*
       * The pointer is checked here because the refresh that runs before this returns dereferences
       * whatever it names. What that reaches is narrower on this path, because the URL is the
       * catalogue's rather than the caller's — but a `user-oauth` entry must refuse a pasted id
       * outright: its client arrives through the call that mints it, never through this field.
       */
      const credentialId = input.credentialId?.trim() || undefined;
      if (credentialId) {
        await requireCredentialOfKind(
          resolved.entry.title,
          resolved.entry.key,
          credentialId,
          serverCredentialKind(resolved.entry),
        );
      }

      await database
        .insert(mcpServers)
        .values({
          id: resolved.entry.key,
          title: resolved.entry.title,
          vendor: resolved.entry.vendor,
          url: resolved.url,
          credentialId: credentialId ?? null,
          addedBy: input.by,
        })
        .onConflictDoUpdate({
          target: mcpServers.id,
          set: {
            url: resolved.url,
            /*
             * Left alone when the caller sends none, rather than cleared.
             *
             * `registerOAuthClient` keeps the client it minted in this column, and adding the server
             * again to change an instance host is not a statement about that client. Clearing it
             * orphaned the credential row, which nothing then revokes, and told everybody who had
             * connected that the deployment has no OAuth client registered.
             */
            ...(credentialId ? { credentialId } : {}),
            addedBy: input.by,
            updatedAt: new Date(),
          },
        });

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "mcp_server",
        targetId: resolved.entry.key,
        payload: {
          actor: input.by,
          change: "mcp_server_added",
          server: resolved.entry.key,
          url: resolved.url,
        },
      });

      // Refreshed immediately so the page that added it can show what it offers, and so a bad
      // credential is reported now rather than the first time a Bot tries to use it.
      await refreshTools(resolved.entry.key);
      const servers = await listServers();
      const added = servers.find((server) => server.id === resolved.entry.key);
      if (!added) throw new CatalogueEntryUnknownError(input.key);
      return added;
    },

    /**
     * The server row for a catalogue entry somebody is about to connect, created if it is missing.
     *
     * The gesture this exists for is one press of 연결 on a settings page. Everything that made
     * adding a server an administrator's decision — a URL somebody typed, a credential somebody
     * pasted — is absent here: the address comes from the reviewed entry, the application comes from
     * the fleet's own configuration, and the only thing a person supplies is a shop name that is
     * checked against the entry's anchored pattern before it is stored.
     *
     * Idempotent. A row already pointing at the same address is left exactly as it is, so pressing
     * 연결 again does not rewrite what a person has, and the tool listing is only paid for once.
     *
     * A per-instance vendor whose name CHANGED is repointed, and that is deliberate: somebody
     * correcting a mall id means the old one was wrong. Their existing grant belongs to the old
     * mall and stops working — which is what the consent they are in the middle of replaces.
     */
    async ensureCatalogueServer(input: {
      key: string;
      /** The customer's own name at a per-instance vendor. A Cafe24 mall id, not a secret. */
      instanceName?: string;
      by: string;
    }): Promise<{ url: string; added: boolean }> {
      const entry = catalogueEntry(input.key);
      if (!entry) throw new CatalogueEntryUnknownError(input.key);

      /*
       * The host, built from the entry's own template rather than from anything a caller sent whole.
       * Lower-cased because a hostname is, and because a person typing their shop's name will
       * capitalise it about half the time.
       */
      let instanceHost: string | undefined;
      if (entry.host === null) {
        const name = (input.instanceName ?? "").trim().toLowerCase();
        const template = entry.instanceHostTemplate;
        if (!name || !template) {
          throw new CustomServerRefusedError(
            `${entry.title} needs the name of the shop to connect to.`,
          );
        }
        instanceHost = template.replace("{name}", name);
        // Said here rather than left to `resolveServerUrl` returning null, which the caller would
        // report as "this deployment does not know that vendor" — true of nothing that happened.
        if (!hostAdmissible(entry, instanceHost)) {
          throw new CustomServerRefusedError(
            `'${name}' is not a name ${entry.title} gives a shop.`,
          );
        }
      }

      const resolved = resolveServerUrl(input.key, instanceHost);
      if (!resolved) throw new CatalogueEntryUnknownError(input.key);

      const [existing] = await database
        .select({ url: mcpServers.url })
        .from(mcpServers)
        .where(eq(mcpServers.id, input.key))
        .limit(1);
      if (existing?.url === resolved.url) {
        return { url: resolved.url, added: false };
      }

      await registry.addServer({
        key: input.key,
        ...(instanceHost ? { instanceHost } : {}),
        by: input.by,
      });
      return { url: resolved.url, added: true };
    },

    /**
     * Add a server that is not in the catalogue, by URL.
     *
     * The administrator's path is different from pressing Add on a curated entry. That
     * one picks a reviewed vendor at a pinned host; this one points the deployment at an address
     * somebody typed. Both are useful and only one of them can be reviewed in advance, so this one
     * is guarded at the URL, recorded with its provenance, and every tool it offers is treated as a
     * write because nothing here knows otherwise.
     */
    async addCustomServer(input: {
      id: string;
      title: string;
      url: string;
      credentialId?: string;
      by: string;
    }): Promise<ServerRecord> {
      /*
       * Resolved, not merely read. A name is not an address: `mcp.example.com` is an ordinary public
       * hostname right up until its A record says 10.0.0.5, and the static rules cannot see that.
       * This is the one call in the product that hands the deployment an arbitrary address to keep
       * and to send a credential to, so it is the one that pays for a DNS round trip.
       */
      const refusal = await resolvedCustomUrlRefusal(input.url);
      if (refusal) throw new CustomServerRefusedError(refusal);

      // A custom server may not take a curated entry's slug. The slug prefixes tool names and is
      // what a grant and a policy rule are written against, so allowing a shadow would let a custom
      // server inherit rules an operator wrote about the vendor.
      if (catalogueEntry(input.id)) {
        throw new CustomServerRefusedError(
          `${input.id} is the name of a server this deployment already knows. Choose another.`,
        );
      }
      if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(input.id)) {
        throw new CustomServerRefusedError(
          "A server name is lower-case letters, numbers and hyphens.",
        );
      }

      /*
       * A credential is spent at the address it was given to, or not spent.
       *
       * Adding a server that is already here rewrites its URL, and the refresh that follows sends
       * whatever credential it holds to the new one, in the same call. That is the same disclosure
       * as naming another server's token and it needs no trick at all: the token really does belong
       * to this server, and only the address moved. A check on whose credential it is cannot see it,
       * which is why this rule is here and not folded into that one.
       *
       * Refused rather than repaired, because the two harmless readings of the request are both
       * served by something else. Correcting a title or retrying an interrupted add sends the same
       * URL and is unaffected, and genuinely moving a server means the vendor is at a new address,
       * where the honest act is to remove it and add it again with the token that address is
       * supposed to hold.
       */
      const credentialId = input.credentialId?.trim() || undefined;
      const [existing] = await database
        .select({ url: mcpServers.url, credentialId: mcpServers.credentialId })
        .from(mcpServers)
        .where(eq(mcpServers.id, input.id));

      if (
        existing &&
        existing.url !== input.url &&
        (existing.credentialId || credentialId)
      ) {
        throw new CustomServerRefusedError(
          `${input.id} is already here at a different address and holds a credential. Remove it and add it again, with the token the new address is meant to have.`,
        );
      }

      if (credentialId) {
        // Always `mcp`: a server added by URL is reached with the one token the deployment holds
        // for it, whatever the vendor is, because nothing here knows the vendor.
        await requireCredentialOfKind(
          input.title,
          input.id,
          credentialId,
          "mcp",
        );
      }

      await database
        .insert(mcpServers)
        .values({
          id: input.id,
          title: input.title,
          vendor: new URL(input.url).hostname,
          url: input.url,
          provenance: "custom",
          credentialId: credentialId ?? null,
          addedBy: input.by,
        })
        .onConflictDoUpdate({
          target: mcpServers.id,
          set: {
            title: input.title,
            url: input.url,
            /*
             * Kept when the caller names none, rather than cleared, for a reason beyond tidiness.
             *
             * Clearing it left the credential live with nothing pointing at it, and `removeServer`
             * retires a token by reading it off the row: with the pointer gone it revoked nothing
             * and deleted the server, so the token outlived the server it was minted for. So the
             * pointer survives, `removeServer` finds it, and a removed server's token is dead
             * rather than loose.
             */
            ...(credentialId ? { credentialId } : {}),
            addedBy: input.by,
            updatedAt: new Date(),
          },
        });

      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "mcp_server",
        targetId: input.id,
        payload: {
          actor: input.by,
          change: "mcp_server_added",
          server: input.id,
          url: input.url,
          // Named in the trail, because "who added a server nobody reviewed" is a question somebody
          // will ask and the answer should not require reading the catalogue of a past build.
          provenance: "custom",
        },
      });

      await refreshTools(input.id);
      const added = (await listServers()).find(
        (server) => server.id === input.id,
      );
      if (!added) throw new CatalogueEntryUnknownError(input.id);
      return added;
    },

    /**
     * A person looked at the changed definition and consented to it as it now
     * is. The current hash becomes the consented one; nothing else moves.
     */
    async approveToolDefinition(
      serverId: string,
      toolName: string,
      by: string,
    ): Promise<boolean> {
      const updated = await database
        .update(mcpTools)
        .set({ needsReview: false, reviewReason: null })
        .where(
          and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)),
        )
        .returning({ name: mcpTools.name });
      if (updated.length === 0) {
        return false;
      }
      await recordAuditEvent(auditStore, {
        eventType: "mcp.tool_definition_approved",
        targetType: "mcp_tool",
        targetId: `${serverId}/${toolName}`,
        payload: { actor: by, server: serverId, tool: toolName },
      });
      return true;
    },

    /**
     * Remove a server, and stop every secret it was reached with being live.
     *
     * TWO KINDS OF SECRET, and both have to go. The server's own credential is whatever
     * `mcp_servers.credential_id` names — a `mcp` bearer token an administrator added, or, for a
     * `user-oauth` vendor, the deployment's OAuth client. Nothing else revokes it, so leaving it
     * behind means re-adding the same server meets its own abandoned row on
     * `credentials_active_key_idx`.
     *
     * The other kind is every PERSON'S grant for this server, keyed `mcp_user_token` on the server
     * id. `mcp_user_credentials` cascades on the server row, so removing the connector would
     * otherwise delete every pointer and leave every refresh token live and unreferenced: reachable
     * from no screen, revoked by no operation, and still a usable grant at the vendor. "We removed
     * the connector" has to be true of the thing that matters, which is the token sitting at the
     * vendor.
     *
     * Revoked rather than deleted, because the vault keeps revoked rows for audit.
     *
     * The revokes go first. These are writes on two tables and the store exposes no transaction
     * that spans both, so the order decides what a failure between them leaves: revoke-then-delete
     * leaves a server whose secrets no longer work and which removing again will finish off, while
     * delete-then-revoke leaves live secrets no server references and no operation can reach.
     */
    async removeServer(serverId: string, by: string): Promise<void> {
      const [existing] = await database
        .select({ credentialId: mcpServers.credentialId })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId));

      /*
       * Whether that credential is still live, read rather than inferred from a thrown error, so a
       * token a previous attempt already revoked, or one whose row is gone entirely, is skipped
       * while a database fault still propagates and leaves the server row in place to be removed
       * again.
       */
      const [live] = existing?.credentialId
        ? await database
            .select({ id: credentialRows.id })
            .from(credentialRows)
            .where(
              and(
                eq(credentialRows.id, existing.credentialId),
                isNull(credentialRows.revokedAt),
              ),
            )
        : [];

      /*
       * The pointer is dropped BEFORE the revoke, not after. `mcp_servers.credential_id` is a real
       * foreign key with `onDelete: restrict` in this fork, so the ordering constraint runs the
       * other way from upstream's text column: nothing may delete a credential row a server still
       * points at, and a revoke is fine — but the delete of the server below must not be the only
       * thing that releases the pointer, or a crash between revoke and delete leaves a server
       * pointing at a dead credential and refusing every screen. Cleared first, both later steps
       * are retryable.
       */
      if (existing?.credentialId) {
        await database
          .update(mcpServers)
          .set({ credentialId: null, updatedAt: new Date() })
          .where(eq(mcpServers.id, serverId));
      }

      if (live) {
        await credentials.revoke(live.id);
        await recordAuditEvent(auditStore, {
          eventType: "credential.revoked",
          targetType: "credential",
          targetId: live.id,
          payload: {
            actor: by,
            reason: "mcp_server_removed",
            server: serverId,
          },
        });
      }

      /*
       * Every person's grant for this server, read out of the VAULT rather than through the join
       * table.
       *
       * `credentials.provider` holds the server id for an `mcp_user_token`, so the vault can be
       * asked directly — which matters because the join row is the thing about to be cascaded away,
       * and a grant whose pointer has already gone (a person removed earlier) would otherwise be
       * invisible here too. The same argument `retireConnectionsFor` makes from the other direction.
       */
      const heldGrants = await database
        .select({ id: credentialRows.id, keyId: credentialRows.keyId })
        .from(credentialRows)
        .where(
          and(
            eq(credentialRows.kind, "mcp_user_token"),
            eq(credentialRows.provider, serverId),
            isNull(credentialRows.revokedAt),
          ),
        )
        .orderBy(asc(credentialRows.keyId));

      for (const grant of heldGrants) {
        await credentials.revoke(grant.id);
        await recordAuditEvent(auditStore, {
          eventType: "mcp.account_disconnected",
          targetType: "mcp_server",
          targetId: serverId,
          payload: {
            actor: by,
            server: serverId,
            // Whose it was. `key_id` holds the user id for this kind, and it is the only place left
            // to read it from once the join row has been cascaded away.
            owner: grant.keyId,
            /*
             * Not "they disconnected" and not "they were removed": an administrator took the whole
             * connector away, and the person did nothing. An auditor asking what happened to their
             * access should see which of the three this was.
             */
            reason: "mcp_server_removed",
            vendorRevoked: false,
          },
        });
      }

      await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "mcp_server",
        targetId: serverId,
        payload: { actor: by, change: "mcp_server_removed", server: serverId },
      });
    },
  };

  return registry;
}

export type Servers = ReturnType<typeof createServers>;
