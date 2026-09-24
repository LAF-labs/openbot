import { skillSlugOf } from "@shared/tools/skills";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { SkillFields } from "@/components/skills/skill-fields";
import { pageTitleClass } from "@/components/ui/page-header";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";
import { pluginKeys, pluginsPageQueryOptions } from "@/lib/plugins/queries";
import { SKILL_REFUSALS } from "@/lib/plugins/refusals";
import { refusalFrom } from "@/lib/refusals";
import { emptySkillForm, type SkillFormValues } from "@/lib/skills/form";

/**
 * Writing a skill, in the detail panel beside the list.
 *
 * The panel rather than a page of its own, so the skills you already have stay on screen while you
 * write the next one — the usual reason to open this is to make a variant of one that exists.
 */
export function NewSkill() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: plugins } = useQuery(pluginsPageQueryOptions());
  const { data: me } = useQuery(currentUserQueryOptions());
  /*
   * WITH ONE BOT, THE SKILL GOES ON IT WHEN IT IS SAVED. A skill reaches the `/` menu only through
   * a grant (`skill-agents.tsx`), and the grant was a second trip — open the skill again, press the
   * Bot's name — that nobody who had just written "/리뷰답장" knew to make, so the skill they saved
   * did nothing (UI/UX audit 0.5.3, items 9 and 11). With several Bots the choice is still theirs.
   */
  const { data: agents } = useQuery(agentListQueryOptions());
  const owned = (agents ?? []).filter((agent) => agent.mine);
  const onlyBot = owned.length === 1 ? owned[0] : undefined;
  /*
   * A SLUG YOU ALREADY OWN OVERWRITES THE SKILL BEHIND IT.
   *
   * The server upserts on slug, so writing a new skill called `/summarize` when you already have one
   * silently replaced its title, its one-liner and its whole instruction with no warning and no
   * undo. The server cannot refuse it — an upsert is the right behaviour for the edit path — so the
   * form has to be the one that notices, which it can: the roster of your skills is already loaded
   * on the page behind this panel.
   */
  const [clash, setClash] = useState<Error | null>(null);

  const createSkill = useMutation({
    mutationFn: async (values: SkillFormValues) => {
      const response = await fetch("/api/plugins/skills", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!response.ok) {
        /*
         * WHICH refusal, not "that did not work". The server refuses for reasons this form cannot
         * check — a slug somebody else already owns is the common one — and says which by code; the
         * sentence is ours. It was the server's English until 2026-09-14, and the fallback beside it
         * was English too, outside `t()`.
         */
        throw new Error(
          await refusalFrom(
            response,
            SKILL_REFUSALS,
            t("The skill could not be saved."),
          ),
        );
      }
      const saved: unknown = await response.json();
      if (onlyBot) {
        const granted = await fetch("/api/plugins/grants", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "skill",
            // What the server kept: it stores the command composed (NFC), as the form may not have.
            ref: skillSlugOf(values.slug),
            agentId: onlyBot.id,
          }),
        }).catch(() => null);
        if (!granted?.ok) {
          // Said as what happened: the skill is there and the Bot does not have it yet.
          throw new Error(
            t(
              "The skill was saved, but {name} could not be given it. Open it from the list and press {name}.",
              { name: onlyBot.name },
            ),
          );
        }
      }
      return saved;
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: pluginKeys.all }),
  });

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header>
        {/* h2: the page behind this panel already has the page's one h1. */}
        <h2 className={pageTitleClass}>{t("New skill")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {onlyBot
            ? t(
                "Something you ask {name} for often, saved under a name. {name} gets it when you save, and nobody else sees it.",
                { name: onlyBot.name },
              )
            : t(
                "A named instruction you invoke with /. It goes on the Bots you own, and nobody else sees it.",
              )}
        </p>
      </header>

      <SkillFields
        defaultValues={emptySkillForm}
        error={clash ?? createSkill.error}
        onSubmit={async (values) => {
          const slug = skillSlugOf(values.slug);
          const mine = (plugins?.skills ?? []).some(
            (skill) => skill.ownerUserId === me?.id && skill.slug === slug,
          );
          if (mine) {
            // Returned, not thrown: form-core rethrows out of handleSubmit and the panel would
            // report an unhandled rejection instead of the sentence beside the field.
            setClash(
              new Error(
                t(
                  "You already have a skill called /{slug}. Saving would replace it — open it from the list to edit it instead.",
                  { slug },
                ),
              ),
            );
            return;
          }
          setClash(null);
          await createSkill.mutateAsync(values);
          // Panel closed rather than swapped for a detail view: there is nothing more to say about a
          // skill than the form just said, and the new row is already behind it in the list.
          await navigate({ search: {}, to: "/skills" });
        }}
        submitLabel={t("Save skill")}
      />
    </div>
  );
}
