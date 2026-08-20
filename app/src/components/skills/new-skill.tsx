import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { SkillFields } from "@/components/skills/skill-fields";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";
import { pluginKeys, pluginsPageQueryOptions } from "@/lib/plugins/queries";
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
         * The server's sentence, not one invented here. It refuses for reasons this form cannot
         * check — a slug somebody else already owns is the common one — and paraphrasing that into
         * "That did not work" would throw away the only part worth reading.
         */
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "The skill could not be saved.");
      }
      return response.json();
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: pluginKeys.all }),
  });

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">{t("New skill")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "A named instruction you invoke with /. It goes on the Bots you own, and nobody else sees it.",
          )}
        </p>
      </header>

      <SkillFields
        defaultValues={emptySkillForm}
        error={clash ?? createSkill.error}
        onSubmit={async (values) => {
          const slug = values.slug.trim();
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
