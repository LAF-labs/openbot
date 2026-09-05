import { IconDots } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { AgentFields } from "@/components/agents/agent-fields";
import { Mascot } from "@/components/agents/mascot";
import { MascotPicker } from "@/components/agents/mascot-picker";
import { NotificationPermission } from "@/components/notifications/notification-permission";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  AGENT_EFFORTS,
  type AgentEffort,
  effortLabel,
} from "@/lib/agents/effort-label";
import {
  deleteAgentMutationOptions,
  duplicateAgentMutationOptions,
  setAgentEffortMutationOptions,
  setAgentHiddenMutationOptions,
  setAgentPreferencesMutationOptions,
  updateAgentMutationOptions,
} from "@/lib/agents/mutations";
import { useSeats } from "@/lib/agents/new-bot";
import {
  agentKeys,
  agentMemoriesQueryOptions,
  type AgentProfile as AgentProfileRecord,
  agentQueryOptions,
} from "@/lib/agents/queries";
import { seatsFullMessage } from "@/lib/agents/seats";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";
import { pluginKeys, pluginsPageQueryOptions } from "@/lib/plugins/queries";
import { useSavedFlash } from "@/lib/saved-flash";

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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const isEditing = editingId === agentId;
  const isConfirmingDelete = confirmingDeleteId === agentId;

  const agent = useQuery(agentQueryOptions(agentId));
  const updateAgent = useMutation(updateAgentMutationOptions(queryClient));
  const duplicateAgent = useMutation(
    duplicateAgentMutationOptions(queryClient),
  );
  const setHidden = useMutation(setAgentHiddenMutationOptions(queryClient));
  const deleteAgent = useMutation(deleteAgentMutationOptions(queryClient));
  const seats = useSeats();

  if (agent.isPending) {
    return <ProfileSkeleton />;
  }
  if (agent.error || !agent.data) {
    return (
      <p className="p-8 text-destructive text-sm" role="alert">
        {t("Could not load this Bot.")}
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
            aria-label={t("Pick a face")}
            className="group w-full overflow-hidden rounded-2xl border border-border transition hover:border-ring/40 focus-visible:ring-2 focus-visible:ring-foreground"
            onClick={() => setPickingFace(true)}
            type="button"
          >
            {banner}
          </button>
        ) : (
          <span className="group w-full overflow-hidden rounded-2xl border border-border">
            {banner}
          </span>
        )}
        <MascotPicker
          onOpenChange={setPickingFace}
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
                avatarSeed,
                name: profile.name,
                roleDescription: profile.roleDescription,
                title: profile.title,
                visibility: profile.visibility,
              },
            });
            setPickingFace(false);
          }}
          open={pickingFace}
          pending={updateAgent.isPending}
          seed={profile.avatarSeed}
        />

        {/*
         * THE NAME AND THE JOB, AND EDITING THEM IS A MENU ITEM.
         *
         * The whole pane used to be the form: a name field, a title field, a role field, a
         * visibility select and — for anybody the deployment counts as an administrator, which on a
         * one-person deployment is the shop owner — an AG-UI endpoint and a bearer token. Six
         * controls in a 320px column, above the settings that are actually looked at.
         */}
        {isEditing ? (
          <AgentFields
            defaultValues={{ name: profile.name, title: profile.title }}
            error={updateAgent.error}
            onCancel={() => setEditingId(null)}
            onSubmit={async (values) => {
              await updateAgent.mutateAsync({
                agentId,
                input: {
                  name: values.name,
                  roleDescription: profile.roleDescription,
                  title: values.title,
                  visibility: profile.visibility,
                },
              });
              setEditingId(null);
            }}
          />
        ) : (
          <>
            <div className="flex w-full flex-col items-center gap-0.5">
              <h1 className="w-full text-balance font-semibold text-2xl leading-tight tracking-tight">
                {profile.name}
              </h1>
              {profile.title ? (
                <p className="w-full text-balance text-muted-foreground text-sm">
                  {profile.title}
                </p>
              ) : null}
            </div>

            <div className="flex w-full items-center gap-2">
              <Button
                className="flex-1 text-sm!"
                onClick={async () => {
                  await navigate({
                    search: { agent: agentId },
                    to: "/channel/new",
                  });
                }}
              >
                {t("Start channel")}
              </Button>
              <BotMenu
                onDelete={() => setConfirmingDeleteId(agentId)}
                onDuplicate={async () => {
                  const copy = await duplicateAgent.mutateAsync(agentId);
                  await navigate({ search: { agent: copy.id }, to: "/agents" });
                }}
                onEdit={() => setEditingId(agentId)}
                onToggleHidden={async () => {
                  await setHidden.mutateAsync({
                    agentId,
                    hidden: !profile.hidden,
                  });
                  if (!profile.hidden)
                    await navigate({ search: {}, to: "/agents" });
                }}
                profile={profile}
                seatsFull={seats.isFull}
                seatsLast={seats.isLastSeat}
                seatsMessage={seatsFullMessage(seats)}
              />
            </div>
          </>
        )}
      </header>

      {actionError ? (
        <p className="text-destructive text-sm" role="alert">
          {actionError.message}
        </p>
      ) : null}

      {profile.canManage ? (
        <WorkStyleCard
          agentId={agentId}
          profile={profile}
          roleDescription={profile.roleDescription}
        />
      ) : profile.roleDescription ? (
        <section className="grid gap-2">
          <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {t("How it works")}
          </h2>
          <p className="whitespace-pre-wrap text-pretty text-sm">
            {profile.roleDescription}
          </p>
        </section>
      ) : null}

      {/* Above notifications: how the Bot works comes before how it reaches you. */}
      {profile.canManage ? (
        <EffortCard agentId={agentId} effort={profile.effort} />
      ) : null}

      {profile.canManage ? (
        <AutoReviewCard agentId={agentId} instruction={profile.autoReview} />
      ) : null}

      <MemoriesCard agentId={agentId} />

      {profile.canManage ? <SkillsCard agentId={agentId} /> : null}

      <NotifyCard
        agentId={agentId}
        name={profile.name}
        notify={profile.notify}
      />

      {/*
       * ASKED IN A DIALOG, NOT IN A SECOND BUTTON AT THE BOTTOM OF THE PANE.
       *
       * Delete used to sit under Duplicate and Hide in a stack of four full-width buttons, with the
       * destructive one last and its confirmation replacing it in place — so the press that deletes
       * a Bot landed where the press that asked about it had just been.
       */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirmingDeleteId(null);
        }}
        open={isConfirmingDelete}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("Delete {name}?", { name: profile.name })}
            </DialogTitle>
            <DialogDescription>
              {t(
                "Its conversations, its routines and everything it remembers go with it. This cannot be undone.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setConfirmingDeleteId(null)}
              size="sm"
              variant="ghost"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={deleteAgent.isPending}
              onClick={async () => {
                await deleteAgent.mutateAsync(agentId);
                setConfirmingDeleteId(null);
                await navigate({ search: {}, to: "/agents" });
              }}
              size="sm"
              variant="destructive"
            >
              {deleteAgent.isPending ? t("Deleting…") : t("Delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * EVERYTHING YOU CAN DO TO A BOT, IN ONE PLACE, WITH ITS CONSEQUENCES WRITTEN DOWN.
 *
 * The four verbs used to be four full-width buttons stacked down the pane, in this order: start a
 * conversation, duplicate, hide, delete. Three of the four are rare and one of them is permanent,
 * and the sentence explaining what Hide does only appeared AFTER it had been pressed.
 *
 * So: one primary verb outside, the rest behind ⋯, and each one says what it does under its own
 * name. Duplicate spends a seat, which is the thing nobody knew, so it says which seat.
 */
function BotMenu({
  onDelete,
  onDuplicate,
  onEdit,
  onToggleHidden,
  profile,
  seatsFull,
  seatsLast,
  seatsMessage,
}: {
  onDelete: () => void;
  onDuplicate: () => Promise<void>;
  onEdit: () => void;
  onToggleHidden: () => Promise<void>;
  profile: AgentProfileRecord;
  seatsFull: boolean;
  seatsLast: boolean;
  seatsMessage: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={t("Actions for {name}", { name: profile.name })}
            size="icon"
            variant="outline"
          >
            <IconDots />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          {profile.canManage ? (
            <DropdownMenuItem
              className="flex-col items-start gap-0"
              onClick={onEdit}
            >
              <span>{t("Edit profile")}</span>
              <span className="text-muted-foreground text-xs">
                {t("Its name and what it does.")}
              </span>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="flex-col items-start gap-0"
            onClick={() => void onToggleHidden()}
          >
            <span>{profile.hidden ? t("Unhide") : t("Hide")}</span>
            {/*
             * THE EXPLANATION IS IN THE MENU, NOT AFTER THE PRESS. It used to appear as a line
             * under the button once the Bot was already hidden, which is the one moment somebody
             * has stopped needing it.
             */}
            <span className="text-muted-foreground text-xs">
              {profile.hidden
                ? t("Put it back on your Bot list.")
                : t("Off your Bot list. It keeps working, and keeps its seat.")}
            </span>
          </DropdownMenuItem>
          {profile.canManage ? (
            <DropdownMenuItem
              className="flex-col items-start gap-0"
              disabled={seatsFull}
              onClick={() => void onDuplicate()}
            >
              <span>{t("Duplicate")}</span>
              <span className="text-muted-foreground text-xs">
                {seatsFull
                  ? seatsMessage
                  : seatsLast
                    ? t(
                        "A copy with the same settings. It takes your last seat.",
                      )
                    : t("A copy with the same settings. It takes a seat.")}
              </span>
            </DropdownMenuItem>
          ) : null}
          {profile.canManage ? (
            <DropdownMenuItem
              className="flex-col items-start gap-0"
              onClick={onDelete}
              variant="destructive"
            >
              <span>{t("Delete")}</span>
              <span className="text-xs opacity-80">
                {t("It asks first. There is no undo.")}
              </span>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * WHAT THIS BOT IS FOR, IN THE OWNER'S OWN WORDS.
 *
 * The standing instruction the model is given on every run. It is the one field on this pane worth
 * a paragraph, and it used to be the third input of a five-field form — saved by a button that
 * said "Save changes" and then said nothing at all, so the only way to know it had worked was to
 * close the pane and open it again.
 *
 * A PATCH, with the fields the parser requires sent back unchanged, and `endpoint` deliberately
 * absent — the same rule the face picker follows.
 */
function WorkStyleCard({
  agentId,
  profile,
  roleDescription,
}: {
  agentId: string;
  profile: AgentProfileRecord;
  roleDescription: string;
}) {
  const queryClient = useQueryClient();
  const updateAgent = useMutation(updateAgentMutationOptions(queryClient));
  const [draft, setDraft] = useState(roleDescription);
  const [saved, flashSaved] = useSavedFlash();
  const labelId = useId();
  const dirty = draft.trim() !== roleDescription.trim();

  return (
    <section className="flex flex-col gap-2 rounded-xl bg-[var(--sand-fill-secondary)] p-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-medium text-base" id={labelId}>
          {t("How it works")}
        </h2>
        <p className="text-muted-foreground text-sm">
          {t(
            "What you want it to do, and how. It reads this before every job. Leaving it empty is fine — it will ask.",
          )}
        </p>
      </div>
      <Textarea
        aria-labelledby={labelId}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={t(
          "Review receipts, categorize expenses, and prepare reimbursement reports.",
        )}
        rows={4}
        value={draft}
      />
      {dirty ? (
        <div className="flex gap-2">
          <Button
            disabled={updateAgent.isPending}
            onClick={async () => {
              await updateAgent.mutateAsync({
                agentId,
                input: {
                  name: profile.name,
                  roleDescription: draft.trim(),
                  title: profile.title,
                  visibility: profile.visibility,
                },
              });
              flashSaved();
            }}
            size="sm"
          >
            {updateAgent.isPending ? t("Saving…") : t("Save")}
          </Button>
          <Button
            disabled={updateAgent.isPending}
            onClick={() => setDraft(roleDescription)}
            size="sm"
            variant="outline"
          >
            {t("Cancel")}
          </Button>
        </div>
      ) : null}
      {saved ? (
        <p className="text-muted-foreground text-sm" role="status">
          {t("Saved")}
        </p>
      ) : null}
      {updateAgent.error ? (
        <p className="text-destructive text-sm" role="alert">
          {updateAgent.error.message}
        </p>
      ) : null}
    </section>
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
 * WHAT THIS BOT HAS LEARNED, AND THE BUTTON THAT UNDOES IT.
 *
 * The competing product keeps the same thing and its own documentation says you cannot inspect,
 * correct, export, or delete individual memories. This card is the whole disagreement: a Bot that
 * quietly learned something wrong about somebody's business is the ordinary case, not the edge one,
 * and it has to be fixable in the time it takes to read the sentence.
 *
 * Shown to everybody who can see the Bot rather than only to whoever manages it, because these are
 * the reader's own — a shared coworker keeps what it learned from each person separately, and
 * nobody else's is on this list.
 *
 * DRAWN EMPTY, TOO. It used to return null with nothing learned yet, so the one question this card
 * answers — what does it know about me — had no answer at all until it had a worrying one. An empty
 * list is the reassuring case and it should be readable.
 */
function MemoriesCard({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const { data: memories, isPending } = useQuery(
    agentMemoriesQueryOptions(agentId),
  );
  const [forgetting, setForgetting] = useState<string | null>(null);

  const forget = async (memoryId: string) => {
    setForgetting(memoryId);
    try {
      await fetch(
        `/api/agents/${encodeURIComponent(agentId)}/memories/${encodeURIComponent(memoryId)}`,
        { credentials: "include", method: "DELETE" },
      );
      await queryClient.invalidateQueries({
        queryKey: agentKeys.memories(agentId),
      });
    } finally {
      setForgetting(null);
    }
  };

  // Nothing is claimed before the answer arrives: "it remembers nothing" is as much a claim as a
  // list, and it was being made while the request was still in flight.
  if (isPending) return null;

  return (
    <section className="flex flex-col gap-2 rounded-xl bg-[var(--sand-fill-secondary)] p-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-medium text-base">{t("What it remembers")}</h2>
        <p className="text-muted-foreground text-sm">
          {t(
            "Things this Bot worked out about you and keeps between conversations. Only you see yours.",
          )}
        </p>
      </div>
      {memories && memories.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {memories.map((memory) => (
            <li
              className="flex items-start gap-2 rounded-lg bg-background px-3 py-2"
              key={memory.id}
            >
              <p className="flex-1 text-pretty text-sm">{memory.content}</p>
              <Button
                disabled={forgetting === memory.id}
                onClick={() => void forget(memory.id)}
                size="sm"
                variant="ghost"
              >
                {t("Forget")}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg bg-background px-3 py-2 text-muted-foreground text-sm">
          {t("Nothing yet. What it learns about you appears here.")}
        </p>
      )}
    </section>
  );
}

/**
 * WHICH OF YOUR SKILLS THIS BOT CARRIES.
 *
 * A skill is a named instruction invoked with `/`, and putting one on a Bot is the owner's decision
 * about their own Bot — the endpoint has said so all along (`enablementRefusal` lets a non-admin
 * grant their OWN skill to a Bot they OWN, and refuses everything else). The control for it was
 * only ever drawn on the admin screen, so on the surface the shop owner actually uses, a skill they
 * had written could not be given to a Bot they had made.
 *
 * Only their own skills are listed. The deployment's are an administrator's to hand out, and the
 * server refuses this person either way; an affordance that always fails is worse than none.
 */
function SkillsCard({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const { data: me } = useQuery(currentUserQueryOptions());
  const { data, isPending } = useQuery(pluginsPageQueryOptions());
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const mine = (data?.skills ?? []).filter(
    (skill) => skill.ownerUserId && skill.ownerUserId === me?.id,
  );
  // Nothing to grant and nothing to say: the Skills page is where a first one gets written.
  if (isPending || mine.length === 0) return null;

  const toggle = async (slug: string, held: boolean) => {
    setBusy(slug);
    setProblem(null);
    try {
      const response = held
        ? await fetch(
            `/api/plugins/grants?kind=skill&ref=${encodeURIComponent(slug)}&agentId=${encodeURIComponent(agentId)}`,
            { credentials: "include", method: "DELETE" },
          )
        : await fetch("/api/plugins/grants", {
            body: JSON.stringify({ agentId, kind: "skill", ref: slug }),
            credentials: "include",
            headers: { "content-type": "application/json" },
            method: "POST",
          });
      if (!response.ok) {
        // The server's own sentence is the operator's; the surface owns the words a person reads.
        setProblem(t("That did not go through. Try again."));
        return;
      }
      await queryClient.invalidateQueries({ queryKey: pluginKeys.all });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-2 rounded-xl bg-[var(--sand-fill-secondary)] p-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-medium text-base">{t("Skills")}</h2>
        <p className="text-muted-foreground text-sm">
          {t("A Bot carrying one offers it in the composer as /name.")}
        </p>
      </div>
      <ul className="flex flex-col gap-1">
        {mine.map((skill) => {
          const held = skill.grantedTo.includes(agentId);
          return (
            <li
              className="flex items-center gap-2 rounded-lg bg-background px-3 py-2"
              key={skill.id}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{skill.title}</span>
                <code className="truncate font-mono text-muted-foreground text-xs">
                  /{skill.slug}
                </code>
              </span>
              <Switch
                aria-label={skill.title}
                checked={held}
                disabled={busy === skill.slug}
                onCheckedChange={() => void toggle(skill.slug, held)}
              />
            </li>
          );
        })}
      </ul>
      {problem ? (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

/**
 * What you have already decided not to be asked about.
 *
 * The Boundaries page says which actions stop; this says which of those stops the person who owns
 * this Bot has answered in advance. It is the same widening as pressing "always allow" on a card,
 * written ahead of time and in words instead.
 *
 * ONE SENTENCE, AND THREE EXAMPLES. It used to be three paragraphs of caveat — a warning that a
 * model reads it, a warning about what the deployment forbids, and a promise that anything let
 * through is "recorded that way in the audit trail", which is a trail an owner has no screen for.
 * A control nobody dares touch is a control nobody has. The examples fill the box, because the hard
 * part is not being warned, it is knowing what a sentence like this looks like.
 *
 * SAVED ON A BUTTON, not on every keystroke: half a sentence is a different instruction from the
 * whole one, and an instruction that took effect while it was being typed would be judged in states
 * nobody meant to write.
 *
 * PATCH, not `/profile`. The merging endpoint is what a Bot's own tool posts to, and this is the
 * one field a Bot must never write.
 *
 * NOT DRAWN WHERE THIS DEPLOYMENT'S MODEL CANNOT DO IT, for the same reason the effort card is not:
 * on a model that cannot answer a yes/no inside the boundary's timeout the promise is silently
 * false — they keep being asked, exactly as if the box were empty. A Bot that already has an
 * instruction saved gets a sentence instead of nothing at all, because removing the card outright
 * would leave somebody believing a rule they wrote is in force.
 */
const AUTO_REVIEW_EXAMPLES = [
  "Reading anything on our own site is fine.",
  "Looking things up is fine. Sending anything is not.",
  "Saving a draft is fine.",
];

function AutoReviewCard({
  agentId,
  instruction,
}: {
  agentId: string;
  instruction: string;
}) {
  const queryClient = useQueryClient();
  const { data: user } = useQuery(currentUserQueryOptions());
  const { data: profile } = useQuery(agentQueryOptions(agentId));
  const updateAgent = useMutation(updateAgentMutationOptions(queryClient));
  const [draft, setDraft] = useState(instruction);
  const [saved, flashSaved] = useSavedFlash();
  const labelId = useId();
  const dirty = draft.trim() !== instruction.trim();

  if (user && !user.deployment.autoReview) {
    if (!instruction.trim()) return null;
    return (
      <section className="flex flex-col gap-1 rounded-xl bg-[var(--sand-fill-secondary)] p-3">
        <h2 className="font-medium text-base">{t("Do not ask me about")}</h2>
        <p className="text-muted-foreground text-sm">
          {t(
            "This deployment's model cannot read this at the moment, so what is written here is not being applied and you are being asked about everything. It is kept, and starts working again by itself.",
          )}
        </p>
        <p className="rounded-lg bg-background px-3 py-2 text-pretty text-sm">
          {instruction}
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-2 rounded-xl bg-[var(--sand-fill-secondary)] p-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-medium text-base" id={labelId}>
          {t("Do not ask me about")}
        </h2>
        <p className="text-muted-foreground text-sm">
          {t(
            "Write what this Bot may get on with. It is asked about everything else.",
          )}
        </p>
      </div>
      <Textarea
        aria-labelledby={labelId}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={t("Reading anything on our own site is fine.")}
        rows={3}
        value={draft}
      />
      {/* One tap writes a sentence of the right shape into the box, where it can be edited. */}
      <div className="flex flex-wrap gap-1.5">
        {AUTO_REVIEW_EXAMPLES.map((example) => (
          <button
            className="rounded-full border border-border px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:border-ring/40 hover:text-foreground"
            key={example}
            onClick={() => setDraft(t(example))}
            type="button"
          >
            {t(example)}
          </button>
        ))}
      </div>
      {dirty ? (
        <div className="flex gap-2">
          <Button
            disabled={updateAgent.isPending}
            onClick={async () => {
              if (!profile) return;
              await updateAgent.mutateAsync({
                agentId,
                // A PATCH replaces what it carries, so the fields the parser requires go back
                // unchanged — the same reason the face picker sends them.
                input: {
                  autoReview: draft.trim(),
                  name: profile.name,
                  roleDescription: profile.roleDescription,
                  title: profile.title,
                  visibility: profile.visibility,
                },
              });
              flashSaved();
            }}
            size="sm"
          >
            {updateAgent.isPending ? t("Saving…") : t("Save")}
          </Button>
          <Button
            disabled={updateAgent.isPending}
            onClick={() => setDraft(instruction)}
            size="sm"
            variant="outline"
          >
            {t("Cancel")}
          </Button>
        </div>
      ) : null}
      {saved ? (
        <p className="text-muted-foreground text-sm" role="status">
          {t("Saved")}
        </p>
      ) : null}
      {updateAgent.error ? (
        <p className="text-destructive text-sm" role="alert">
          {updateAgent.error.message}
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
