import { OpenGenerativeUIActivityRenderer } from "@copilotkit/react-core/v2";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { ConfirmDialog } from "@/components/layout/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/lib/i18n";
import { josa } from "@/lib/josa";
import {
  type SandboxedRecord,
  sandboxedKeys,
  sandboxedListQueryOptions,
} from "@/lib/sandboxed/queries";

/**
 * Browser-authored components are edited as drafts, previewed in the production sandbox renderer,
 * and used by conversations only after publishing.
 */
export const Route = createFileRoute("/_authed/admin/playground")({
  component: PlaygroundPage,
});

const STARTER = {
  slug: "",
  title: "",
  description: "",
  html: `<div class="card">\n  <h3 id="title">{t("Untitled")}</h3>\n  <p id="body"></p>\n</div>`,
  css: `.card { font: 14px system-ui; border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px; }\n.card h3 { margin: 0 0 4px; font-size: 15px; }`,
  jsFunctions: `// The arguments are on window.__args by the time this runs.\nconst args = window.__args || {};\ndocument.getElementById("title").textContent = args.title || "Untitled";\ndocument.getElementById("body").textContent = args.body || "";`,
  argumentSchema: `{\n  "type": "object",\n  "properties": {\n    "title": { "type": "string" },\n    "body": { "type": "string" }\n  }\n}`,
  sampleArguments: `{\n  "title": "A worked example",\n  "body": "Edit the panels on the left and this redraws."\n}`,
};

type Draft = typeof STARTER;

function PlaygroundPage() {
  const [deleting, setDeleting] = useState<string | null>(null);
  const queryClient = useQueryClient();
  /*
   * The whole query, not `data` alone. It was destructured to `{ data: components }`, so a list that
   * FAILED to load and a deployment with nothing saved in it drew the identical sentence — 아직
   * 없습니다 — and the only difference between "you have written none" and "this deployment cannot
   * tell you" was in a variable nobody read.
   */
  const components = useQuery(sandboxedListQueryOptions());
  const saved = components.data ?? [];
  const [draft, setDraft] = useState<Draft>(STARTER);
  const [error, setError] = useState<string | null>(null);
  /** What the component inside the preview threw, if anything. See `sandboxGuard`. */
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    /*
     * Filtered by the message this page mints rather than by origin, because a sandbox without
     * `allow-same-origin` posts from the opaque origin `"null"` and there is nothing to compare it
     * against. What that costs is bounded: any frame could post this shape, and all it can do is put
     * a string of its choosing into the panel below, clipped, labelled as coming from the preview.
     */
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; message?: unknown } | null;
      if (data?.type !== SANDBOX_ERROR) return;
      setPreviewError(
        typeof data.message === "string"
          ? data.message
          : t("That did not work."),
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const set = (field: keyof Draft) => (value: string) => {
    // A failure belongs to the draft that caused it: the renderer is keyed on the draft and is
    // rebuilt from scratch on every keystroke, so a stale message would outlive the code it was about.
    setPreviewError(null);
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const parsed = (raw: string): Record<string, unknown> | null => {
    try {
      const value = JSON.parse(raw);
      return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  const sample = parsed(draft.sampleArguments);
  const schema = parsed(draft.argumentSchema);

  const mutate = useMutation({
    mutationFn: async (action: () => Promise<Response>) => {
      setError(null);
      const response = await action();
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(detail?.error ?? t("That did not work."));
      }
      return response.json();
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: sandboxedKeys.all }),
    onError: (thrown: Error) => setError(thrown.message),
  });

  const saveDraft = () =>
    fetch("/api/sandboxed", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: draft.slug,
        title: draft.title,
        description: draft.description,
        html: draft.html,
        css: draft.css,
        jsFunctions: draft.jsFunctions,
        argumentSchema: schema ?? {},
        sampleArguments: sample ?? {},
      }),
    });

  const save = () => mutate.mutate(saveDraft);

  /**
   * Publish what is on screen.
   *
   * Saved first, because publishing acts on the stored draft rather than on the editors.
   */
  const publish = () =>
    mutate.mutate(async () => {
      const saved = await saveDraft();
      if (!saved.ok) return saved;
      return fetch(
        `/api/sandboxed/${encodeURIComponent(`custom_${draft.slug}`)}/publish`,
        { method: "POST", credentials: "include" },
      );
    });

  const load = (component: SandboxedRecord) =>
    setDraft({
      slug: component.name.replace(/^custom_/, ""),
      title: component.title,
      description: component.draftDescription,
      html: component.draftHtml,
      css: component.draftCss,
      jsFunctions: component.draftJsFunctions,
      argumentSchema: JSON.stringify(component.draftArgumentSchema, null, 2),
      sampleArguments: JSON.stringify(component.sampleArguments, null, 2),
    });

  return (
    /*
     * THE ONE PAGE THAT KEEPS ITS OWN GEOMETRY. Everything else in admin is a column you scroll;
     * this is an editor beside a live preview, and the preview is the entire point — put it in the
     * standard prose column and it lands below the fold, so you would be typing at something you
     * cannot see. It takes the header and the controls, and keeps the two panes.
     */
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-start justify-between gap-4 border-border border-b px-6 py-4">
        <div>
          <h1 className="font-bold text-2xl">{t("Playground")}</h1>
          <p className="mt-1 max-w-prose text-pretty text-muted-foreground text-sm leading-relaxed">
            {t(
              "Write a component here and publish it without a deployment. What you edit is a draft; a conversation only ever draws what is published.",
            )}
          </p>
        </div>
        {/*
         * BOTH SAY WHEN THEY ARE WORKING. Publishing is two round trips — the draft is stored first
         * — and neither button moved while they were in flight, so the honest reading of a slow
         * save was that the press had missed. Disabled as well as relabelled: a second press
         * during a publish sends a second save.
         */}
        <div className="flex gap-2">
          <Button
            disabled={!(draft.slug && draft.title) || mutate.isPending}
            onClick={save}
            size="sm"
            type="button"
            variant="outline"
          >
            {mutate.isPending ? t("Saving…") : t("Save draft")}
          </Button>
          <Button
            /* `publish` saves first, since publishing acts on the stored draft, not the editors. */
            disabled={!(draft.slug && draft.title) || mutate.isPending}
            onClick={publish}
            size="sm"
            type="button"
          >
            {mutate.isPending ? t("Publishing…") : t("Publish")}
          </Button>
        </div>
      </header>

      {error ? (
        <div
          className="border-border border-b bg-destructive/10 px-6 py-2 text-destructive text-sm"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto px-6 py-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="grid gap-2 md:grid-cols-2">
            <TextField
              label={t("Name")}
              onChange={set("slug")}
              placeholder="refund_card"
              value={draft.slug}
            />
            <TextField
              label={t("Title")}
              onChange={set("title")}
              placeholder={t("Refund card")}
              value={draft.title}
            />
          </div>
          <TextField
            label={t("What the model is told about it")}
            onChange={set("description")}
            placeholder={t("Show a refund with its amount, reason and status.")}
            value={draft.description}
          />
          <CodeField
            label={t("HTML")}
            onChange={set("html")}
            value={draft.html}
          />
          <CodeField label={t("CSS")} onChange={set("css")} value={draft.css} />
          <CodeField
            label={t("JavaScript")}
            onChange={set("jsFunctions")}
            value={draft.jsFunctions}
          />
          <CodeField
            invalid={schema === null}
            label={t("Arguments (JSON Schema)")}
            onChange={set("argumentSchema")}
            value={draft.argumentSchema}
          />
          <CodeField
            invalid={sample === null}
            label={t("Sample arguments")}
            onChange={set("sampleArguments")}
            value={draft.sampleArguments}
          />
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border p-4">
            <div className="mb-2 font-medium text-sm">{t("Preview")}</div>
            {previewError ? (
              <p
                className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs"
                role="alert"
              >
                {previewError}
                <span className="mt-1 block text-muted-foreground">
                  {t(
                    "This ran in a sandbox with no access to this site, so storage, cookies and same-origin requests are not available — here or in a conversation.",
                  )}
                </span>
              </p>
            ) : null}
            {sample === null ? (
              <p className="text-sm text-destructive">
                {t(
                  "The sample arguments are not valid JSON, so there is nothing to draw with.",
                )}
              </p>
            ) : (
              <OpenGenerativeUIActivityRenderer
                activityType="open-generative-ui"
                agent={null}
                content={{
                  css: draft.css,
                  cssComplete: true,
                  html: [draft.html],
                  htmlComplete: true,
                  // Provide sample args in the same sandbox evaluation as the component code.
                  jsFunctions: `${sandboxGuard()}window.__args = ${JSON.stringify(sample)};\n${draft.jsFunctions}`,
                  jsFunctionsComplete: true,
                  generating: false,
                }}
                key={`${draft.html}${draft.css}${draft.jsFunctions}${draft.sampleArguments}`}
                message={null}
              />
            )}
          </div>

          <div className="rounded-lg border border-border bg-card">
            <div className="border-border border-b px-4 py-2 font-medium text-sm">
              {t("Saved here")}
            </div>
            {components.isPending ? (
              <div className="space-y-2 px-4 py-3">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            ) : components.isError ? (
              <div className="px-4 py-3">
                <p className="text-destructive text-sm" role="alert">
                  {t("What is saved here could not be read.")}
                </p>
                <Button
                  className="mt-2"
                  onClick={() => void components.refetch()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {t("Try again")}
                </Button>
              </div>
            ) : saved.length === 0 ? (
              <p className="px-4 py-3 text-muted-foreground text-sm">
                {t("Nothing yet.")}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {saved.map((component) => (
                  <li
                    className="flex items-center justify-between px-4 py-2 text-sm"
                    key={component.name}
                  >
                    <div>
                      <div className="font-mono text-xs">{component.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {component.published
                          ? t("published, revision {revision}", {
                              revision: component.revision,
                            })
                          : t("draft only, no Bot can draw it")}
                        {component.hasUnpublishedChanges
                          ? ` · ${t("edited since publishing")}`
                          : ""}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => load(component)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {t("Open")}
                      </Button>
                      <Button
                        disabled={mutate.isPending}
                        onClick={() => setDeleting(component.name)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {t("Delete")}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="border-border border-t px-4 py-2 text-muted-foreground text-xs">
              {t(
                "Publishing makes it available to every Bot. Switch it off for a particular Bot on the Components page, the same as for a component this build ships.",
              )}
            </p>
          </div>
        </div>
      </div>

      {/*
       * Deleting was a bare button on a row of one-line entries, and it does not come back. The
       * dialog names the component, so what is agreed to says which one it removes — through the
       * shared `ConfirmDialog`, which is where the focus trap and the legible destructive button
       * live, and `josa()`, so the Korean agrees with a name it has never seen instead of saying
       * 을(를) at somebody about to delete something.
       */}
      <ConfirmDialog
        confirmLabel={t("Delete it")}
        description={t(
          "It is removed from this deployment. Any Bot that could draw it no longer can, and this cannot be undone.",
        )}
        onConfirm={() => {
          const name = deleting;
          setDeleting(null);
          if (name) {
            mutate.mutate(() =>
              fetch(`/api/sandboxed/${encodeURIComponent(name)}`, {
                method: "DELETE",
                credentials: "include",
              }),
            );
          }
        }}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        open={deleting !== null}
        pending={mutate.isPending}
        title={t("Delete {name}{josa}?", {
          josa: josa(deleting ?? "", "을/를"),
          name: deleting ?? "",
        })}
      />
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  /*
   * An explicit `htmlFor`, not a wrapping label. The label used to wrap a bare `<input>`; now that
   * the control is a component the association has to be written down rather than implied by
   * nesting, or it exists for sighted people only.
   */
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </Field>
  );
}

function CodeField({
  label,
  value,
  onChange,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}) {
  const id = useId();
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>
        {label}
        {invalid ? (
          <span className="ml-2 text-destructive">{t("not valid JSON")}</span>
        ) : null}
      </FieldLabel>
      <Textarea
        aria-invalid={invalid}
        className="h-32 font-mono text-xs"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        value={value}
      />
    </Field>
  );
}

/** The message the preview sends its host when the component inside it throws. */
export const SANDBOX_ERROR = "laf:sandbox-error";

/**
 * WHY A COMPONENT THAT TOUCHES STORAGE DIES SILENTLY, AND WHERE THE AUTHOR FINDS OUT.
 *
 * The preview runs in `@jetbrains/websandbox`, which sets the iframe's `sandbox` attribute to
 * `allow-scripts` and NOTHING else (`lib/websandbox.ts`: `frame.sandbox = 'allow-scripts ' +
 * sandboxAdditionalAttributes`, and the renderer passes the empty default — measured on the running
 * page, the attribute reads exactly `"allow-scripts "`). A document sandboxed without
 * `allow-same-origin` has an opaque origin, so `window.localStorage` does not return null: reading
 * the property THROWS `SecurityError: … the document is sandboxed and lacks the 'allow-same-origin'
 * flag`. The same is true of `sessionStorage`, `document.cookie` and IndexedDB, and CopilotKit tells
 * the model as much in the tool description it ships.
 *
 * The throw lands inside an iframe that is cross-origin to this page, so nothing here could see it:
 * the preview simply stopped drawing halfway and the only evidence was a line in the browser
 * console. An author watching a live preview is exactly the person who should be told.
 *
 * A SHIM WOULD HAVE BEEN WORSE. Defining a working `localStorage` on the sandbox window is a couple
 * of lines and makes the preview draw — and then the same component fails in a conversation, where
 * the sandbox is the same and this page is not. The preview has to fail the way production fails.
 *
 * THE MESSAGE COMES BACK OUT rather than being written into the preview document. Drawing it in
 * there was the first attempt and it inherits the component's own CSS, which is the one stylesheet
 * in that document: the starter card is written for a white page, so on a dark preview the
 * explanation was near-black text on a near-black ground. Out here it is in this app's own theme,
 * in Korean, in the panel the author is already looking at.
 *
 * An error LISTENER rather than a `try`/`catch` around the author's code: wrapping it in a block
 * would move every top-level `function` and `const` into that block's scope, so a helper the HTML
 * calls from an `onclick` would stop existing. The listener changes nothing about how the code runs.
 */
export function sandboxGuard(): string {
  return `(function () {
  window.addEventListener("error", function (event) {
    try {
      window.parent.postMessage({
        type: ${JSON.stringify(SANDBOX_ERROR)},
        message: String((event && event.message) || event).slice(0, 300),
      }, "*");
    } catch (ignored) {}
  });
})();
`;
}
