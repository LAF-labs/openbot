import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";
import { AgentFields } from "@/components/agents/agent-fields";
import { Mascot } from "@/components/agents/mascot";
import { MascotPicker } from "@/components/agents/mascot-picker";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  AGENT_EFFORTS,
  type AgentEffort,
  effortLabel,
} from "@/lib/agents/effort-label";
import { agentInputFrom } from "@/lib/agents/form";
import {
  deleteAgentMutationOptions,
  duplicateAgentMutationOptions,
  setAgentEffortMutationOptions,
  setAgentHiddenMutationOptions,
  setAgentPreferencesMutationOptions,
  updateAgentMutationOptions,
} from "@/lib/agents/mutations";
import { agentQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";
import { NotificationPermission } from "@/components/notifications/notification-permission";

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * The shape of the profile, not a generic one.
 *
 * It still drew the round 80px avatar this panel stopped using when the mascot banner landed, so
 * the placeholder and the thing it stood in for disagreed about the whole top of the screen: a
 * circle became a full-width band, and everything under it moved.
 */
function ProfileSkeleton() {
  return (
    <div className="flex w-full flex-col gap-6 p-8 pt-6">
      <header className="flex flex-col items-center gap-3">
        <Skeleton className="h-[132px] w-full rounded-2xl" />
        <div className="flex w-full flex-col items-center gap-1.5">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="flex gap-1.5">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      </header>
      <div className="grid gap-2">
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  );
}

export function AgentProfile({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // State is keyed by coworker id because this panel can remain open while its target changes.
  const [pickingFace, setPickingFace] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const isConfirmingDelete = confirmingDeleteId === agentId;

  const agent = useQuery(agentQueryOptions(agentId));
  const updateAgent = useMutation(updateAgentMutationOptions(queryClient));
  const duplicateAgent = useMutation(
    duplicateAgentMutationOptions(queryClient),
  );
  const setHidden = useMutation(setAgentHiddenMutationOptions(queryClient));
  const deleteAgent = useMutation(deleteAgentMutationOptions(queryClient));

  if (agent.isPending) {
    return <ProfileSkeleton />;
  }
  if (agent.error || !agent.data) {
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        {t("Could not load this coworker.")}
      </p>
    );
  }

  const profile = agent.data;
  const actionError =
    duplicateAgent.error ?? setHidden.error ?? deleteAgent.error;

  /*
   * A NEUTRAL TILE, WITH THE COLOUR IN THE CHARACTER.
   *
   * This was a full-bleed band in the Bot's own colour, 132px of saturation across the top of a
   * pane that is otherwise text and controls — the loudest thing on any screen in the product, on
   * the screen with the least to say. The face already carries its ground; painting the tile the
   * same colour behind it just spread one Bot's hue over the panel.
   *
   * Grok stands its bot mark on `bg/subtle` and lets the mark be the only colour, which is also
   * what makes two Bots' profiles look like the same product rather than like two themes.
   */
  const banner = (
    <span
      aria-hidden="true"
      className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-[var(--sand-bg-subtle)]"
    >
      {/*
       * Clipped to a squircle, because the art carries its own square ground. Standing it on a
       * neutral tile without this traded a full-bleed colour band for a hard colour block — the
       * same problem at a smaller size. Every other place the face appears already clips it.
       */}
      <span className="inline-flex overflow-hidden rounded-[32px] transition-transform duration-200 group-hover:scale-[1.03]">
        <Mascot seed={profile.avatarSeed} size={128} />
      </span>
    </span>
  );

  return (
    <div className="flex w-full flex-col gap-6 p-8 pt-6">
      <header className="flex flex-col items-center gap-3 text-center">
        {/*
         * The face is the control, where there is one to press. A pencil beside it would be a second
         * thing to find, and the only edit anybody wants to make to a picture is to change it.
         *
         * A Bot the deployment shipped is not editable here at all — the server refuses, because its
         * row has to keep agreeing with the tenant package it came from. Its face is chosen in that
         * package, so this offers nothing it cannot deliver.
         */}
        {profile.canManage ? (
          <button
            type="button"
            aria-label={t("Pick a face")}
            className="group w-full overflow-hidden rounded-2xl border border-border transition hover:border-ring/40 focus-visible:ring-2 focus-visible:ring-foreground"
            onClick={() => setPickingFace(true)}
          >
            {banner}
          </button>
        ) : (
          <span className="group w-full overflow-hidden rounded-2xl border border-border">
            {banner}
          </span>
        )}
        <MascotPicker
          open={pickingFace}
          onOpenChange={setPickingFace}
          seed={profile.avatarSeed}
          pending={updateAgent.isPending}
          onSelect={async (avatarSeed) => {
            /*
             * A PATCH replaces the fields it carries, so the ones the parser requires go back
             * unchanged: picking a face must not quietly rename a Bot or make a private one public.
             *
             * `endpoint` is deliberately absent. It is optional, an absent one leaves the stored
             * configuration alone, and sending the current one back would fail validation on any
             * deployment that forbids private hosts — the address is already saved and already
             * working, but it is re-checked as if it had just been typed.
             */
            await updateAgent.mutateAsync({
              agentId,
              input: {
                name: profile.name,
                title: profile.title,
                roleDescription: profile.roleDescription,
                visibility: profile.visibility,
                avatarSeed,
              },
            });
            setPickingFace(false);
          }}
        />
        <div className="flex w-full flex-col items-center gap-0.5">
          <h1 className="w-full text-balance text-2xl font-semibold leading-tight tracking-tight">
            {profile.name}
          </h1>
          <p className="w-full text-balance text-sm text-muted-foreground">
            {profile.title}
          </p>
        </div>

        <div className="flex flex-wrap justify-center gap-1.5">
          <Tag>
            {profile.visibility === "private" ? t("Private") : t("Public")}
          </Tag>
          {profile.systemOwned ? <Tag>{t("System owned")}</Tag> : null}
        </div>
      </header>

      {/*
       * THE PANE IS THE FORM, not a card with an Edit button in front of it.
       *
       * Editing a colleague was a mode: read the role, press Edit, watch the whole pane swap for a
       * form, save, watch it swap back. Grok's settings pane is just the fields — the name you can
       * see is the name you can type in — and for a panel whose entire job is "what is this Bot
       * for", a mode between looking and changing is a step that exists only to be dismissed.
       *
       * A Bot the deployment shipped keeps the read-only view: the server refuses those edits, and
       * a form that cannot save is worse than a sentence that never offered.
       */}
      {profile.canManage ? (
        <AgentFields
          defaultValues={{
            name: profile.name,
            roleDescription: profile.roleDescription,
            title: profile.title,
            visibility: profile.visibility,
            endpoint: profile.endpoint ?? "",
            // The server never sends credentials back to the client.
            authValue: "",
          }}
          hasAuth={profile.hasAuth}
          error={updateAgent.error}
          // No Cancel: there is nothing to cancel back to when the form is the pane.
          onSubmit={async (values) => {
            await updateAgent.mutateAsync({
              agentId,
              input: agentInputFrom(values),
            });
          }}
          submitLabel={t("Save changes")}
        />
      ) : (
        <section className="grid gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("Role")}
          </h2>
          <p className="text-sm whitespace-pre-wrap text-pretty">
            {profile.roleDescription}
          </p>
        </section>
      )}

      {actionError ? (
        <p className="text-sm text-destructive" role="alert">
          {actionError.message}
        </p>
      ) : null}

      {/* Above notifications: how the Bot works comes before how it reaches you. */}
      {profile.canManage ? (
        <EffortCard agentId={agentId} effort={profile.effort} />
      ) : null}

      <NotifyCard
        agentId={agentId}
        name={profile.name}
        notify={profile.notify}
      />

      <div className="flex flex-col gap-2 w-full mt-6">
        <Button
          className="w-full text-sm!"
          onClick={async () => {
            await navigate({
              search: { agent: agentId },
              to: "/channel/new",
            });
          }}
        >
          {t("Start channel")}
        </Button>

        <Button
          className="w-full text-sm!"
          disabled={duplicateAgent.isPending}
          onClick={async () => {
            const copy = await duplicateAgent.mutateAsync(agentId);
            await navigate({ search: { agent: copy.id }, to: "/agents" });
          }}
          variant="outline"
        >
          {duplicateAgent.isPending ? t("Duplicating…") : t("Duplicate")}
        </Button>

        <Button
          className="w-full text-sm!"
          disabled={setHidden.isPending}
          onClick={async () => {
            await setHidden.mutateAsync({
              agentId,
              hidden: !profile.hidden,
            });
            if (!profile.hidden) await navigate({ search: {}, to: "/agents" });
          }}
          variant="outline"
        >
          {setHidden.isPending
            ? profile.hidden
              ? t("Unhiding…")
              : t("Hiding…")
            : profile.hidden
              ? t("Unhide")
              : t("Hide")}
        </Button>

        {profile.hidden ? (
          <p className="-mt-1 text-xs text-muted-foreground">
            {t(
              "Hidden from your agents list. This changes nothing for anyone else.",
            )}
          </p>
        ) : null}

        {profile.canManage ? (
          <>
            <Separator className="my-1" />

            {isConfirmingDelete ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm">
                  {t("Delete {name}? This cannot be undone.", {
                    name: profile.name,
                  })}
                </p>
                {/* Cancel remains closest to the original Delete button position. */}
                <Button
                  className="w-full text-sm!"
                  onClick={() => setConfirmingDeleteId(null)}
                  variant="outline"
                >
                  {t("Cancel")}
                </Button>
                <Button
                  className="w-full text-sm!"
                  disabled={deleteAgent.isPending}
                  onClick={async () => {
                    await deleteAgent.mutateAsync(agentId);
                    await navigate({ search: {}, to: "/agents" });
                  }}
                  variant="destructive"
                >
                  {deleteAgent.isPending ? t("Deleting…") : t("Delete")}
                </Button>
              </div>
            ) : (
              <Button
                className="w-full text-sm!"
                onClick={() => setConfirmingDeleteId(agentId)}
                variant="destructive"
              >
                {t("Delete")}
              </Button>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * How hard this Bot thinks, and nothing else about the model.
 *
 * THE ONLY MODEL SETTING THERE IS. A list of model names asks somebody to know which of a dozen
 * vendors' products is better at their particular job, and the honest answer changes every month;
 * so the model is the deployment's decision, one for everybody, and what a person chooses is how
 * long they are willing to wait. That is a question only they can answer, and the one that genuinely
 * differs between "summarise this" and "work out what happened".
 *
 * Applied on the press, like the face and the notification switch, because it is a setting and not
 * a draft. It goes through `/profile`, which merges into what is stored, so pressing it cannot
 * overwrite something half-typed in the form above.
 *
 * NOT DRAWN AT ALL where the deployment's model takes no such setting. The alternative — showing it
 * and quietly sending nothing — is a control that lies, and the person most likely to press it is
 * the one who most wants it to work.
 */
function EffortCard({
  agentId,
  effort,
}: {
  agentId: string;
  effort: AgentEffort;
}) {
  const queryClient = useQueryClient();
  const { data: user } = useQuery(currentUserQueryOptions());
  const setEffort = useMutation(setAgentEffortMutationOptions(queryClient));
  const labelId = useId();

  if (user && !user.deployment.effort) return null;

  return (
    <section className="flex flex-col gap-2 rounded-xl bg-[var(--sand-fill-secondary)] p-3">
      {/*
       * A fieldset, and `aria-pressed` on the buttons — the same grammar the face picker uses. One
       * choice out of three, and a reader arriving on the middle button should hear which one is
       * already made rather than three identical-sounding options.
       */}
      <fieldset className="flex flex-col gap-2">
        <legend className="flex flex-col gap-0.5 pb-2">
          <span className="font-medium text-base" id={labelId}>
            {t("How hard it thinks")}
          </span>
          <span className="block text-muted-foreground text-sm">
            {t("Thinking longer costs time. It is worth it on the hard ones.")}
          </span>
        </legend>
        <div className="flex gap-1.5">
          {AGENT_EFFORTS.map((option) => (
            <Button
              aria-pressed={option === effort}
              /*
               * `ring-2 ring-primary`, the same mark the face picker puts on the tile you chose.
               * A tint was the first try and it did not read: on this ground `bg-foreground/5` is
               * about two per cent of contrast, so the three buttons looked identical and only a
               * screen reader was told which one was set — which is the wrong way round.
               */
              className={`flex-1 text-sm!${
                option === effort
                  ? " ring-2 ring-primary ring-offset-1 ring-offset-[var(--sand-fill-secondary)]"
                  : ""
              }`}
              disabled={setEffort.isPending}
              key={option}
              onClick={() => {
                if (option === effort) return;
                setEffort.mutate({ agentId, effort: option });
              }}
              size="sm"
              variant="outline"
            >
              {effortLabel(option)}
            </Button>
          ))}
        </div>
      </fieldset>
      {setEffort.error ? (
        <p className="text-destructive text-sm" role="alert">
          {setEffort.error.message}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Whether this Bot is allowed to interrupt you.
 *
 * Its own card, and available to everybody — not only to whoever can edit the Bot. Muting is a
 * fact about the reader: two people sharing a public coworker decide it separately, and one of
 * them wanting quiet must not silence the other. That is also why it saves on the switch rather
 * than waiting for the form's Save: it is not one of the Bot's fields.
 */
function NotifyCard({
  agentId,
  name,
  notify,
}: {
  agentId: string;
  name: string;
  notify: boolean;
}) {
  const queryClient = useQueryClient();
  const preferences = useMutation(
    setAgentPreferencesMutationOptions(queryClient),
  );
  const labelId = useId();

  return (
    <section className="flex items-start gap-3 rounded-xl bg-[var(--sand-fill-secondary)] p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="font-medium text-base" id={labelId}>
          {t("Notifications")}
        </h2>
        <p className="text-muted-foreground text-sm">
          {t("Tell me when {name} finishes or needs me.", { name })}
        </p>
        {notify ? (
          <NotificationPermission
            grantedNote={t("Only while a tab is open.")}
          />
        ) : null}
        {preferences.error ? (
          <p className="pt-1 text-destructive text-sm" role="alert">
            {preferences.error.message}
          </p>
        ) : null}
      </div>
      <Switch
        aria-labelledby={labelId}
        checked={notify}
        className="mt-1 shrink-0"
        disabled={preferences.isPending}
        onCheckedChange={(next) => {
          /*
           * The preference is this person's answer about this Bot; the browser's permission is
           * about the site, and it is asked for separately just above. Muting a Bot here is not a
           * statement about the site, and a browser that refuses the site is no reason to stop
           * wanting to hear from the Bot — the roster still goes bold for it either way.
           */
          preferences.mutate({ agentId, patch: { notify: next } });
        }}
      />
    </section>
  );
}
