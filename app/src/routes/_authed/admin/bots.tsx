import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Mascot } from "@/components/agents/mascot";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { updateAgentMutationOptions } from "@/lib/agents/mutations";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { t } from "@/lib/i18n";

/**
 * WHERE A BOT RUNS, WHICH IS AN OPERATOR'S QUESTION AND NOBODY ELSE'S.
 *
 * These two fields used to sit on every Bot's profile behind a 고급 disclosure, rendered whenever
 * the reader's role was `admin` — and on a one-VM-per-person deployment the shop owner IS the
 * administrator. So the person the product is written for opened a Bot to change what it does and
 * was offered an AG-UI endpoint and a bearer token, on a deployment where every Bot anybody makes
 * is `remote_ag_ui` on this server's own endpoint by construction (CLAUDE.md). There is no answer
 * for them to type.
 *
 * The capability is real and it stays, here, on a screen whose reader is an operator: pointing an
 * existing Bot at something somebody else hosts. `/admin` is behind a role check of its own, so
 * this is the only place the words 엔드포인트 and 토큰 are allowed to appear.
 */
export const Route = createFileRoute("/_authed/admin/bots")({
  component: RouteComponent,
});

/** What the server said when it tried the endpoint. */
type ConnectionVerdict =
  | { ok: true; events: string[] }
  | { ok: false; reason: string };

function RouteComponent() {
  const { data: agents, isPending } = useQuery(agentListQueryOptions());

  return (
    <PageShell
      description={t(
        "Point a Bot at an agent you host yourself. Left alone, every Bot runs on this deployment.",
      )}
      title={t("Bot endpoints")}
    >
      <PageSection title={t("Bots")}>
        {isPending ? (
          <p className="text-muted-foreground text-sm">{t("Loading Bots…")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {(agents ?? []).map((agent) => (
              <BotEndpoint agent={agent} key={agent.id} />
            ))}
          </div>
        )}
      </PageSection>
    </PageShell>
  );
}

function BotEndpoint({ agent }: { agent: AgentProfile }) {
  const queryClient = useQueryClient();
  const updateAgent = useMutation(updateAgentMutationOptions(queryClient));
  const [endpoint, setEndpoint] = useState(agent.endpoint ?? "");
  const [authValue, setAuthValue] = useState("");
  const [connection, setConnection] = useState<ConnectionVerdict | null>(null);
  const [testing, setTesting] = useState(false);

  /** Tested from the server, which is what runs will actually dial. */
  const testConnection = async () => {
    setTesting(true);
    setConnection(null);
    try {
      const response = await fetch("/api/agents/test-connection", {
        // The unsaved key is included so the test matches the pending form state.
        body: JSON.stringify({
          endpoint,
          ...(authValue.trim()
            ? { headers: { Authorization: authValue.trim() } }
            : {}),
        }),
        credentials: "include",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as
        | ConnectionVerdict
        | { error?: string }
        | null;
      setConnection(
        body && "ok" in body
          ? body
          : {
              ok: false,
              reason:
                (body as { error?: string } | null)?.error ??
                t("The connection could not be tested."),
            },
      );
    } catch {
      setConnection({
        ok: false,
        reason: t("The connection could not be tested."),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <details className="rounded-xl border border-border px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm marker:content-none">
        <span className="inline-flex size-7 shrink-0 overflow-hidden rounded-lg">
          <Mascot
            className="size-full object-cover"
            seed={agent.avatarSeed}
            size={28}
          />
        </span>
        <span className="truncate font-medium">{agent.name}</span>
        <span className="truncate text-muted-foreground text-xs">
          {agent.endpoint ?? t("Runs here")}
        </span>
      </summary>

      <div className="mt-3 flex flex-col gap-3">
        <Field>
          <FieldLabel htmlFor={`endpoint-${agent.id}`}>
            {t("Agent endpoint (optional)")}
          </FieldLabel>
          <div className="flex gap-2">
            <Input
              id={`endpoint-${agent.id}`}
              onChange={(event) => {
                setConnection(null);
                setEndpoint(event.target.value);
              }}
              placeholder="https://your-agent.example.com/ag-ui"
              value={endpoint}
            />
            <Button
              disabled={!endpoint || testing}
              onClick={() => void testConnection()}
              type="button"
              variant="outline"
            >
              {testing ? t("Testing…") : t("Test")}
            </Button>
          </div>
          {connection ? (
            <p
              className={`text-sm ${connection.ok ? "text-muted-foreground" : "text-destructive"}`}
              role="status"
            >
              {connection.ok
                ? t("It answered: {events}", {
                    events: connection.events.join(", "),
                  })
                : connection.reason}
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t(
                "Leave empty to use the built-in Bot. Anything that speaks AG-UI works. This server dials your agent, so an agent on your own machine has to be reachable from here.",
              )}
            </p>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor={`key-${agent.id}`}>
            {t("Key for that agent (optional)")}
          </FieldLabel>
          <Input
            autoComplete="off"
            id={`key-${agent.id}`}
            onChange={(event) => {
              // The verdict below was reached with the old key; it is not about this one.
              setConnection(null);
              setAuthValue(event.target.value);
            }}
            placeholder={
              agent.hasAuth
                ? t("A key is set. Type a new one to replace it.")
                : "Bearer …"
            }
            // Never repopulated; `hasAuth` says a key exists without exposing it.
            type="password"
            value={authValue}
          />
          <p className="text-muted-foreground text-sm">
            {/* "Authorization" is the literal HTTP header name — plumbing, never translated. */}
            {t(
              "Sent as an {header} header on every run, and kept in the credential vault. Leave empty to keep the current key.",
              { header: "Authorization" },
            )}
          </p>
        </Field>

        <div className="flex items-center gap-2">
          <Button
            disabled={updateAgent.isPending}
            onClick={async () => {
              await updateAgent.mutateAsync({
                agentId: agent.id,
                input: {
                  endpoint: endpoint.trim(),
                  name: agent.name,
                  roleDescription: agent.roleDescription,
                  title: agent.title,
                  visibility: agent.visibility,
                  ...(authValue.trim()
                    ? {
                        auth: {
                          header: "Authorization",
                          value: authValue.trim(),
                        },
                      }
                    : {}),
                },
              });
              setAuthValue("");
            }}
            size="sm"
          >
            {updateAgent.isPending ? t("Saving…") : t("Save")}
          </Button>
          {updateAgent.error ? (
            <p className="text-destructive text-sm" role="alert">
              {updateAgent.error.message}
            </p>
          ) : null}
        </div>
      </div>
    </details>
  );
}
