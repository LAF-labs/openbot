import { IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { useCallback, useState } from "react";
import { z } from "zod";
import { LoadFailed, RowsSkeleton } from "@/components/admin/admin-states";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import {
  ConnectionStrip,
  ConnectOutcome,
} from "@/components/plugins/connections";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useBotNames } from "@/lib/agents/bot-names";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { t } from "@/lib/i18n";
import { catalogueSummaryKey } from "@/lib/plugins/catalogue-copy";
import {
  type CatalogueItem,
  type PluginServer,
  type PluginSkill,
  pluginKeys,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * Account-wide plugin and skill installation, with separate per-Bot grants.
 */

/**
 * Where a vendor's consent screen sends an administrator back to.
 *
 * `failed`, or the id of the server that was connected. `.catch({})` so an unrecognised value is
 * ignored rather than thrown out of validateSearch, which would take the whole page down over a
 * query string somebody pasted.
 */
const pluginsSearchSchema = z
  .object({ connected: z.string().optional() })
  .catch({});

export const Route = createFileRoute("/_authed/admin/plugins")({
  validateSearch: pluginsSearchSchema,
  component: PluginsPage,
});

function PluginsPage() {
  const queryClient = useQueryClient();
  const { data, isPending, isError, refetch } = useQuery(
    pluginsPageQueryOptions(),
  );
  const { data: agents } = useQuery(agentListQueryOptions());
  const nameFor = useBotNames();
  const { connected } = Route.useSearch();
  const navigate = Route.useNavigate();
  /*
   * Arriving back from a consent opens the tab the connection is on.
   *
   * The catalogue is the right first tab for somebody who came here to add something, and the wrong
   * one for somebody a vendor just sent back: the notice said "connected" while the screen showed
   * the Add list, and the connector they had just set up was one unmarked click away. Read from the
   * parameter as the INITIAL state rather than in an effect, so the first paint is already right.
   */
  const [tab, setTab] = useState<"catalogue" | "yours" | "skills">(
    connected && connected !== "failed" ? "yours" : "catalogue",
  );
  const [error, setError] = useState<string | null>(null);

  // Replaced rather than pushed: the URL a vendor sent somebody back to is not a step anybody
  // should be able to walk back into.
  const handleClearConnected = useCallback(() => {
    void navigate({
      replace: true,
      search: (previous) => ({ ...previous, connected: undefined }),
    });
  }, [navigate]);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: pluginKeys.all });

  /*
   * A DELETE THAT REPORTS SUCCESS ON A 403.
   *
   * The four revocations below handed a bare `fetch(...)` to `mutate.mutate(() => action())`, and
   * fetch resolves for every status a server can return. A refused grant revocation therefore ran
   * `onSuccess`, the list refetched, the grant was still there — and nothing said why. This is the
   * same shape as `post` below, which has always checked.
   */
  const del = async (path: string) => {
    setError(null);
    const response = await fetch(`/api/plugins${path}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(
        detail?.error ?? t("That did not go through. Try again."),
      );
    }
  };

  const post = async (path: string, body: unknown) => {
    setError(null);
    const response = await fetch(`/api/plugins${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(
        detail?.error ?? t("That did not go through. Try again."),
      );
    }
    return response.json();
  };

  /**
   * Store the token as a credential first; plugin server records keep only the credential id.
   */
  const storeToken = async (
    serverId: string,
    token?: string,
  ): Promise<string | undefined> => {
    if (!token?.trim()) return undefined;
    const response = await fetch("/api/admin/credentials", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "mcp",
        provider: serverId,
        keyId: `mcp-${serverId}`,
        plaintext: token.trim(),
        metadata: { server: serverId },
      }),
    });
    if (!response.ok) {
      throw new Error(t("The token could not be stored."));
    }
    return (await response.json())?.credential?.id;
  };

  const mutate = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSuccess: refresh,
    onError: (thrown: Error) => setError(thrown.message),
  });

  /*
   * Fired on the way back from a consent that worked. Not wrapped in `useCallback`: what makes it
   * run once is the latch inside `ConnectOutcome`, which has already recorded the outcome by the
   * time this identity could change — a memo here would be guarding something already guarded.
   */
  const handleConnected = (serverId: string) => {
    mutate.mutate(() =>
      post(`/servers/${encodeURIComponent(serverId)}/refresh`, {}),
    );
  };

  const bots = (agents ?? []).map((agent: { id: string }) => ({
    id: agent.id,
    name: nameFor(agent.id),
  }));

  return (
    <PageShell
      description={t(
        "What this deployment can reach, and which Bots may reach it. Adding is account-wide; enabling is per Bot.",
      )}
      title={t("Plugins")}
    >
      <PageSection>
        {/*
         * `aria-pressed`, not `role="tab"`. These do choose which panel is shown, which is what a
         * tablist is for — but that role promises arrow-key navigation and a roving tabindex, and
         * a screen reader announcing "tab 2 of 3" in front of controls that only answer to Tab
         * and Enter is a worse lie than no role at all. As toggle buttons they are exactly what
         * they are, and the chosen fill and the announced state finally come from one attribute.
         */}
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["catalogue", t("Catalogue")],
              ["yours", t("Yours")],
              ["skills", t("Skills")],
            ] as const
          ).map(([key, label]) => (
            <Button
              aria-pressed={tab === key}
              key={key}
              onClick={() => setTab(key)}
              size="sm"
              type="button"
              variant="outline"
            >
              {label}
            </Button>
          ))}
        </div>

        <ConnectOutcome
          connected={connected}
          onClear={handleClearConnected}
          /*
           * Ask the vendor what it offers, now that somebody can. Until this runs the connector
           * holds no tools, so there is nothing to grant to a Bot — the state a person lands in
           * straight after connecting, with no sign that one more press was needed.
           */
          onConnected={handleConnected}
          titleFor={(serverId) =>
            data?.servers.find((server) => server.id === serverId)?.title ??
            serverId
          }
        />

        {error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-6">
          {isPending ? (
            <RowsSkeleton height="h-16" />
          ) : isError || !data ? (
            <LoadFailed
              message={t("Plugins could not be loaded.")}
              onRetry={() => void refetch()}
            />
          ) : tab === "catalogue" ? (
            <Catalogue
              added={new Set(data.servers.map((server) => server.id))}
              items={data.catalogue}
              onAdd={(key, instanceHost, token) =>
                mutate.mutate(async () => {
                  const credentialId = await storeToken(key, token);
                  return post("/servers", { key, instanceHost, credentialId });
                })
              }
              onAddCustom={(input) =>
                mutate.mutate(async () => {
                  const credentialId = await storeToken(input.id, input.token);
                  return post("/servers/custom", { ...input, credentialId });
                })
              }
            />
          ) : tab === "yours" ? (
            <Yours
              bots={bots}
              onApproveDefinition={(serverId, toolName) =>
                mutate.mutate(async () => {
                  const response = await fetch(
                    `/api/plugins/servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolName)}/approve`,
                    { method: "POST", credentials: "include" },
                  );
                  if (!response.ok) {
                    throw new Error(t("The definition could not be approved."));
                  }
                })
              }
              onGrant={(ref, agentId, held) =>
                mutate.mutate(() =>
                  held
                    ? del(
                        `/grants?kind=mcp&ref=${encodeURIComponent(ref)}&agentId=${encodeURIComponent(agentId)}`,
                      )
                    : post("/grants", { kind: "mcp", ref, agentId }),
                )
              }
              onRefresh={(id) =>
                mutate.mutate(() => post(`/servers/${id}/refresh`, {}))
              }
              onRemove={(id) =>
                mutate.mutate(() => del(`/servers/${encodeURIComponent(id)}`))
              }
              servers={data.servers}
            />
          ) : (
            <Skills
              bots={bots}
              onGrant={(slug, agentId, held) =>
                mutate.mutate(() =>
                  held
                    ? del(
                        `/grants?kind=skill&ref=${encodeURIComponent(slug)}&agentId=${encodeURIComponent(agentId)}`,
                      )
                    : post("/grants", { kind: "skill", ref: slug, agentId }),
                )
              }
              // Admin-authored skills are deployment-global; personal skills are created elsewhere.
              onInstall={(input) =>
                mutate.mutate(() => post("/skills", { ...input, global: true }))
              }
              onUninstall={(slug) =>
                mutate.mutate(() => del(`/skills/${encodeURIComponent(slug)}`))
              }
              skills={data.skills}
            />
          )}
        </div>
      </PageSection>
    </PageShell>
  );
}

function Catalogue({
  items,
  added,
  onAdd,
  onAddCustom,
}: {
  items: CatalogueItem[];
  added: Set<string>;
  onAdd: (key: string, instanceHost?: string, token?: string) => void;
  onAddCustom: (input: {
    id: string;
    title: string;
    url: string;
    token?: string;
  }) => void;
}) {
  const [instanceHost, setInstanceHost] = useState<Record<string, string>>({});
  const [token, setToken] = useState<Record<string, string>>({});
  const [addingCustom, setAddingCustom] = useState(false);
  const [custom, setCustom] = useState({
    id: "",
    title: "",
    url: "",
    token: "",
  });

  return (
    <div className="space-y-6">
      {/*
       * ONE COLUMN, like every other list in the app. Two columns meant the eye had to choose a
       * side and then come back for the other, on a page whose whole job is "what can this
       * deployment reach" — a question answered by reading down a list once.
       */}
      <div className="flex flex-col gap-3">
        {items.map((item) => (
          <div
            className="rounded-lg border border-border bg-card p-4"
            key={item.key}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                {/* `t()` on the title for the same reason the 연결 rows call it on theirs: the
                    server sends the vendor's name as an English key and the dictionary already has
                    every one of them. Printed raw, the same eight services read "Google Drive" here
                    and 구글 드라이브 two screens away. */}
                <div className="font-medium">{t(item.title)}</div>
                {/* Through the copy table, because the API's summary is English facts: known
                    entries get this surface's Korean, an unknown one falls back visibly. The
                    walking test in plugin-catalogue-copy.test.ts is what keeps the table honest. */}
                <p className="text-sm text-muted-foreground">
                  {t(catalogueSummaryKey(item.key, item.summary))}
                </p>
              </div>
              <Button
                className="shrink-0"
                disabled={added.has(item.key)}
                onClick={() =>
                  onAdd(
                    item.key,
                    instanceHost[item.key] || undefined,
                    token[item.key] || undefined,
                  )
                }
                size="sm"
                type="button"
                variant="outline"
              >
                {added.has(item.key) ? t("Added") : t("Add")}
              </Button>
            </div>
            {item.perInstance ? (
              <Input
                aria-label={t("Address for {name}", { name: t(item.title) })}
                className="mt-2"
                onChange={(event) =>
                  setInstanceHost((current) => ({
                    ...current,
                    [item.key]: event.target.value,
                  }))
                }
                /*
                 * The only per-instance entry this deployment ships is 카페24, and this field
                 * showed a ServiceNow instance URL — a vendor nothing here has ever connected to,
                 * as the worked example for the one that everything here does.
                 *
                 * `cafe24api.com`, not the storefront's `cafe24.com`: the catalogue's `hostPattern`
                 * is anchored on the API host, so an example shaped like the shop's own address
                 * would teach the one form the server refuses.
                 */
                placeholder="https://myshop.cafe24api.com"
                value={instanceHost[item.key] ?? ""}
              />
            ) : null}
            {/*
             * A token field only where a token is what reaches the server. A `user-oauth` entry is
             * answered with each person's own grant, so there is nothing an administrator could
             * type here — the connecting happens per person, on the Yours tab or in Settings, after
             * this button has done its one job of adding the server.
             */}
            {item.auth === "deployment-bearer" ? (
              /* Mask tokens before they are stored in the credential vault. */
              <Input
                aria-label={t("Access token for {name}", {
                  name: t(item.title),
                })}
                className="mt-2"
                onChange={(event) =>
                  setToken((current) => ({
                    ...current,
                    [item.key]: event.target.value,
                  }))
                }
                placeholder={t("Access token for this server")}
                type="password"
                value={token[item.key] ?? ""}
              />
            ) : null}
            <a
              className="mt-2 inline-block text-xs text-muted-foreground underline"
              href={item.docsUrl}
              rel="noreferrer"
              target="_blank"
            >
              {t("Vendor documentation")}
            </a>
          </div>
        ))}
      </div>

      <div className="flex justify-start">
        <Button onClick={() => setAddingCustom(true)} size="sm" variant="ghost">
          <IconPlus />
          {t("Add a server by URL")}
        </Button>
      </div>

      <Dialog onOpenChange={setAddingCustom} open={addingCustom}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Add a server by URL")}</DialogTitle>
            <DialogDescription>
              {t(
                "For a server that is not in the catalogue. Nobody has reviewed it, so every tool it offers is treated as one that changes something, and the server is recorded as custom wherever it appears.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="custom-id">{t("Name")}</FieldLabel>
                <Input
                  id="custom-id"
                  onChange={(event) =>
                    setCustom((current) => ({
                      ...current,
                      id: event.target.value,
                    }))
                  }
                  placeholder="name (lower-case)"
                  value={custom.id}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="custom-title">{t("Title")}</FieldLabel>
                <Input
                  id="custom-title"
                  onChange={(event) =>
                    setCustom((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                  placeholder={t("Title")}
                  value={custom.title}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="custom-url">{t("URL")}</FieldLabel>
                <Input
                  id="custom-url"
                  onChange={(event) =>
                    setCustom((current) => ({
                      ...current,
                      url: event.target.value,
                    }))
                  }
                  placeholder="https://mcp.example.com/mcp"
                  value={custom.url}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="custom-token">
                  {t("Access token, if it needs one")}
                </FieldLabel>
                <Input
                  id="custom-token"
                  onChange={(event) =>
                    setCustom((current) => ({
                      ...current,
                      token: event.target.value,
                    }))
                  }
                  type="password"
                  value={custom.token}
                />
              </Field>
            </FieldGroup>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setAddingCustom(false)}
              size="sm"
              variant="ghost"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={!(custom.id && custom.title && custom.url)}
              onClick={() => {
                onAddCustom(custom);
                setCustom({ id: "", title: "", url: "", token: "" });
                setAddingCustom(false);
              }}
              size="sm"
            >
              {t("Add server")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Plugin server summary shown in the admin grant table. */
function Yours({
  servers,
  bots,
  onGrant,
  onRefresh,
  onRemove,
  onApproveDefinition,
}: {
  servers: PluginServer[];
  bots: { id: string; name: string }[];
  onGrant: (ref: string, agentId: string, held: boolean) => void;
  onRefresh: (id: string) => void;
  onRemove: (id: string) => void;
  onApproveDefinition: (serverId: string, toolName: string) => void;
}) {
  if (servers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("No servers added yet. The Catalogue tab is where they come from.")}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {servers.map((server) => (
        <div
          className="rounded-lg border border-border bg-card"
          key={server.id}
        >
          <div className="flex items-start justify-between gap-3 border-border border-b px-4 py-3">
            <div>
              <div className="flex items-center gap-2 font-medium">
                {t(server.title)}
                {server.provenance === "custom" ? (
                  <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning">
                    {/* One word, so the bare-English walk cannot see it: it counts two Latin words
                        as a sentence, and this badge is the only thing on the row that says nobody
                        reviewed the server. */}
                    {t("Custom")}
                  </span>
                ) : null}
              </div>
              {/*
               * `break-all`: `body { word-break: keep-all }` makes a URL one unbreakable token, so
               * a long server address widened the row past the page and dragged the whole admin
               * document into horizontal scroll.
               */}
              <div className="break-all font-mono text-muted-foreground text-xs">
                {server.url}
              </div>
              {/*
               * Before anybody has connected, a `user-oauth` server's `lastError` can only ever be
               * the refusal its own listing produces — no token is sent before a connection exists,
               * so no other failure can have happened. Showing that English refusal on every fresh
               * add read as something broken; this surface owns the words, and in exactly that
               * state the honest sentence is an invitation. Once tools have listed at least once,
               * an error is a real vendor failure again and is shown as the server said it.
               */}
              {server.authKind === "user-oauth" &&
              server.toolsRefreshedAt === null ? (
                <div className="mt-1 text-muted-foreground text-xs">
                  {t(
                    "Connect your account below, and this server's tools load with it.",
                  )}
                </div>
              ) : server.lastError ? (
                <div className="mt-1 text-xs text-destructive">
                  {server.lastError}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                onClick={() => onRefresh(server.id)}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("Refresh tools")}
              </Button>
              <Button
                onClick={() => onRemove(server.id)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("Remove")}
              </Button>
            </div>
          </div>

          {/*
           * WHOSE ACCOUNT, ON THE PAGE THAT ADDED THE SERVER. Adding one of these reaches nothing
           * on its own: a `user-oauth` server is answered with the asker's own grant, so until a
           * person consents for themselves every tool below refuses. An administrator seeing the
           * server here and no way to connect it would read that as broken.
           */}
          {server.authKind === "user-oauth" ? (
            <div className="border-border border-b px-4 py-3">
              <ConnectionStrip
                canRegisterClient
                dynamicClient={server.dynamicClient}
                hasCredential={server.hasCredential}
                returnTo="admin"
                serverId={server.id}
              />
            </div>
          ) : null}

          {/*
           * A grant pointing at a tool this server stopped offering. Two honest readings — the
           * vendor withdrew it, or a transport swap renamed it — and both belong to whoever is
           * looking at this page, so it is said out loud rather than quietly dropped from the list.
           */}
          {server.withdrawn.length > 0 ? (
            <div className="border-border border-b bg-warning/10 px-4 py-3">
              <p className="text-warning text-xs">
                {t(
                  "These tools are still granted to Bots, but this server no longer offers them:",
                )}
              </p>
              <p className="mt-1 break-all font-mono text-warning text-xs">
                {server.withdrawn.map((grant) => grant.name).join(", ")}
              </p>
            </div>
          ) : null}

          {/*
           * A ROW PER TOOL, NOT A GRID OF TOOLS AGAINST BOTS. The matrix put one checkbox column per
           * Bot, so it grew a column every time somebody made a Bot and was already scrolling
           * sideways at four of them — and sideways is where a grant quietly goes unread. The
           * toggles wrap under the tool they belong to instead, which is how grants are shown
           * everywhere else in the app.
           */}
          {server.tools.length === 0 ? (
            <p className="px-4 py-3 text-muted-foreground text-sm">
              {t("No tools listed. Refresh to ask the server again.")}
            </p>
          ) : (
            <div className="divide-y divide-border">
              {server.tools.map((tool) => (
                <div className="px-4 py-3" key={tool.ref}>
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-xs">{tool.name}</span>
                    <span
                      className={
                        tool.effect === "write"
                          ? "text-warning text-xs dark:text-warning"
                          : "text-muted-foreground text-xs"
                      }
                    >
                      {tool.effect === "write"
                        ? t("changes things")
                        : t("reads")}
                    </span>
                    {tool.guard ? (
                      <span className="text-muted-foreground text-xs">
                        {t("asks a person every time")}
                      </span>
                    ) : null}
                  </div>
                  {tool.needsReview ? (
                    /*
                     * The pause the consent pin creates, made visible where it
                     * ends. The tool refuses to run until this button is
                     * pressed, so hiding the state would read as a broken tool
                     * rather than a working boundary.
                     */
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-warning text-xs dark:text-warning">
                        {tool.reviewReason === "appeared after registration"
                          ? t("New since registration — paused until reviewed")
                          : t("Definition changed — paused until reviewed")}
                      </span>
                      <Button
                        onClick={() =>
                          onApproveDefinition(server.id, tool.name)
                        }
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {t("Approve as it now is")}
                      </Button>
                    </div>
                  ) : null}
                  <p className="mt-0.5 text-muted-foreground text-xs">
                    {tool.description}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {bots.map((bot) => {
                      const held = tool.grantedTo.includes(bot.id);
                      return (
                        <Button
                          key={bot.id}
                          onClick={() => onGrant(tool.ref, bot.id, held)}
                          size="sm"
                          type="button"
                          // The grant is conveyed by fill alone otherwise; the role needs the state.
                          aria-pressed={held}
                          variant="outline"
                        >
                          {bot.name}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Packaged `/` instructions installed at deployment scope and granted per Bot. */
function Skills({
  skills,
  bots,
  onInstall,
  onUninstall,
  onGrant,
}: {
  skills: PluginSkill[];
  bots: { id: string; name: string }[];
  onInstall: (input: {
    slug: string;
    title: string;
    summary: string;
    instructions: string;
  }) => void;
  onUninstall: (slug: string) => void;
  onGrant: (slug: string, agentId: string, held: boolean) => void;
}) {
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState({
    slug: "",
    title: "",
    summary: "",
    instructions: "",
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-start">
        <Button onClick={() => setWriting(true)} size="sm" variant="ghost">
          <IconPlus />
          {t("Write a skill")}
        </Button>
      </div>

      <Dialog onOpenChange={setWriting} open={writing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Write a skill for the deployment")}</DialogTitle>
            <DialogDescription>
              {t(
                "The slug is what a person types after a slash, and the instructions are added to the run when they do. Everybody here can use it, and you decide which Bots have it. People write their own on the Skills page.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="skill-slug">{t("Slug")}</FieldLabel>
                <Input
                  id="skill-slug"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      slug: event.target.value,
                    }))
                  }
                  placeholder="standup-notes"
                  value={draft.slug}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="skill-title">{t("Title")}</FieldLabel>
                <Input
                  id="skill-title"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                  placeholder={t("Title")}
                  value={draft.title}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="skill-summary">{t("Summary")}</FieldLabel>
                <Input
                  id="skill-summary"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      summary: event.target.value,
                    }))
                  }
                  placeholder={t("One line")}
                  value={draft.summary}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="skill-instructions">
                  {t("Instructions")}
                </FieldLabel>
                <Textarea
                  className="h-28 font-mono text-sm"
                  id="skill-instructions"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      instructions: event.target.value,
                    }))
                  }
                  placeholder={t(
                    "What the Bot should do when this skill is used.",
                  )}
                  value={draft.instructions}
                />
              </Field>
            </FieldGroup>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setWriting(false)} size="sm" variant="ghost">
              {t("Cancel")}
            </Button>
            <Button
              disabled={!(draft.slug && draft.title && draft.instructions)}
              onClick={() => {
                onInstall(draft);
                setDraft({
                  slug: "",
                  title: "",
                  summary: "",
                  instructions: "",
                });
                setWriting(false);
              }}
              size="sm"
            >
              {t("Install skill")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {skills.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("No skills installed yet.")}
        </p>
      ) : (
        /* Rows, for the same reason the tool grants are rows: a column per Bot does not scale. */
        <div className="rounded-lg border border-border bg-card">
          {skills.map((skill, index) => (
            <React.Fragment key={skill.slug}>
              <div className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <code className="font-mono text-foreground/80 text-xs">
                      /{skill.slug}
                    </code>
                    <span className="font-medium text-sm">{skill.title}</span>
                    {skill.ownerUserId ? (
                      <span className="rounded-md bg-foreground/5 px-1.5 py-0.5 font-medium text-muted-foreground text-xs">
                        {skill.installedBy ?? "somebody"}
                      </span>
                    ) : null}
                  </div>
                  <Button
                    onClick={() => onUninstall(skill.slug)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {t("Remove")}
                  </Button>
                </div>
                {skill.summary ? (
                  <p className="mt-0.5 text-muted-foreground text-xs">
                    {skill.summary}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  {bots.map((bot) => {
                    const held = skill.grantedTo.includes(bot.id);
                    return (
                      <Button
                        key={bot.id}
                        onClick={() => onGrant(skill.slug, bot.id, held)}
                        size="sm"
                        type="button"
                        // The grant is conveyed by fill alone otherwise; the role needs the state.
                        aria-pressed={held}
                        variant="outline"
                      >
                        {bot.name}
                      </Button>
                    );
                  })}
                </div>
              </div>
              {index !== skills.length - 1 && <Separator />}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
