import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { LoadFailed, RowsSkeleton } from "@/components/admin/admin-states";
import { Mascot } from "@/components/agents/mascot";
import { LiveRegion } from "@/components/layout/live-region";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { updateAgentMutationOptions } from "@/lib/agents/mutations";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { ensure } from "@/lib/ensure";
import { t } from "@/lib/i18n";
import { refusalText } from "@/lib/refusals";

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

/**
 * Try an endpoint from the server, which is what runs will actually dial. Never throws: a request
 * that went nowhere is a verdict too. Out here because it holds the `try`, and a component that
 * holds one with a conditional in it is left uncompiled.
 */
async function testEndpoint(
  endpoint: string,
  authValue: string,
): Promise<ConnectionVerdict> {
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
      | { code?: string }
      | null;
    return body && "ok" in body
      ? body
      : {
          ok: false,
          // A refusal, not a verdict: its code, never `error` — which is the code itself.
          reason: refusalText(
            {},
            (body as { code?: string } | null)?.code,
            t("The connection could not be tested."),
          ),
        };
  } catch {
    return { ok: false, reason: t("The connection could not be tested.") };
  }
}

function RouteComponent() {
  const agents = useQuery(agentListQueryOptions());
  const bots = agents.data ?? [];

  return (
    <PageShell
      description={t(
        "Point a Bot at an agent you host yourself. Left alone, every Bot runs on this deployment.",
      )}
      title={t("Bot endpoints")}
    >
      <PageSection title={t("Bots")}>
        {/*
         * THREE ANSWERS, WHERE THERE WAS ONE AND A BLANK. The list drew "Loading Bots…" and then
         * whatever `data` held — so a read that FAILED and a deployment with no Bots on it both
         * rendered a heading over an empty div, with `isError` sitting in the query unread. An
         * operator arriving on this page to fix a Bot's endpoint was shown nothing, twice, for two
         * unrelated reasons.
         */}
        {agents.isPending ? (
          <RowsSkeleton height="h-11" />
        ) : agents.isError ? (
          <LoadFailed
            message={t("The Bots could not be loaded.")}
            onRetry={() => void agents.refetch()}
          />
        ) : bots.length === 0 ? (
          <PageEmpty>
            {t(
              "No Bots yet. Make one in the app, and it will be listed here with the endpoint it answers on.",
            )}
          </PageEmpty>
        ) : (
          <div className="flex flex-col gap-2">
            {bots.map((agent) => (
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
    // `try`…`catch`…`finally`: the `try`…`catch` in `testEndpoint`, which never throws, and the
    // `finally` through `ensure` — the React Compiler cannot compile the statement in a component.
    await ensure(
      async () => setConnection(await testEndpoint(endpoint, authValue)),
      () => setTesting(false),
    );
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
          {/*
           * Mounted before 테스트 is pressed (`LiveRegion`): drawn only once the answer came, the
           * result arrived with its region and was not read out. A refusal is an alert.
           */}
          <LiveRegion as="p" className="text-muted-foreground text-sm">
            {connection?.ok
              ? t("It answered: {events}", {
                  events: connection.events.join(", "),
                })
              : null}
          </LiveRegion>
          <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
            {connection && !connection.ok ? connection.reason : null}
          </LiveRegion>
          {connection ? null : (
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
