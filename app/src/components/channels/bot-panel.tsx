import { IconClock } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ComputerView } from "@/components/computer/computer-view";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/lib/i18n";
import { routineListQueryOptions, scheduleLabel } from "@/lib/routines/queries";

/**
 * What a Bot is doing, beside what it is saying.
 *
 * The panel used to be one thing or the other: either the Bot's screen or its profile, chosen by a
 * URL flag, so watching it work meant giving up everything else about it. A colleague at a desk has
 * a screen and a schedule at the same time, and both are things you glance at while reading the
 * conversation rather than navigate to.
 *
 * The profile keeps its own pane — it is where a Bot is edited, which is a different activity from
 * watching one.
 */
export function BotPanel({
  agentId,
  name,
}: {
  agentId: string;
  /** Whose screen this is. The Bot's own name, never the conversation's. */
  name: string | undefined;
}) {
  const routines = useQuery(routineListQueryOptions());
  const mine = (routines.data ?? []).filter(
    (routine) => routine.agentId === agentId,
  );

  return (
    <div className="flex flex-col gap-6 px-4 pt-2 pb-6">
      <section className="flex flex-col gap-2">
        {/*
         * `minWidth` 0: the view's own 320px floor is wider than the 288px this pane leaves inside
         * its padding, so the thumbnail pushed the pane out to 400px from the inside. It scales to
         * whatever it is given; the floor exists for the full-size view, not for a preview.
         */}
        <ComputerView active computerId={agentId} minWidth={0} teachable />
        <p className="text-center text-muted-foreground text-xs">
          {name ? t("{name}'s screen", { name }) : t("The Bot's screen")}
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium text-muted-foreground text-xs">
          {t("Routines")}
        </h2>

        {routines.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : null}

        {routines.isError ? (
          <p className="text-destructive text-xs" role="alert">
            {t("Your routines could not be loaded.")}
          </p>
        ) : null}

        {!routines.isPending && !routines.isError && mine.length === 0 ? (
          /*
           * A Bot with no standing work is the normal case, so this is an empty state and not an
           * error: a sentence saying what a routine IS, then the button that makes one. It was an
           * underlined link the size of a footnote — the only way onward on this pane, drawn as
           * fine print.
           */
          <div className="flex flex-col items-center gap-3 px-2 py-4 text-center">
            <p className="text-muted-foreground text-sm">
              {t("A routine is work this Bot repeats on a schedule.")}
            </p>
            <Button
              nativeButton={false}
              render={(props) => <Link to="/routines" {...props} />}
              variant="secondary"
            >
              {t("Create a routine")}
            </Button>
          </div>
        ) : null}

        <ul className="flex flex-col gap-1">
          {mine.map((routine) => (
            <li key={routine.id}>
              <Link
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-foreground/5"
                to="/routines"
              >
                <IconClock
                  className={
                    routine.enabled
                      ? "size-4 shrink-0 text-muted-foreground"
                      : "size-4 shrink-0 text-muted-foreground/40"
                  }
                />
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {routine.name}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {routine.enabled ? scheduleLabel(routine) : t("Paused")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
