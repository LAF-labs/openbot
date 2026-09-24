import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { BotAvatarChooser } from "@/components/avatar/bot-avatar-picker";
import { ConsentLine } from "@/components/legal/consent-line";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { nextBotName } from "@/lib/agents/bot-names";
import {
  type AgentInput,
  createAgentMutationOptions,
  updateAgentMutationOptions,
} from "@/lib/agents/mutations";
import { useMyBots } from "@/lib/agents/my-bots";
import type { AgentProfile } from "@/lib/agents/queries";
import { agreeToLegal } from "@/lib/auth/consent";
import { authKeys, currentUserQueryOptions } from "@/lib/auth/queries";
import { randomBotAvatarSeed } from "@/lib/avatar/bot-avatar";
import { t } from "@/lib/i18n";
import { isImeKey } from "@/lib/ime";

/**
 * THE FIRST RUN IS ONE SCREEN: A NAME AND A FACE (2026-09-24).
 *
 * The owner: "봇 1개로 하자. 프로필 설정은 이름과 봇 프로필 이미지만 만들면 끝인 걸로(언제든지 바꿀
 * 수 있음). 무슨 일을 시킬건지도 적지 않는다. 그냥 모든걸 채팅으로 처리한다."
 *
 * It was four screens: the agreement, what kind of business this is, the places the owner uses
 * every day, and a press that made the first Bot with a name and face it chose itself. The two
 * questions are still asked — in Settings, and by the Bot in its own conversation — and nothing on
 * this screen asks what the Bot is for, because there is no answer to give: it is for whatever it
 * is asked.
 *
 * The name is filled in and the face is already one, so the only thing anybody HAS to do here is
 * press 시작하기; both are changed later on the Bot's profile. The agreement is the sentence under
 * the button, recorded by the same press — a stamp with no sentence in front of it would be a
 * consent nobody gave.
 *
 * A person who closed the laptop after the Bot was made but before the stamp landed comes back to
 * this screen with a Bot already: the screen starts from that Bot's name and face and saves over
 * it rather than asking the server for a second, which it would refuse.
 */
export const Route = createFileRoute("/_authed/welcome")({
  component: Welcome,
});

function Welcome() {
  const { data: user } = useQuery(currentUserQueryOptions());
  const mine = useMyBots();

  // Somebody who is past the first run and has their Bot has nothing to do here.
  if (user?.onboarded && mine.bots && mine.bots.length > 0) {
    return <Navigate replace to="/" />;
  }

  return (
    <main className="flex h-svh w-full items-center justify-center overflow-y-auto bg-background p-4 sm:p-8">
      <div className="my-auto flex w-full max-w-sm flex-col gap-6">
        {mine.bots ? (
          /*
           * Keyed on the Bot it starts from, so the fields take that Bot's name and face the moment
           * the roster says there is one, instead of keeping the defaults they were first drawn with.
           */
          <FirstRunForm
            existing={mine.bots[0]}
            key={mine.bots[0]?.id ?? "new"}
          />
        ) : mine.isError ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-destructive text-sm" role="alert">
              {t("Your Bot could not be loaded.")}
            </p>
            <Button onClick={() => mine.refetch()} variant="outline">
              {t("Try again")}
            </Button>
          </div>
        ) : (
          <div aria-hidden className="flex flex-col items-center gap-4">
            <Skeleton className="size-32 rounded-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        )}
      </div>
    </main>
  );
}

function FirstRunForm({ existing }: { existing: AgentProfile | undefined }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const createAgent = useMutation(createAgentMutationOptions(queryClient));
  const updateAgent = useMutation(updateAgentMutationOptions(queryClient));
  const [name, setName] = useState(() => existing?.name ?? nextBotName());
  const [seed, setSeed] = useState(
    () => existing?.avatarSeed ?? randomBotAvatarSeed(),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameId = useId();
  /*
   * A REF, NOT `saving`, for the reason this screen has always had one: two clicks in the same
   * frame both read the render-time flag as false, and on this screen that is two creates — the
   * second of which the server now refuses in front of somebody on their first minute.
   */
  const submitting = useRef(false);

  const trimmed = name.trim();
  const canStart = trimmed.length > 0 && trimmed.length <= 80;

  const handleStart = async () => {
    if (submitting.current || !canStart) return;
    submitting.current = true;
    setSaving(true);
    setProblem(null);
    const input: AgentInput = {
      name: trimmed,
      avatarSeed: seed,
      // Kept as it is on a Bot that already had one: a PATCH replaces what it carries.
      roleDescription: existing?.roleDescription ?? "",
    };
    const outcome = await agreeToLegal(queryClient)
      .catch(() => {
        // The helper's own error is an English sentence with a status in it, for a log.
        throw new Error(t("Could not record your agreement. Try again."));
      })
      .then(() =>
        existing
          ? updateAgent.mutateAsync({ agentId: existing.id, input })
          : createAgent.mutateAsync(input),
      )
      .then(async (bot) => {
        /*
         * Marked only once the Bot exists. The other order — stamp, then create — leaves somebody
         * who closed the laptop mid-request past the gate with no Bot and no way back here.
         */
        const stamped = await fetch("/api/me/onboarded", {
          credentials: "include",
          method: "POST",
        });
        if (!stamped.ok)
          throw new Error(t("That did not go through. Try again."));
        /*
         * REFETCH, NOT INVALIDATE. Nothing on this screen observes the current user, so an
         * invalidation would leave `_authed`'s guard answering from a cache that still says
         * "not onboarded" and bounce the navigation straight back here (measured 2026-09-03).
         */
        await queryClient.refetchQueries({
          queryKey: authKeys.currentUser(),
          type: "all",
        });
        return { ok: true as const, agentId: bot.id };
      })
      .catch((caught: unknown) => ({
        ok: false as const,
        problem:
          caught instanceof Error
            ? caught.message
            : t("That did not go through. Try again."),
      }));
    if (!outcome.ok) {
      // Released only on failure: on success the screen is going away.
      submitting.current = false;
      setSaving(false);
      setProblem(outcome.problem);
      return;
    }
    // Straight into the conversation, which is where everything else happens.
    await navigate({ search: { agent: outcome.agentId }, to: "/channel/new" });
  };

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void handleStart();
      }}
    >
      <h1 className="text-center font-semibold text-2xl">
        {t("Meet your Bot")}
      </h1>

      <BotAvatarChooser disabled={saving} onSelect={setSeed} seed={seed} />

      <div className="flex flex-col gap-2">
        <Label htmlFor={nameId}>{t("Name")}</Label>
        <Input
          autoComplete="off"
          disabled={saving}
          id={nameId}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            // The Enter that accepts a Korean syllable is not the Enter that submits the form.
            if (event.key === "Enter" && isImeKey(event))
              event.preventDefault();
          }}
          value={name}
        />
      </div>

      {problem ? (
        <p className="text-center text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <Button className="w-full" disabled={saving || !canStart} type="submit">
          {saving ? t("Starting…") : t("Start")}
        </Button>
        <ConsentLine className="text-pretty text-center text-muted-foreground text-xs" />
      </div>
    </form>
  );
}
