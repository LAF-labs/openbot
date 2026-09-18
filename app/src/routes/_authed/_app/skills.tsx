import { IconDots, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { ConfirmDialog } from "@/components/layout/confirm-dialog";
import { DetailPanel } from "@/components/layout/detail-panel";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  ReadFailed,
  ReadStale,
  ReadUnavailable,
  unavailableText,
} from "@/components/layout/read-states";
import { StaggerItem } from "@/components/layout/stagger";
import { EditSkill } from "@/components/skills/edit-skill";
import { NewSkill } from "@/components/skills/new-skill";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { t } from "@/lib/i18n";
import { josa } from "@/lib/josa";
import { pluginKeys, pluginsPageQueryOptions } from "@/lib/plugins/queries";
import { SKILL_REFUSALS } from "@/lib/plugins/refusals";
import { hasFailedOutright, settledOf, useReading } from "@/lib/reading";
import { skillDeleteRecheck } from "@/lib/rechecks";
import { refusalFrom } from "@/lib/refusals";

/**
 * Personal `/` skills. They are instructions, not capabilities, and can only be granted to Bots the
 * signed-in user owns.
 */

/**
 * Writing a skill is a search parameter rather than a route, so the list stays on screen behind the
 * panel and the form is linkable, reloadable, and closed by Back — the same contract the agents
 * roster makes.
 */
const skillsSearchSchema = z
  .object({
    new: z.boolean().optional(),
    /** The slug being edited. Absent means nothing is. */
    edit: z.string().optional(),
  })
  /* `.catch({})` so `?settings=yes` is ignored rather than throwing out of
   * validateSearch and taking the whole route down with it. */
  .catch({});

export const Route = createFileRoute("/_authed/_app/skills")({
  validateSearch: skillsSearchSchema,
  component: SkillsPage,
});

function SkillsPage() {
  const queryClient = useQueryClient();
  const { new: isCreating, edit: editingSlug } = Route.useSearch();
  const navigate = Route.useNavigate();
  // Creating wins if both are somehow set: it is the more recent intent, the same rule the agents
  // roster uses when `new` and `agent` arrive together.
  const showCreate = isCreating === true;
  const showEdit = !showCreate && editingSlug !== undefined;
  const page = useQuery(pluginsPageQueryOptions());
  const { data: me } = useQuery(currentUserQueryOptions());
  /** The slug being confirmed, or null. One dialog for the page, not one per row. */
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  /*
   * The words the dialog keeps while it fades out.
   *
   * Measured: pressing 삭제 clears the slug, and the dialog spends its closing animation asking
   * "/ 를 지울까요?" — a question about nothing, in front of somebody who has just answered it. The
   * dialog is unmounted by then as far as the state is concerned; it is still on screen.
   *
   * IT KEEPS THE NAME NOW, NOT THE SLUG. `/danggeun-reply 삭제` was what the row menu offered and
   * what the question repeated: a command line in the middle of a Korean sentence, and the one part
   * of a skill its author did not choose the wording of. The name is what they wrote.
   *
   * State rather than the ref it was, which the dialog read while rendering: set in the same press
   * as the slug, it is drawn in the same render, and nothing clears it, so it outlasts the fade.
   */
  const [askedAbout, setAskedAbout] = useState("");

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: pluginKeys.all });
  /*
   * The delete, for the dialog to await. It used to close the dialog on the press and put the
   * refusal at the top of the page; the dialog now stays open until the list has been read back
   * without the skill, and says a refusal inside itself.
   */
  const remove = useMutation({
    mutationFn: async (slug: string) => {
      const response = await fetch(
        `/api/plugins/skills/${encodeURIComponent(slug)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!response.ok) {
        throw new Error(
          await refusalFrom(response, SKILL_REFUSALS, t("That did not work.")),
        );
      }
    },
    onSuccess: refresh,
  });

  /*
   * The server has ALREADY excluded skills this person may not see — `listSkills` scopes the query
   * to `owner_user_id is null or owner_user_id = me`, so somebody else's private skill is never read
   * into the process. These two lines only sort what arrived into the two things the page draws.
   *
   * ONE CASE FALLS THROUGH ON PURPOSE, FOR NOW: an administrator receives everybody's skills, and
   * another person's lands in neither list. Not a leak, but an administrator cannot see here what
   * they are entitled to. Worth an owner column or a third section before this page is called done.
   */
  const reading = useReading(page, {
    // Empty is about YOUR skills: the section below it is withheld when it has none of its own.
    isEmpty: (answer) =>
      !answer.skills.some((skill) => skill.ownerUserId === me?.id),
  });
  const settled = settledOf(reading);
  const skills = settled?.data.skills ?? [];
  const mine = skills.filter((skill) => skill.ownerUserId === me?.id);
  const deployment = skills.filter((skill) => skill.ownerUserId === null);

  return (
    <DetailPanel
      detail={
        showCreate ? (
          <NewSkill />
        ) : editingSlug ? (
          <EditSkill slug={editingSlug} />
        ) : null
      }
      onClose={() => navigate({ search: {} })}
      open={showCreate || showEdit}
    >
      <PageShell
        /*
         * THE VERB ON THE TITLE'S BASELINE, like Bots and Routines. It used to sit inside the
         * section heading as a ghost button, so of the three sibling pages this was the one whose
         * primary action was somewhere else and drawn more quietly than its peers.
         */
        action={
          <Button
            nativeButton={false}
            render={(props) => (
              <Link search={{ new: true }} to="/skills" {...props} />
            )}
            size="sm"
          >
            <IconPlus />
            {t("New skill")}
          </Button>
        }
        description={t(
          "A skill is a named instruction you invoke with / and a Bot follows. Yours are yours alone, and go on the Bots you own.",
        )}
        title={t("Skills")}
      >
        {/*
         * ONE DIALOG FOR THE PAGE. A skill is gone the moment it is deleted and any Bot carrying it
         * loses the command; asking is the same courtesy a routine and a Bot already get.
         */}
        <ConfirmDialog
          confirmLabel={t("Delete")}
          description={t(
            "The command stops working and any Bot carrying it loses it. This cannot be undone.",
          )}
          onConfirm={async () => {
            if (confirmingDelete) await remove.mutateAsync(confirmingDelete);
          }}
          onOpenChange={(next) => {
            if (!next) setConfirmingDelete(null);
          }}
          onStale={() => void refresh()}
          open={confirmingDelete !== null}
          recheck={async () =>
            confirmingDelete ? skillDeleteRecheck(confirmingDelete) : null
          }
          title={t("Delete {name}{josa}?", {
            josa: josa(askedAbout, "을/를"),
            name: askedAbout,
          })}
        />

        <PageSection title={t("Your skills")}>
          {/*
           * NOTHING WAS DRAWN WHILE THE READ WAS IN FLIGHT, AND A FAILED READ SAID THERE WERE NONE.
           *
           * `pluginsPageQueryOptions` was destructured for `data` and `isPending` only, so
           * `isError` — a 500, a dropped connection, a signed-out session — fell into the same
           * branch as an empty list: 아직 스킬이 없습니다, in front of somebody whose skills are all
           * still there. Routines and the roster both learned this already; these are their two
           * answers, in their two shapes. A failed REFRESH keeps the rows and says so quietly.
           */}
          {reading.state === "loading" ? (
            <PageRows>
              {[0, 1].map((slot) => (
                <div className="flex flex-col gap-2 p-4" key={slot}>
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-64" />
                </div>
              ))}
            </PageRows>
          ) : null}
          {hasFailedOutright(reading) ? (
            <ReadFailed
              message={t("Your skills could not be loaded.")}
              onRetry={() => void page.refetch()}
            />
          ) : null}
          {reading.state === "unavailable" ? (
            <ReadUnavailable
              message={unavailableText(
                reading.why,
                t("Skills are not offered here."),
              )}
            />
          ) : null}
          {reading.state === "failed" && reading.previous ? (
            <ReadStale
              className="mb-2"
              isRetrying={reading.isRetrying}
              onRetry={() => void page.refetch()}
            />
          ) : null}
          {/*
           * A section title over nothing at all reads as a screen that failed to load. Routines and
           * the agents roster both answer this with a face and a sentence; this is that, so the
           * three of them say "none yet" the same way.
           */}
          {settled?.state === "empty" ? (
            <div className="flex flex-col items-center gap-3 py-10">
              {/* The plainest face the generator makes: a skill is a note, not a character. */}
              <BotAvatar
                className="opacity-80"
                seed="s:pebble.gray"
                size={56}
              />
              <p className="text-center text-sm text-muted-foreground">
                {t("No skills yet. Write one and any Bot you own can run it.")}
              </p>
              {/* The way to write one, where the sentence says to — not only in the header. */}
              {showCreate ? null : (
                <Button
                  nativeButton={false}
                  render={(props) => (
                    <Link search={{ new: true }} to="/skills" {...props} />
                  )}
                  variant="secondary"
                >
                  {t("New skill")}
                </Button>
              )}
            </div>
          ) : null}
          {!!mine?.length && (
            <PageRows>
              {mine.map((skill, index) => (
                <StaggerItem index={index} key={skill.id}>
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>{skill.title}</ItemTitle>
                      {/*
                       * THE COMMAND FIRST, because it is the only part a person has to know. The title
                       * says what the skill is for; `/slug` is what they actually type, and a page that
                       * lists skills without showing how to invoke one leaves them guessing at it.
                       *
                       * The interpunct only appears when there is a summary to separate it from —
                       * a trailing "· " on a skill written without one reads as something missing.
                       */}
                      <ItemDescription>
                        {/*
                         * A CHIP, NOT BARE MONOSPACE. `/danggeun-reply` set in a mono face inside
                         * an Inter sentence reads as a typo — a different width, a different
                         * colour, no edge — and it is the one string on the row a person types.
                         */}
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground/80 text-xs">
                          /{skill.slug}
                        </code>
                        {skill.summary ? ` · ${skill.summary}` : null}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              /*
                               * Named for its row. Every skill drew the same unnamed dots button, so
                               * a person reading by name alone was offered N identical menus and
                               * only learned which one they had opened from the item inside it.
                               *
                               * By NAME, not by slug: a screen reader saying "actions for slash
                               * danggeun hyphen reply" is reading a URL out loud.
                               */
                              aria-label={t("Actions for {name}", {
                                name: skill.title,
                              })}
                              variant="ghost"
                              size="icon-sm"
                            >
                              <IconDots />
                            </Button>
                          }
                        ></DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              onClick={() =>
                                navigate({ search: { edit: skill.slug } })
                              }
                            >
                              {t("Edit")}
                            </DropdownMenuItem>
                            {/*
                             * Deleting is irreversible, so it asks — the same way deleting a routine
                             * and deleting a Bot ask. It used to go on the click: the menu item was
                             * named for its slug and that was the whole safeguard, which is no
                             * safeguard at all against the ordinary mistake of opening the menu over
                             * the wrong row. The slug stays in the label, and now in the question.
                             */}
                            <DropdownMenuItem
                              onClick={() => {
                                setAskedAbout(skill.title);
                                setConfirmingDelete(skill.slug);
                              }}
                              variant="destructive"
                            >
                              {t("Delete")}
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </ItemActions>
                  </Item>
                  {index !== mine?.length - 1 && <Separator />}
                </StaggerItem>
              ))}
            </PageRows>
          )}
        </PageSection>

        {/*
         * NO MENU ON THESE ROWS, AND THAT IS THE POINT. A workspace skill belongs to the deployment,
         * not to the person reading this page: they cannot edit it, delete it, or choose which Bots
         * carry it. Drawing the same dropdown here and refusing on click would be a worse answer than
         * not offering it — the server refuses either way, and an affordance that only ever fails is
         * a promise the page cannot keep.
         *
         * Hidden entirely when there are none, rather than shown empty: an administrator who has
         * written nothing yet is the normal case, and a permanently empty section reads as broken.
         */}
        {deployment.length > 0 ? (
          <PageSection
            description={t(
              "Written for everyone by an administrator. Which Bots carry them is decided in Admin.",
            )}
            title={t("Workspace skills")}
          >
            <PageRows>
              {deployment.map((skill, index) => (
                <StaggerItem index={index} key={skill.id}>
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>{skill.title}</ItemTitle>
                      {/*
                       * THE COMMAND FIRST, because it is the only part a person has to know. The title
                       * says what the skill is for; `/slug` is what they actually type, and a page that
                       * lists skills without showing how to invoke one leaves them guessing at it.
                       *
                       * The interpunct only appears when there is a summary to separate it from —
                       * a trailing "· " on a skill written without one reads as something missing.
                       */}
                      <ItemDescription>
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground/80 text-xs">
                          /{skill.slug}
                        </code>
                        {skill.summary ? ` · ${skill.summary}` : null}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                  {index !== deployment.length - 1 && <Separator />}
                </StaggerItem>
              ))}
            </PageRows>
          </PageSection>
        ) : null}
      </PageShell>
    </DetailPanel>
  );
}
