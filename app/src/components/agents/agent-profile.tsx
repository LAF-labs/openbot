import { IconDots, IconPencil } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { AgentFields } from "@/components/agents/agent-fields";
import { Mascot } from "@/components/agents/mascot";
import { MascotPicker } from "@/components/agents/mascot-picker";
import { ConfirmDialog } from "@/components/layout/confirm-dialog";
import { NotificationPermission } from "@/components/notifications/notification-permission";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { focusRing } from "@/components/ui/focus";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AUTO_REVIEW_EXAMPLES } from "@/lib/agents/auto-review";
import { type BotMenuItem, botMenuItems } from "@/lib/agents/bot-menu";
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
  type AgentProfile as AgentProfileRecord,
  agentKeys,
  agentMemoriesQueryOptions,
  agentQueryOptions,
} from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";
import { josa } from "@/lib/josa";
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
            aria-label={t("Change the face")}
            className={`group relative w-full overflow-hidden rounded-2xl border border-border transition hover:border-ring/40 ${focusRing}`}
            onClick={() => setPickingFace(true)}
            type="button"
          >
            {banner}
            {/*
             * THE ONLY THING THAT SAID THIS WAS A BUTTON WAS THE CURSOR.
             *
             * A 190px drawing with a hairline round it looks like a picture of the Bot, because that
             * is what it is everywhere else in the product. The label appears on hover AND on
             * keyboard focus — `group-focus-visible` — so it is not a mouse-only affordance, and it
             * sits over the bottom of the tile rather than beside it, where it would push the name
             * down the pane for everybody who already knows.
             */}
            <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-gradient-to-t from-black/45 to-transparent px-2 pt-6 pb-2 text-white text-xs opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
              <IconPencil className="size-3.5" />
              {t("Change the face")}
            </span>
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
            // Left open on purpose — see `bot-intro-card.tsx`. One press applies; 완료 closes.
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
                items={botMenuItems(profile, seats)}
                name={profile.name}
                onChoose={async (id) => {
                  if (id === "edit") {
                    setEditingId(agentId);
                    return;
                  }
                  if (id === "face") {
                    setPickingFace(true);
                    return;
                  }
                  if (id === "delete") {
                    setConfirmingDeleteId(agentId);
                    return;
                  }
                  if (id === "duplicate") {
                    const copy = await duplicateAgent.mutateAsync(agentId);
                    await navigate({
                      search: { agent: copy.id },
                      to: "/agents",
                    });
                    return;
                  }
                  await setHidden.mutateAsync({
                    agentId,
                    hidden: !profile.hidden,
                  });
                  // Hiding the Bot whose profile is open leaves the pane pointed at something the
                  // roster behind it no longer lists.
                  if (!profile.hidden)
                    await navigate({ search: {}, to: "/agents" });
                }}
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
      <ConfirmDialog
        confirmLabel={t("Delete")}
        description={t(
          "Its conversations, its routines and everything it remembers go with it. This cannot be undone.",
        )}
        onConfirm={async () => {
          await deleteAgent.mutateAsync(agentId);
          setConfirmingDeleteId(null);
          await navigate({ search: {}, to: "/agents" });
        }}
        onOpenChange={(next) => {
          if (!next) setConfirmingDeleteId(null);
        }}
        open={isConfirmingDelete}
        pending={deleteAgent.isPending}
        title={t("Delete {name}{josa}?", {
          josa: josa(profile.name, "을/를"),
          name: profile.name,
        })}
      />
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
  items,
  name,
  onChoose,
}: {
  items: BotMenuItem[];
  name: string;
  onChoose: (id: BotMenuItem["id"]) => Promise<void> | void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={t("Actions for {name}", { name })}
            size="icon"
            variant="outline"
          >
            <IconDots />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          {items.map((item) => (
            <DropdownMenuItem
              className="flex-col items-start gap-0"
              disabled={item.disabled}
              key={item.id}
              onClick={() => void onChoose(item.id)}
              variant={item.destructive ? "destructive" : "default"}
            >
              <span>{item.label}</span>
              {/*
               * THE EXPLANATION IS IN THE MENU, NOT AFTER THE PRESS. Hide's sentence used to appear
               * under the button once the Bot was already hidden, which is the one moment somebody
               * has stopped needing it; Duplicate never said anything at all about the seat it was
               * about to spend.
               */}
              <span
                className={
                  item.destructive
                    ? "text-xs opacity-80"
                    : "text-muted-foreground text-xs"
                }
              >
                {item.description}
              </span>
            </DropdownMenuItem>
          ))}
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
    <section className="flex flex-col gap-2 rounded-xl bg-muted p-3">
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
    <section className="flex flex-col gap-2 rounded-xl bg-muted p-3">
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
        {/*
         * ONE TRACK WITH ONE BORDER, AND THE CHOSEN SEGMENT MARKED THE WAY THE APP MARKS CHOSEN.
         *
         * Three outline buttons was the wrong shape for one choice out of three. Two things were
         * measured wrong with it: the selected mark was `ring-2 ring-primary` — a heavy black
         * rectangle indistinguishable from the focus ring, so a screenshot could not tell a set
         * value from a focused one — and three bordered boxes side by side put two hairlines
         * between each pair, which reads as a table rather than as a choice.
         *
         * A segmented control has ONE border, round the group. The chosen segment says so through
         * `aria-pressed`, which `Button` now styles for the whole app (`selectedWhenPressed` in
         * `ui/focus.ts`): a border in the foreground colour over a tinted ground. Inventing a fill
         * here would be a fifth dialect for "this is the one you picked" in a codebase that has
         * just finished collapsing four into one.
         */}
        <div className="flex w-full gap-0.5 rounded-lg border border-border bg-background p-0.5">
          {AGENT_EFFORTS.map((option) => {
            const chosen = option === effort;
            return (
              <Button
                aria-pressed={chosen}
                className="flex-1"
                disabled={setEffort.isPending}
                key={option}
                onClick={() => {
                  if (chosen) return;
                  setEffort.mutate({ agentId, effort: option });
                }}
                size="sm"
                variant="ghost"
              >
                {effortLabel(option)}
              </Button>
            );
          })}
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

  /*
   * Nothing is claimed before the answer arrives: "it remembers nothing" is as much a claim as a
   * list, and it was being made while the request was still in flight.
   *
   * BUT NOT `null`. Returning nothing left a card-shaped hole that filled in a moment later and
   * pushed the two cards below it down the pane — measured on a cold load, everything under
   * 기억하는 내용 jumped once the memories landed, and again when the skills did. The placeholder is
   * the same height as the card it becomes.
   */
  if (isPending) {
    return (
      <section className="flex flex-col gap-2 rounded-xl bg-muted p-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-9 w-full rounded-lg" />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-2 rounded-xl bg-muted p-3">
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
  /*
   * A card's worth of height while the answer is in flight, then either the list or nothing at all.
   *
   * Nothing to grant and nothing to say is a real state — the Skills page is where a first one gets
   * written — but it is only knowable once the request lands, and `null` in the meantime made the
   * pane shift under whoever was reading it.
   */
  if (isPending) {
    return (
      <section className="flex flex-col gap-2 rounded-xl bg-muted p-3">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-9 w-full rounded-lg" />
      </section>
    );
  }
  if (mine.length === 0) return null;

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
    <section className="flex flex-col gap-2 rounded-xl bg-muted p-3">
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
      <section className="flex flex-col gap-1 rounded-xl bg-muted p-3">
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
    <section className="flex flex-col gap-2 rounded-xl bg-muted p-3">
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
            className={`rounded-full border border-border px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:border-ring/40 hover:text-foreground ${focusRing}`}
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
    <section className="flex items-start gap-3 rounded-xl bg-muted p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="font-medium text-base" id={labelId}>
          {t("Notifications")}
        </h2>
        <p className="text-muted-foreground text-sm">
          {/* 「김비서이(가)」 was on this card, measured in the browser. See `lib/josa.ts`. */}
          {t("Tell me when {name} finishes or needs me.", {
            josa: josa(name, "이/가"),
            name,
          })}
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
