import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { LoadFailed } from "@/components/admin/admin-states";
import { LiveRegion } from "@/components/layout/live-region";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  COMPONENT_ADMIN_REFUSALS,
  type ComponentRecord,
  componentKeys,
  componentListQueryOptions,
  dataFunctionDescriptionKey,
  dataFunctionReadsKey,
  type DataFunctionSummary,
  dataFunctionsQueryOptions,
} from "@/lib/components/queries";
import { RENDERABLE_NAMES } from "@/lib/copilot/gallery-registry";
import { activeLocale, t } from "@/lib/i18n";
import { usePress } from "@/lib/press";
import { refusalFrom } from "@/lib/refusals";

/** A refused change, as the line this page draws: which refusal, or the page's own sentence. */
const refusedBy = async (response: Response, fallback: string) =>
  new Error(await refusalFrom(response, COMPONENT_ADMIN_REFUSALS, fallback));

/** Publish or withdraw a component; a refusal is thrown in this page's words. */
async function publishComponent(name: string, published: boolean) {
  const response = await fetch(
    `/api/components/${encodeURIComponent(name)}/publication`,
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ published }),
    },
  );
  if (!response.ok) {
    throw await refusedBy(response, t("That change could not be saved."));
  }
}

/** Save a component's draft description; a refusal is thrown in this page's words. */
async function saveComponentDraft(name: string, description: string) {
  const response = await fetch(
    `/api/components/${encodeURIComponent(name)}/draft`,
    {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description }),
    },
  );
  if (!response.ok) {
    throw await refusedBy(response, t("That draft could not be saved."));
  }
}

/**
 * Runtime governance for compiled gallery components: publication, per-Bot grants, model-facing
 * descriptions, and component data-function access.
 */
export const Route = createFileRoute("/_authed/admin/components")({
  component: RouteComponent,
});

function RouteComponent() {
  const queryClient = useQueryClient();
  const {
    data: components,
    isLoading,
    isError,
    refetch,
  } = useQuery(componentListQueryOptions());
  /*
   * EVERY TOGGLE ON THIS PAGE FAILED IN SILENCE.
   *
   * Four mutations, all of them `onSuccess: invalidate` and no `onError` anywhere: a refused grant,
   * a publish the server rejected, a draft that did not save — each one refetched the list, put the
   * control back where it started, and said nothing. A toggle that springs back with no explanation
   * is indistinguishable from one that never registered the click.
   */
  const [error, setError] = useState<string | null>(null);
  const { data: agents } = useQuery(agentListQueryOptions());
  const { data: dataFunctions } = useQuery(dataFunctionsQueryOptions());

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: componentKeys.all });
  };

  const setGrant = useMutation({
    mutationFn: async ({
      name,
      agentId,
      granted,
    }: {
      name: string;
      agentId: string;
      granted: boolean;
    }) => {
      const response = granted
        ? await fetch(`/api/components/${encodeURIComponent(name)}/grants`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agentId }),
          })
        : await fetch(
            `/api/components/${encodeURIComponent(name)}/grants/${encodeURIComponent(agentId)}`,
            { method: "DELETE", credentials: "include" },
          );
      if (!response.ok) {
        throw await refusedBy(response, t("That change could not be saved."));
      }
    },
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
  });

  const setFunction = useMutation({
    mutationFn: async ({
      name,
      functionName,
      granted,
    }: {
      name: string;
      functionName: string;
      granted: boolean;
    }) => {
      const response = granted
        ? await fetch(`/api/components/${encodeURIComponent(name)}/functions`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ function: functionName }),
          })
        : await fetch(
            `/api/components/${encodeURIComponent(name)}/functions/${encodeURIComponent(functionName)}`,
            { method: "DELETE", credentials: "include" },
          );
      if (!response.ok) {
        throw await refusedBy(response, t("That change could not be saved."));
      }
    },
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
  });

  const setPublished = useMutation({
    mutationFn: ({ name, published }: { name: string; published: boolean }) =>
      publishComponent(name, published),
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
  });

  /*
   * THE DESCRIPTION DIALOG'S ONE ACTION, AWAITED BY IT. 초안 저장 and 게시 each fired their
   * request and closed the dialog on the press, and 게시 fired two — the draft and the publication
   * — at once, so the publication could reach the server before the draft it was meant to publish
   * and publish the previous one. In order now, and a refusal is thrown for the dialog to say.
   */
  const saveDescription = async (
    name: string,
    description: string,
    publish: boolean,
  ) => {
    await saveComponentDraft(name, description);
    if (publish) await publishComponent(name, true);
    setError(null);
    // Read back before the dialog closes, so the card behind it already says what was saved.
    await queryClient.invalidateQueries({ queryKey: componentKeys.all });
  };

  const bots = agents ?? [];

  /*
   * WHICH ROW IS BUSY, not whether the page is. Every one of these switches fired and then sat
   * exactly as it was until the refetch landed, so the only feedback for a slow grant was the
   * button not moving — and a second click sent a second write. Scoped by the mutation's own
   * variables so one Bot's grant does not freeze the rest of the card.
   */
  const busyOn = (name: string) => ({
    grant:
      setGrant.isPending && setGrant.variables?.name === name
        ? setGrant.variables.agentId
        : null,
    fn:
      setFunction.isPending && setFunction.variables?.name === name
        ? setFunction.variables.functionName
        : null,
    isPublishing:
      setPublished.isPending && setPublished.variables?.name === name,
  });

  return (
    <PageShell
      description={t(
        "What each Bot may answer with. Every published component is available to every Bot; switch one off here and that Bot is never told about it. Each change and each refusal is a row in Audit.",
      )}
      title={t("Components")}
    >
      {/*
       * ONE CARD EACH, RATHER THAN A ROW EACH. Every other list in admin is `Item` rows, and these
       * started as hand-drawn ones — but a component carries per-Bot grants and per-function grants,
       * which is a set of switches rather than a line of text. Cramming that into a row would mean
       * hiding it behind a menu, and which Bots hold a component is the thing this page exists to
       * answer at a glance.
       */}
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <PageSection title={t("Published components")}>
        {/*
         * The shape of what is coming, not the word "Loading…". Each of these is a card with a
         * title bar and a row of switches, and a placeholder with the wrong proportions makes the
         * page visibly jump when the real list lands — which reads as a second load.
         */}
        {isLoading ? (
          <div className="mt-4 flex flex-col gap-3">
            {[0, 1, 2].map((card) => (
              <div
                className="rounded-lg border border-border bg-card"
                key={card}
              >
                <div className="flex items-start justify-between gap-4 border-border border-b px-4 py-3">
                  <div className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-64" />
                  </div>
                  <Skeleton className="h-8 w-24" />
                </div>
                <div className="flex gap-2 px-4 py-3">
                  <Skeleton className="h-8 w-20" />
                  <Skeleton className="h-8 w-20" />
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* A heading over an empty div was the whole answer when the list failed to load. */}
        {isError ? (
          <LoadFailed
            message={t("Components could not be loaded.")}
            onRetry={() => void refetch()}
          />
        ) : null}

        {components?.length === 0 && !isLoading && !isError ? (
          <PageEmpty>{t("This deployment ships no components.")}</PageEmpty>
        ) : null}

        <div className="mt-4 flex flex-col gap-3">
          {(components ?? []).map((component, index) => (
            <StaggerItem index={index} key={component.name}>
              <ComponentRow
                bots={bots}
                busy={busyOn(component.name)}
                component={component}
                dataFunctions={dataFunctions ?? []}
                key={component.name}
                onSetFunction={(functionName, granted) =>
                  setFunction.mutate({
                    functionName,
                    granted,
                    name: component.name,
                  })
                }
                onPublish={(published) =>
                  setPublished.mutate({ name: component.name, published })
                }
                onSaveDescription={(description, publish) =>
                  saveDescription(component.name, description, publish)
                }
                onSetGrant={(agentId, granted) =>
                  setGrant.mutate({ agentId, granted, name: component.name })
                }
              />
            </StaggerItem>
          ))}
        </div>
      </PageSection>
    </PageShell>
  );
}

function ComponentRow({
  component,
  bots,
  busy,
  dataFunctions,
  onSetGrant,
  onSetFunction,
  onPublish,
  onSaveDescription,
}: {
  component: ComponentRecord;
  bots: { id: string; name: string }[];
  /** What on THIS card is mid-write: one Bot's grant, one function, or the publication. */
  busy: { grant: string | null; fn: string | null; isPublishing: boolean };
  dataFunctions: DataFunctionSummary[];
  onSetGrant: (agentId: string, granted: boolean) => void;
  onSetFunction: (functionName: string, granted: boolean) => void;
  onPublish: (published: boolean) => void;
  /** Saves the draft, then publishes it when asked; throws the refusal for the dialog to say. */
  onSaveDescription: (description: string, publish: boolean) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(component.draftDescription);
  const saving = usePress();
  /** Which of the dialog's two buttons was pressed, so that one says what it is doing. */
  const [isPublishing, setIsPublishing] = useState(false);
  const withheld = new Set(component.withheldFrom);
  const heldFunctions = new Set(component.functions);

  const handleEditingChange = (open: boolean) => {
    setEditing(open);
    if (!open) saving.forget();
  };
  // Closed only once the server has the description; a refusal keeps it as typed.
  const handleSave = async (publish: boolean) => {
    if (saving.isRunning) return;
    setIsPublishing(publish);
    if (await saving.run(() => onSaveDescription(draft, publish))) {
      handleEditingChange(false);
    }
  };

  return (
    <section
      className="rounded-lg border border-border bg-card"
      data-testid={`component-${component.name}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {/*
             * `t()`, because the title is a KEY the server sends back, not prose it wrote: every
             * one of them is a gallery card name and `i18n-coverage.test.ts` already refuses a
             * gallery card without Korean. Printed raw, this page headed fourteen cards with
             * "Activity report", "Checklist", "Headline figures" on an otherwise Korean screen —
             * with the Korean sitting unused in the dictionary the whole time. A title a person
             * typed in the playground is not in the dictionary and falls through unchanged.
             */}
            <h3 className="font-medium text-sm">{t(component.title)}</h3>
            <code className="rounded bg-foreground/5 px-1.5 py-0.5 text-xs text-muted-foreground">
              {component.name}
            </code>
            {RENDERABLE_NAMES.has(component.name) ? null : (
              <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning">
                {t("Not in this build, nothing can draw it")}
              </span>
            )}
            {component.published ? null : (
              <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning">
                {t("Unpublished, no Bot may use it")}
              </span>
            )}
            {component.hasUnpublishedChanges ? (
              <span className="rounded-md bg-foreground/5 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                {t("Draft not published")}
              </span>
            ) : null}
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {component.publishedDescription ??
              t("Nothing is published, so no Bot is told about this.")}
          </p>
          {/*
           * `toLocaleString()` with no locale follows the machine, not the person: a Korean reader
           * on an English laptop got the date in English on a page that is otherwise Korean.
           */}
          <p className="mt-1 text-muted-foreground text-xs">
            {component.updatedBy
              ? t("Last changed {when} by {who}", {
                  when: new Date(component.updatedAt).toLocaleString(
                    activeLocale,
                  ),
                  who: changedBy(component.updatedBy),
                })
              : t("Last changed {when}", {
                  when: new Date(component.updatedAt).toLocaleString(
                    activeLocale,
                  ),
                })}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            onClick={() => setEditing((open) => !open)}
            size="sm"
            variant="outline"
          >
            {t("Edit description")}
          </Button>
          <Button
            data-testid={`publish-${component.name}`}
            disabled={busy.isPublishing}
            onClick={() => onPublish(!component.published)}
            size="sm"
            variant={component.published ? "outline" : "default"}
          >
            {component.published ? t("Unpublish") : t("Publish")}
          </Button>
        </div>
      </div>

      <Dialog
        isBusy={saving.isRunning}
        onOpenChange={handleEditingChange}
        open={editing}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(component.title)}</DialogTitle>
            <DialogDescription>
              {t(
                "The draft description is what the model reads when deciding to call this. It changes nothing until it is published.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <Field>
              <FieldLabel htmlFor={`draft-${component.name}`}>
                {t("Draft description")}
              </FieldLabel>
              <Textarea
                disabled={saving.isRunning}
                id={`draft-${component.name}`}
                onChange={(event) => setDraft(event.target.value)}
                rows={4}
                value={draft}
              />
            </Field>
            <LiveRegion
              as="p"
              className="text-destructive text-sm"
              tone="alert"
            >
              {saving.failure}
            </LiveRegion>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              disabled={saving.isRunning}
              onClick={() => handleEditingChange(false)}
              size="sm"
              variant="ghost"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={saving.isRunning}
              focusableWhenDisabled={saving.isRunning}
              onClick={() => void handleSave(false)}
              size="sm"
              variant="outline"
            >
              {saving.isRunning && !isPublishing
                ? t("Saving…")
                : t("Save draft")}
            </Button>
            <Button
              disabled={saving.isRunning}
              focusableWhenDisabled={saving.isRunning}
              onClick={() => void handleSave(true)}
              size="sm"
            >
              {saving.isRunning && isPublishing
                ? t("Publishing…")
                : t("Publish")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-wrap gap-2 px-4 py-3">
        {bots.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("There are no Bots yet.")}
          </p>
        ) : null}
        {bots.map((bot) => {
          const has = !withheld.has(bot.id);
          return (
            <Button
              /*
               * `aria-pressed`, which is what the fill has always meant. A row of buttons where the
               * chosen ones are darker says nothing at all to a screen reader — it announced five
               * Bot names and no state — and `Button` now draws the chosen treatment from this
               * attribute, so the two cannot say different things.
               */
              aria-pressed={has}
              data-testid={`grant-${component.name}-${bot.id}`}
              disabled={busy.grant === bot.id}
              key={bot.id}
              onClick={() => onSetGrant(bot.id, !has)}
              size="sm"
              type="button"
              variant="outline"
            >
              {bot.name}
            </Button>
          );
        })}
      </div>

      {/* Data-function grants are separate from Bot component grants. */}
      {dataFunctions.length > 0 ? (
        <div className="border-t border-border px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground">
            {t("May read")}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {dataFunctions.map((fn) => {
              const has = heldFunctions.has(fn.name);
              return (
                <Button
                  aria-pressed={has}
                  data-testid={`function-${component.name}-${fn.name}`}
                  disabled={busy.fn === fn.name}
                  key={fn.name}
                  onClick={() => onSetFunction(fn.name, !has)}
                  size="sm"
                  title={t(dataFunctionDescriptionKey(fn))}
                  type="button"
                  variant="outline"
                >
                  {fn.name}
                  <span className="ml-2 text-muted-foreground text-xs">
                    {t(dataFunctionReadsKey(fn))}
                  </span>
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Who last changed a component, when the server's answer is not a person.
 *
 * `updatedBy` is an email for anything anybody did, and the string "the build" for the components
 * this deployment shipped with — which the row printed straight out as "by the build", an English
 * phrase written by the server on a Korean screen. It is a sentinel, so it is read as one here and
 * said in this surface's own words; an email is somebody's own identifier and goes through as it is.
 */
function changedBy(who: string): string {
  return who === "the build" ? t("this build") : who;
}
