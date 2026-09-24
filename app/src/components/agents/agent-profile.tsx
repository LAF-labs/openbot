import { IconPencil } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Mascot } from "@/components/agents/mascot";
import { BotAvatarPicker } from "@/components/avatar/bot-avatar-picker";
import { ConfirmDialog } from "@/components/layout/confirm-dialog";
import { LiveRegion } from "@/components/layout/live-region";
import { ReadNotice } from "@/components/layout/read-states";
import { NotificationPermission } from "@/components/notifications/notification-permission";
import { Button } from "@/components/ui/button";
import { focusRing } from "@/components/ui/focus";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { AUTO_REVIEW_EXAMPLES } from "@/lib/agents/auto-review";
import {
  AGENT_EFFORTS,
  type AgentEffort,
  effortLabel,
} from "@/lib/agents/effort-label";
import {
  deleteAgentMutationOptions,
  setAgentEffortMutationOptions,
  setAgentPreferencesMutationOptions,
  updateAgentMutationOptions,
} from "@/lib/agents/mutations";
import {
  agentKeys,
  agentMemoriesQueryOptions,
  agentQueryOptions,
} from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { ensure } from "@/lib/ensure";
import { t } from "@/lib/i18n";
import { isImeKey } from "@/lib/ime";
import { josa } from "@/lib/josa";
import { pluginKeys, pluginsPageQueryOptions } from "@/lib/plugins/queries";
import { readLineOf } from "@/lib/read-line";
import { settledOf, useReading } from "@/lib/reading";
import { botDeleteRecheck } from "@/lib/rechecks";
import { useSavedFlash } from "@/lib/saved-flash";

/**
 * The shape of the profile, not a generic one: the face's tile, then the name.
 */
function ProfileSkeleton() {
  return (
    <>
      <header className="flex flex-col items-center gap-3">
        <Skeleton className="h-[132px] w-full rounded-2xl" />
        <Skeleton className="h-9 w-full" />
      </header>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </>
  );
}

/**
 * A BOT'S PROFILE IS ITS NAME AND ITS FACE (2026-09-24).
 *
 * The owner: "프로필 설정은 이름과 봇 프로필 이미지만 만들면 끝인 걸로(언제든지 바꿀 수 있음). 무슨
 * 일을 시킬건지도 적지 않는다." The job title under the name, the "how it works" paragraph and the
 * row of kinds of work to pick from are gone from here and from every other screen: what the Bot
 * is for is settled by talking to it. The rows still hold what older Bots were given, and the
 * server still accepts them; nothing on the surface writes or shows them.
 *
 * WHAT STAYS BELOW THE NAME IS NOT PROFILE, IT IS HOW THE BOT BEHAVES: how hard it thinks, what it
 * may do without asking, what it remembers, the skills it holds, and whether it may notify. None of
 * those can be set by chatting — the one about asking must never be (CLAUDE.md, "Never let a Bot
 * write the rule that decides whether it gets asked about") — so they keep their controls.
 */
export function AgentProfile({
  agentId,
  className = "p-8 pt-6",
}: {
  agentId: string;
  /** The pane's own padding. The profile page sits inside a page that already has one. */
  className?: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // State is keyed by the Bot's id because this panel can remain open while its target changes.
  const [pickingFace, setPickingFace] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const isConfirmingDelete = confirmingDeleteId === agentId;

  const agent = useQuery(agentQueryOptions(agentId));
  const updateAgent = useMutation(updateAgentMutationOptions(queryClient));
  const deleteAgent = useMutation(deleteAgentMutationOptions(queryClient));

  /*
   * A REFRESH THAT FAILED USED TO TAKE THE WHOLE PROFILE WITH IT. What was read stays now, under a
   * quiet line (measured 2026-09-18).
   */
  const reading = useReading(agent, {
    // The same answer for "deleted" and "not yours", on purpose (`server/src/agents/routes.ts`).
    unavailable: { "laf:agent_not_found": "not_allowed" },
  });
  const settled = settledOf(reading);
  const notice = (
    <ReadNotice
      className="py-0"
      line={
        reading.state === "unavailable" &&
        reading.code === "laf:agent_not_found"
          ? { kind: "unavailable", message: t("This Bot is no longer here.") }
          : readLineOf(reading, {
              failed: t("Could not load this Bot."),
              notHere: t("Bots are not offered here."),
            })
      }
      onRetry={() => void agent.refetch()}
    />
  );
  if (!settled) {
    return (
      <div className={`flex w-full flex-col gap-6 ${className}`}>
        {notice}
        {reading.state === "loading" ? <ProfileSkeleton /> : null}
      </div>
    );
  }

  const profile = settled.data;

  /*
   * A NEUTRAL TILE, WITH THE COLOUR IN THE CHARACTER. The face carries its own ground; painting
   * the tile the same colour behind it just spread one Bot's hue over the panel.
   */
  const banner = (
    <span
      aria-hidden="true"
      className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-[var(--sand-bg-subtle)]"
    >
      <span className="inline-flex overflow-hidden rounded-[32px] transition-transform duration-200 group-hover:scale-[1.03]">
        <Mascot seed={profile.avatarSeed} size={128} />
      </span>
    </span>
  );

  /*
   * A PATCH replaces the fields it carries, so the ones the parser requires go back unchanged —
   * the title and the description included, which nothing here shows but an older Bot may hold.
   * `endpoint` is deliberately absent: an absent one leaves the stored configuration alone.
   */
  const save = (patch: { name?: string; avatarSeed?: string }) =>
    updateAgent.mutateAsync({
      agentId,
      input: {
        name: profile.name,
        roleDescription: profile.roleDescription,
        title: profile.title,
        ...patch,
      },
    });

  return (
    <div className={`flex w-full flex-col gap-6 ${className}`}>
      {notice}
      <header className="flex flex-col items-center gap-3 text-center">
        {/*
         * The face is the control. A Bot the deployment shipped is not editable here at all — the
         * server refuses — so it offers nothing it cannot deliver.
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
             * The label appears on hover AND on keyboard focus, over the bottom of the tile, in the
             * theme's own ground and ink so it reads on the near-white tile in light mode too.
             */}
            <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-gradient-to-t from-background via-background/80 to-transparent px-2 pt-6 pb-2 text-foreground text-xs opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
              <IconPencil className="size-3.5" />
              {t("Change the face")}
            </span>
          </button>
        ) : (
          <span className="group w-full overflow-hidden rounded-2xl border border-border">
            {banner}
          </span>
        )}
        <BotAvatarPicker
          onOpenChange={setPickingFace}
          // Left open on purpose: one press applies, 완료 closes.
          onSelect={(avatarSeed) => save({ avatarSeed })}
          open={pickingFace}
          pending={updateAgent.isPending}
          seed={profile.avatarSeed}
        />

        {profile.canManage ? (
          /* Keyed on the stored name, so a rename saved elsewhere replaces what the field shows. */
          <NameField
            key={`${agentId}:${profile.name}`}
            name={profile.name}
            onSave={(name) => save({ name })}
          />
        ) : (
          <h1 className="w-full text-balance font-semibold text-2xl leading-tight tracking-tight">
            {profile.name}
          </h1>
        )}
      </header>

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
       * LAST, QUIET, AND ASKED IN A DIALOG. With one Bot, deleting it is starting again: the next
       * screen is the first run, which makes a new one.
       */}
      {profile.canManage ? (
        <div className="flex justify-center">
          <Button
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmingDeleteId(agentId)}
            size="sm"
            variant="ghost"
          >
            {t("Delete this Bot")}
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        confirmLabel={t("Delete")}
        description={t(
          "Its conversations, its routines and everything it remembers go with it. This cannot be undone.",
        )}
        onConfirm={async () => {
          await deleteAgent.mutateAsync(agentId);
          await navigate({ to: "/" });
        }}
        onOpenChange={(next) => {
          if (!next) setConfirmingDeleteId(null);
        }}
        // Deleted elsewhere while this was open: the app goes on without it.
        onStale={() => {
          void queryClient.invalidateQueries({ queryKey: agentKeys.all });
          void navigate({ to: "/" });
        }}
        open={isConfirmingDelete}
        recheck={() => botDeleteRecheck(agentId)}
        title={t("Delete {name}{josa}?", {
          josa: josa(profile.name, "을/를"),
          name: profile.name,
        })}
      />
    </div>
  );
}

/**
 * The name, as a field that saves when it is left.
 *
 * Saved on blur and on Enter, the way the card on a new Bot's first conversation used to save it —
 * a name is one word, and a Save button beside one word is a second thing to find. Escape puts the
 * stored name back. An empty or unchanged name saves nothing.
 */
function NameField({
  name,
  onSave,
}: {
  name: string;
  onSave: (name: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(name);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, flashSaved] = useSavedFlash();
  const labelId = useId();

  const commit = async () => {
    const next = draft.trim();
    if (!next || next === name) {
      setDraft(name);
      return;
    }
    setProblem(null);
    await onSave(next).then(
      () => flashSaved(),
      (caught: unknown) =>
        setProblem(
          caught instanceof Error
            ? caught.message
            : t("That was not saved. Try again."),
        ),
    );
  };

  return (
    <div className="flex w-full flex-col items-center gap-1">
      <label className="sr-only" htmlFor={labelId}>
        {t("Name")}
      </label>
      <Input
        className={`h-auto border-transparent bg-transparent px-2 py-1 text-center font-semibold text-2xl leading-tight tracking-tight shadow-none hover:border-border focus-visible:bg-muted/60 md:text-2xl ${focusRing}`}
        id={labelId}
        maxLength={80}
        onBlur={() => void commit()}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // The Enter that accepts a Korean syllable is not the Enter that finishes the name.
          if (isImeKey(event)) return;
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setDraft(name);
        }}
        value={draft}
      />
      {/* Mounted with the field, so 저장됨 is heard when it is said (`LiveRegion`). */}
      <LiveRegion as="p" className="text-muted-foreground text-xs">
        {saved ? t("Saved") : null}
      </LiveRegion>
      <LiveRegion as="p" className="text-destructive text-xs" tone="alert">
        {problem}
      </LiveRegion>
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
  const memories = useQuery(agentMemoriesQueryOptions(agentId));
  const [forgetting, setForgetting] = useState<string | null>(null);
  /*
   * "IT REMEMBERS NOTHING" IS A CLAIM, and until 2026-09-18 two things that are not nothing made it:
   * a read that failed, and a deployment with no memory store at all (`laf:not_found` — which the
   * server sends precisely so a screen will not say "nothing yet" for a Bot that cannot learn).
   * Both measured saying 아직 없습니다 on this card.
   */
  const reading = useReading(memories, {
    unavailable: { "laf:agent_not_found": "not_allowed" },
  });
  const settled = settledOf(reading);

  const forget = (memoryId: string) => {
    setForgetting(memoryId);
    // `try`…`finally`, through `ensure`: the React Compiler cannot compile the statement itself.
    return ensure(
      async () => {
        await fetch(
          `/api/agents/${encodeURIComponent(agentId)}/memories/${encodeURIComponent(memoryId)}`,
          { credentials: "include", method: "DELETE" },
        );
        await queryClient.invalidateQueries({
          queryKey: agentKeys.memories(agentId),
        });
      },
      () => setForgetting(null),
    );
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
  const line = readLineOf(reading, {
    failed: t("What it remembers could not be loaded."),
    notHere: t(
      "Bots here do not keep what they learn between conversations, so there is nothing to show.",
    ),
  });

  // One section in every state, the notice last in it: mounted before it speaks.
  return (
    <section className="flex flex-col gap-2 rounded-xl bg-muted p-3">
      {reading.state === "loading" ? (
        <>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-9 w-full rounded-lg" />
        </>
      ) : (
        <div className="flex flex-col gap-0.5">
          <h2 className="font-medium text-base">{t("What it remembers")}</h2>
          <p className="text-muted-foreground text-sm">
            {t(
              "Things this Bot worked out about you and keeps between conversations. Only you see yours.",
            )}
          </p>
        </div>
      )}
      {settled?.state === "ready" ? (
        <ul className="flex flex-col gap-1">
          {settled.data.map((memory) => (
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
      ) : null}
      {settled?.state === "empty" ? (
        <p className="rounded-lg bg-background px-3 py-2 text-muted-foreground text-sm">
          {t("Nothing yet. What it learns about you appears here.")}
        </p>
      ) : null}
      <ReadNotice
        // "Not here" in the empty line's own box, so it and "nothing yet" read as siblings.
        className={
          line?.kind === "unavailable"
            ? "rounded-lg bg-background px-3 py-2"
            : "py-0"
        }
        line={line}
        onRetry={() => void memories.refetch()}
      />
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
  const page = useQuery(pluginsPageQueryOptions());
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const isMine = (skill: { ownerUserId: string | null }) =>
    Boolean(skill.ownerUserId) && skill.ownerUserId === me?.id;
  /*
   * NOTHING, WHETHER THERE WAS NOTHING OR THE READ FAILED. The card returned null for an empty list
   * — and, because `data` was all it read, for a list that could not be read at all — so a Bot's
   * owner could not tell "you have written none" from "this did not load", and neither said where a
   * first one is written. Each says its own thing now.
   */
  const reading = useReading(page, {
    isEmpty: (answer) => !answer.skills.some(isMine),
  });
  const settled = settledOf(reading);
  const mine = (settled?.data.skills ?? []).filter(isMine);
  const toggle = (slug: string, held: boolean) => {
    setBusy(slug);
    setProblem(null);
    // `try`…`finally`, through `ensure`: the React Compiler cannot compile the statement itself.
    return ensure(
      async () => {
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
      },
      () => setBusy(null),
    );
  };

  /*
   * One section in every state, the notice last in it, mounted before it speaks. While the answer is
   * in flight it is a card's worth of skeleton, so the pane does not shift under whoever is reading
   * it when the answer lands.
   */
  return (
    <section className="flex flex-col gap-2 rounded-xl bg-muted p-3">
      {reading.state === "loading" ? (
        <>
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-9 w-full rounded-lg" />
        </>
      ) : (
        <div className="flex flex-col gap-0.5">
          <h2 className="font-medium text-base">{t("Skills")}</h2>
          <p className="text-muted-foreground text-sm">
            {t("A Bot carrying one offers it in the composer as /name.")}
          </p>
        </div>
      )}
      {settled?.state === "empty" ? (
        <div className="flex flex-col items-start gap-2 rounded-lg bg-background px-3 py-2">
          <p className="text-muted-foreground text-sm">
            {t(
              "You have not written a skill yet. Write one on Skills, and you can give it to this Bot here.",
            )}
          </p>
          <Button
            nativeButton={false}
            render={(props) => (
              <Link search={{ new: true }} to="/skills" {...props} />
            )}
            size="sm"
            variant="secondary"
          >
            {t("New skill")}
          </Button>
        </div>
      ) : null}
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
      {/* Mounted with the card, so a switch that did not take is heard when it is said. */}
      <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
        {problem}
      </LiveRegion>
      <ReadNotice
        className="py-0"
        line={readLineOf(reading, {
          failed: t("Your skills could not be loaded."),
          notHere: t("Skills are not offered here."),
        })}
        onRetry={() => void page.refetch()}
        size="compact"
      />
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
      {/* Mounted with the card, so 저장됨 is heard when it is said (`LiveRegion`). */}
      <LiveRegion as="p" className="text-muted-foreground text-sm">
        {saved ? t("Saved") : null}
      </LiveRegion>
      <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
        {updateAgent.error?.message}
      </LiveRegion>
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
