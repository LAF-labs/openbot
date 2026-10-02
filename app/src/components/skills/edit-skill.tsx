import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ReadNotice } from "@/components/layout/read-states";
import { SkillAgents } from "@/components/skills/skill-agents";
import { SkillFields } from "@/components/skills/skill-fields";
import { pageTitleClass } from "@/components/ui/page-header";
import { t } from "@/lib/i18n";
import { pluginKeys, pluginsPageQueryOptions } from "@/lib/plugins/queries";
import { SKILL_REFUSALS } from "@/lib/plugins/refusals";
import { readLineOf } from "@/lib/read-line";
import { settledOf, useReading } from "@/lib/reading";
import { refusalFrom } from "@/lib/refusals";
import type { SkillFormValues } from "@/lib/skills/form";

/**
 * Editing a skill, in the same panel that writes one.
 *
 * THERE IS NO EDIT ENDPOINT, AND NONE IS NEEDED. `POST /api/plugins/skills` upserts on the slug:
 * `installSkill` does `onConflictDoUpdate` and deliberately leaves `owner_user_id` alone, so a
 * re-save changes the words and never quietly changes whose skill it is. The route has already
 * refused anyone editing a skill that is not theirs before it gets that far.
 */
export function EditSkill({ slug }: { slug: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const page = useQuery(pluginsPageQueryOptions());
  /*
   * NO LIST IS NOT A MISSING SKILL. This read `data` and `isPending` alone, and `isPending` goes
   * false on a failed read exactly as on an answer: a 500 or a dropped connection drew "That skill
   * no longer exists, or it is not yours to edit." beside the page's own "could not be loaded", to
   * somebody whose skill is still on the server. The page learned this already (`skills.tsx`);
   * upstream OpenBot #665. A refresh that failed keeps what was read before, so the form stays.
   */
  const reading = useReading(page);
  const settled = settledOf(reading);

  /*
   * Read from the list already on screen rather than fetched again. It is the same request the page
   * behind this panel just made, so react-query serves it from cache and the form is filled on the
   * first frame instead of flashing empty fields at somebody who came here to change one word.
   */
  const skill = settled?.data.skills.find(
    (candidate) => candidate.slug === slug,
  );

  const saveSkill = useMutation({
    mutationFn: async (values: SkillFormValues) => {
      const response = await fetch("/api/plugins/skills", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!response.ok) {
        throw new Error(
          await refusalFrom(
            response,
            SKILL_REFUSALS,
            t("The skill could not be saved."),
          ),
        );
      }
      return response.json();
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: pluginKeys.all }),
  });

  if (!settled) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
        <ReadNotice
          line={readLineOf(reading, {
            failed: t("This skill could not be loaded."),
            notHere: t("Skills are not offered here."),
          })}
          onRetry={() => void page.refetch()}
        />
        {reading.state === "loading" ? (
          <p className="text-muted-foreground text-sm">{t("Loading…")}</p>
        ) : null}
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
        <p className="text-muted-foreground text-sm">
          {/*
           * Said plainly rather than shown as an empty form. A skill can be missing because it
           * was deleted in another tab, or because the link names one that is somebody else's —
           * and an empty form here would invite them to write it back into existence under a
           * slug they may not own.
           */}
          {t("That skill no longer exists, or it is not yours to edit.")}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header>
        {/* h2: the page behind this panel already has the page's one h1. */}
        <h2 className={pageTitleClass}>{t("Edit skill")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Changes apply the next time {command} is used. Bots already carrying it keep it.",
            { command: `/${skill.slug}` },
          )}
        </p>
      </header>

      <SkillFields
        defaultValues={{
          slug: skill.slug,
          title: skill.title,
          summary: skill.summary ?? "",
          instructions: skill.instructions,
        }}
        error={saveSkill.error}
        /*
         * Passed down rather than rendered after the form, so it lands above Save changes. Granting
         * still saves on its own the instant a button is pressed — `SkillFields` keeps it out of the
         * form's state and only decides where it sits.
         */
        footer={<SkillAgents grantedTo={skill.grantedTo} slug={skill.slug} />}
        onSubmit={async (values) => {
          await saveSkill.mutateAsync(values);
          await navigate({ search: {}, to: "/skills" });
        }}
        slugLocked
        submitLabel={t("Save changes")}
      />
    </div>
  );
}
