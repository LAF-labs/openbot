import { IconClockPlay, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Mascot } from "@/components/agents/mascot";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { activeLocale, t } from "@/lib/i18n";

/**
 * Routines: an instruction, a Bot, and a clock.
 *
 * A routine here is a sentence, on purpose — something its owner can read back and edit — and the
 * page is built accordingly: the instruction is the biggest field on it, and a routine's row leads
 * with what it says, not with its schedule.
 */

type Routine = {
  id: string;
  agentId: string;
  name: string;
  instruction: string;
  scheduleKind: "interval" | "daily";
  intervalMinutes: number | null;
  dailyUtc: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
};

type RoutineRun = {
  id: string;
  startedAt: string;
  ok: boolean | null;
  answer: string | null;
  error: string | null;
};

async function routineRequest(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    credentials: "include",
    headers: init?.body ? { "content-type": "application/json" } : {},
    ...init,
  });
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok) {
    throw new Error(String(body?.error ?? response.statusText));
  }
  return body;
}

function scheduleLabel(routine: Routine): string {
  return routine.scheduleKind === "daily"
    ? t("Daily at {time} UTC").replace("{time}", routine.dailyUtc ?? "")
    : t("Every {minutes} minutes").replace(
        "{minutes}",
        String(routine.intervalMinutes ?? 60),
      );
}

function RunHistory({ routineId }: { routineId: string }) {
  const runs = useQuery({
    queryKey: ["routine-runs", routineId],
    queryFn: async () =>
      (await routineRequest(`/api/routines/${routineId}/runs`))
        ?.runs as RoutineRun[],
  });

  // "Never run" is a claim about the past. It must not be made while the past is still arriving.
  if (runs.isPending) {
    return (
      <p className="py-2 text-[12px] text-muted-foreground">
        {t("Loading runs…")}
      </p>
    );
  }
  if (runs.isError) {
    return (
      <div className="flex items-center gap-2 py-2">
        <p className="text-[12px] text-destructive" role="alert">
          {t("The run history could not be loaded.")}
        </p>
        <Button onClick={() => void runs.refetch()} size="sm" variant="ghost">
          {t("Try again")}
        </Button>
      </div>
    );
  }
  if (!runs.data?.length) {
    return (
      <p className="py-2 text-[12px] text-muted-foreground">
        {t("This routine has not run yet.")}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2 py-2">
      {runs.data.map((run) => (
        <li
          key={run.id}
          className="rounded-lg border border-border bg-card p-3"
        >
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{new Date(run.startedAt).toLocaleString(activeLocale)}</span>
            <span className={run.ok ? "" : "text-destructive"}>
              {run.ok ? t("Ran") : t("Failed")}
            </span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed">
            {run.ok ? run.answer : run.error}
          </p>
        </li>
      ))}
    </ul>
  );
}

function RoutineRow({ routine }: { routine: Routine }) {
  const queryClient = useQueryClient();
  const agents = useQuery(agentListQueryOptions());
  const [showRuns, setShowRuns] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["routines"] });

  /*
   * THE SWITCH MOVES WHEN IT IS CLICKED. It was driven straight off server state, so nothing
   * happened until the round trip landed — a control that ignores you for half a second reads as
   * broken, and people click it twice. The optimistic write is rolled back on failure, which is the
   * only honest way to show a switch that did not take.
   */
  const toggle = useMutation({
    mutationFn: async (enabled: boolean) =>
      routineRequest(`/api/routines/${routine.id}/enabled`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      }),
    onMutate: async (enabled: boolean) => {
      await queryClient.cancelQueries({ queryKey: ["routines"] });
      const previous = queryClient.getQueryData<Routine[]>(["routines"]);
      queryClient.setQueryData<Routine[]>(["routines"], (rows) =>
        rows?.map((row) => (row.id === routine.id ? { ...row, enabled } : row)),
      );
      return { previous };
    },
    onError: (_error, _enabled, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["routines"], context.previous);
      }
    },
    onSettled: invalidate,
  });
  const runNow = useMutation({
    mutationFn: async () =>
      routineRequest(`/api/routines/${routine.id}/run`, { method: "POST" }),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({
        queryKey: ["routine-runs", routine.id],
      });
    },
  });
  const remove = useMutation({
    mutationFn: async () =>
      routineRequest(`/api/routines/${routine.id}`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirmingDelete(false);
      invalidate();
    },
  });

  const bot = agents.data?.find((agent) => agent.id === routine.agentId);

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3 p-4">
        <span className="inline-flex size-9 shrink-0 overflow-hidden rounded-full">
          <Mascot
            className="size-full object-cover"
            seed={bot?.avatarSeed ?? routine.agentId}
            size={36}
          />
        </span>
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => setShowRuns((open) => !open)}
        >
          <div className="flex items-baseline gap-2">
            <span className="truncate font-medium text-[13px]">
              {routine.name}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {bot?.name ?? routine.agentId} · {scheduleLabel(routine)}
            </span>
          </div>
          <p className="truncate text-[12px] text-muted-foreground">
            {routine.instruction}
          </p>
        </button>
        <Button
          size="sm"
          variant="ghost"
          disabled={runNow.isPending}
          // Opened here rather than in onSuccess: the panel the answer lands in should already be
          // open while the Bot is working, or the click looks like it did nothing for a minute.
          onClick={() => {
            setShowRuns(true);
            runNow.mutate();
          }}
          aria-label={runNow.isPending ? t("Running…") : t("Run now")}
        >
          <IconClockPlay className="size-4" />
        </Button>
        <Switch
          checked={routine.enabled}
          onCheckedChange={(enabled) => toggle.mutate(enabled === true)}
          aria-label={t("Enabled")}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setConfirmingDelete(true)}
          aria-label={t("Delete")}
        >
          <IconTrash className="size-4 text-muted-foreground" />
        </Button>
      </div>
      {/*
       * A routine and every run it ever made, gone on one click of a small grey icon next to a
       * switch. It is the only irreversible thing on this page and it asked nothing.
       */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(false);
        }}
        open={confirmingDelete}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("Delete {name}?", { name: routine.name })}
            </DialogTitle>
            <DialogDescription>
              {t(
                "The schedule stops and its run history goes with it. This cannot be undone.",
              )}
            </DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <p className="text-destructive text-sm" role="alert">
              {remove.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setConfirmingDelete(false)}
              size="sm"
              variant="ghost"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
              size="sm"
              variant="destructive"
            >
              {remove.isPending ? t("Deleting…") : t("Delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {showRuns ? (
        <div className="border-border border-t px-4">
          <RunHistory routineId={routine.id} />
        </div>
      ) : null}
    </div>
  );
}

function TriggerReveal({
  routineId,
  token,
}: {
  routineId: string;
  token: string;
}) {
  const command = `curl -X POST ${window.location.origin}/api/routines/${routineId}/trigger -H "x-trigger-token: ${token}"`;
  return (
    <div className="rounded-lg border border-border bg-muted/60 p-3 text-[12px]">
      <p className="font-medium">{t("Webhook trigger — shown only once")}</p>
      <p className="mt-1 text-muted-foreground">
        {t(
          "Any system that POSTs this fires the routine (at most once per 30 seconds). The request body, if any, is handed to the Bot.",
        )}
      </p>
      <code className="mt-2 block select-all break-all rounded bg-background p-2 font-mono text-[11px]">
        {command}
      </code>
    </div>
  );
}

function NewRoutine({ onDone }: { onDone: () => void }) {
  const agents = useQuery(agentListQueryOptions());
  const [agentId, setAgentId] = useState("");
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [kind, setKind] = useState<"interval" | "daily">("daily");
  const [minutes, setMinutes] = useState("60");
  const [timeUtc, setTimeUtc] = useState("22:30");

  const [trigger, setTrigger] = useState<{
    routineId: string;
    token: string;
  } | null>(null);
  const create = useMutation({
    mutationFn: async () =>
      routineRequest("/api/routines", {
        method: "POST",
        body: JSON.stringify({
          agentId,
          name,
          instruction,
          schedule:
            kind === "daily"
              ? { kind, timeUtc }
              : { kind, minutes: Number(minutes) },
        }),
      }),
    onSuccess: (body) => {
      const routine = body?.routine as
        | { id: string; triggerToken?: string }
        | undefined;
      // The token exists only in this response; once this card is dismissed it is gone for good,
      // which is the point of hashing it server-side.
      if (routine?.triggerToken) {
        setTrigger({ routineId: routine.id, token: routine.triggerToken });
      } else {
        onDone();
      }
    },
  });

  if (trigger) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
        <TriggerReveal routineId={trigger.routineId} token={trigger.token} />
        <div className="flex justify-end">
          <Button size="sm" onClick={onDone}>
            {t("Done")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex gap-3">
        <Select
          value={agentId}
          onValueChange={(value) => setAgentId(value ?? "")}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder={t("Which Bot")} />
          </SelectTrigger>
          <SelectContent>
            {(agents.data ?? []).map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="flex-1"
          placeholder={t("Name, e.g. Morning review digest")}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <Textarea
        placeholder={t(
          "What should it do? e.g. Check the store reviews and summarize the new ones.",
        )}
        rows={3}
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
      />
      <div className="flex items-center gap-3">
        <Select
          value={kind}
          onValueChange={(value) =>
            setKind(value === "interval" ? "interval" : "daily")
          }
        >
          <SelectTrigger className="w-40">
            {/* The value is a code; the person reads the label. */}
            <SelectValue>
              {kind === "daily" ? t("Daily") : t("Every N minutes")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="daily">{t("Daily")}</SelectItem>
            <SelectItem value="interval">{t("Every N minutes")}</SelectItem>
          </SelectContent>
        </Select>
        {kind === "daily" ? (
          <Input
            className="w-28"
            value={timeUtc}
            onChange={(event) => setTimeUtc(event.target.value)}
            aria-label={t("Time (UTC)")}
          />
        ) : (
          <Input
            className="w-28"
            type="number"
            min={5}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            aria-label={t("Minutes")}
          />
        )}
        <div className="flex-1" />
        <Button
          disabled={
            !agentId || !name.trim() || !instruction.trim() || create.isPending
          }
          onClick={() => create.mutate()}
        >
          {t("Create routine")}
        </Button>
      </div>
      {create.error ? (
        <p className="text-[12px] text-destructive">{create.error.message}</p>
      ) : null}
    </div>
  );
}

function RoutinesPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const routines = useQuery({
    queryKey: ["routines"],
    queryFn: async () =>
      (await routineRequest("/api/routines"))?.routines as Routine[],
  });

  return (
    <PageShell
      title={t("Routines")}
      description={t(
        "An instruction a Bot runs on a clock — a morning digest, a daily check, a weekly summary.",
      )}
      action={
        <Button size="sm" onClick={() => setCreating((open) => !open)}>
          <IconPlus className="size-4" />
          {t("New routine")}
        </Button>
      }
    >
      {creating ? (
        <div className="mt-6">
          <NewRoutine
            onDone={() => {
              setCreating(false);
              void queryClient.invalidateQueries({ queryKey: ["routines"] });
            }}
          />
        </div>
      ) : null}
      <PageSection>
        <div className="flex flex-col gap-3">
          {/* The page was blank on a failed fetch: no rows, no snail, no explanation, nothing. */}
          {routines.isPending
            ? [0, 1, 2].map((slot) => (
                <Skeleton className="h-[74px] rounded-xl" key={slot} />
              ))
            : null}
          {routines.isError ? (
            <div className="flex flex-col items-start gap-2 py-6">
              <p className="text-[13px] text-destructive" role="alert">
                {t("Your routines could not be loaded.")}
              </p>
              <Button
                onClick={() => void routines.refetch()}
                size="sm"
                variant="outline"
              >
                {t("Try again")}
              </Button>
            </div>
          ) : null}
          {(routines.data ?? []).map((routine) => (
            <RoutineRow key={routine.id} routine={routine} />
          ))}
          {routines.data?.length === 0 && !creating ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <span className="inline-flex size-14 overflow-hidden rounded-full opacity-80">
                {/* The snail. Nothing in the set says "on a schedule, unhurried" better. */}
                <Mascot
                  className="size-full object-cover"
                  seed="r2c4"
                  size={56}
                />
              </span>
              <p className="text-center text-[13px] text-muted-foreground">
                {t(
                  "No routines yet. Give a Bot something to do every morning.",
                )}
              </p>
            </div>
          ) : null}
        </div>
      </PageSection>
    </PageShell>
  );
}

export const Route = createFileRoute("/_authed/_app/routines")({
  component: RoutinesPage,
});
