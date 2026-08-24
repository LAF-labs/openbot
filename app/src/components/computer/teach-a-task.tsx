import { useState } from "react";
import {
  type Draft,
  type Recording,
  discardRecording,
  saveAsSkill,
  slugFrom,
  writeUpRecording,
} from "@/lib/computer/demonstration";
import { t } from "@/lib/i18n";

/**
 * Show a Bot how a task is done by doing it once, and keep what you did.
 *
 * Grok's shape, followed as closely as this architecture allows: start, then save or discard, and
 * what you keep is a named thing you invoke with `/`. The one place it differs is where the
 * recording ends. Grok has a Stop button because it records your own screen and you might keep
 * using it; here the recording IS the wheel — nothing reaches the Bot's browser once you have
 * handed it back — so stopping and handing back are one act and one button, not two states to get
 * out of step.
 *
 * WHAT IT PRODUCES IS AN ORDINARY SKILL. Grok calls it a workflow; the fields are the same fields,
 * and ours already has a `/` menu, a catalogue and rules about who may write one. So this ends at
 * the existing skills surface rather than inventing a second kind of thing that behaves almost the
 * same.
 *
 * The panel is deliberately linear: record, read what it made of it, name it, save. Every state has
 * one obvious next thing and a way out that leaves nothing behind.
 */
export function TeachATask({
  computerId,
  driving,
  recording,
  onStart,
  onRefresh,
}: {
  computerId: string;
  /** Whether the person currently holds the wheel. */
  driving: boolean;
  /** What the server has recorded, or null when nothing is being taught. */
  recording: Recording | null;
  /** Take the wheel in teaching mode. */
  onStart: () => Promise<void>;
  /** Re-read the recording, after something here changed it. */
  onRefresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const forget = async () => {
    await discardRecording(computerId);
    setDraft(null);
    setProblem(null);
    setSaved(false);
    await onRefresh();
  };

  // Nothing recorded and not driving: the offer.
  if (!recording && !driving) {
    return (
      <div className="flex items-center justify-between gap-3 border-t px-3 py-2 text-sm">
        <span className="text-muted-foreground">
          {t("Record yourself doing a task, and this Bot can do it next time.")}
        </span>
        <button
          className="shrink-0 rounded-md border px-3 py-1 font-medium text-xs"
          onClick={() => void onStart()}
          type="button"
        >
          {t("Teach a task")}
        </button>
      </div>
    );
  }

  // Recording, because they still hold the wheel. See the note above on why there is no Stop.
  if (recording && !recording.finished) {
    return (
      <div className="flex items-center justify-between gap-3 border-t bg-primary/5 px-3 py-2 text-sm">
        <span>
          <strong className="font-medium">{t("Recording")}</strong>{" "}
          <span className="text-muted-foreground">
            {t("{count} steps so far. Hand back when you are done.", {
              count: String(recording.steps.length),
            })}
          </span>
        </span>
        <button
          className="shrink-0 rounded-md border px-3 py-1 font-medium text-xs"
          onClick={() => void forget()}
          type="button"
        >
          {t("Discard recording")}
        </button>
      </div>
    );
  }

  if (!recording) return null;

  if (saved) {
    return (
      <div className="flex items-center justify-between gap-3 border-t px-3 py-2 text-sm">
        <span>{t("Saved. Type /{slug} to ask for it.", { slug })}</span>
        <button
          className="shrink-0 rounded-md border px-3 py-1 font-medium text-xs"
          onClick={() => void forget()}
          type="button"
        >
          {t("Done")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t px-3 py-2 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span>
          {t("Recorded {count} steps.", {
            count: String(recording.steps.length),
          })}
        </span>
        <button
          className="shrink-0 text-muted-foreground text-xs underline-offset-4 hover:underline"
          onClick={() => void forget()}
          type="button"
        >
          {t("Discard recording")}
        </button>
      </div>

      {/*
       * The steps as recorded, before anything is made of them. Somebody who is about to save an
       * instruction for a Bot should be able to see what it was drawn from — and a recording that
       * went wrong is obvious here and nowhere else.
       */}
      <ol className="max-h-40 list-decimal overflow-y-auto rounded-md bg-muted/40 px-6 py-2 text-muted-foreground text-xs">
        {recording.steps.map((step, index) => (
          // Steps have no id and are never reordered: this list is a fixed record of what happened.
          // biome-ignore lint/suspicious/noArrayIndexKey: the order IS the identity here.
          <li className="py-0.5" key={index}>
            {describe(step)}
          </li>
        ))}
      </ol>

      {draft ? (
        <>
          <input
            aria-label={t("What to call it")}
            className="w-full rounded-md border bg-background px-2 py-1 text-sm"
            onChange={(event) =>
              setDraft({ ...draft, title: event.target.value })
            }
            value={draft.title}
          />
          <textarea
            aria-label={t("What the Bot should do")}
            className="w-full rounded-md border bg-background px-2 py-1 font-mono text-xs"
            onChange={(event) =>
              setDraft({ ...draft, instructions: event.target.value })
            }
            rows={8}
            value={draft.instructions}
          />
          <p className="text-muted-foreground text-xs">
            {t(
              "Read it before you save it. It was written from a recording of somebody working, so anything you did by mistake is in there too.",
            )}
          </p>
          <div className="flex items-center gap-2">
            <button
              className="rounded-md bg-primary px-3 py-1 font-medium text-primary-foreground text-xs disabled:opacity-60"
              disabled={
                busy || !draft.title.trim() || !draft.instructions.trim()
              }
              onClick={async () => {
                setBusy(true);
                setProblem(null);
                const chosen = slugFrom(draft.title);
                const result = await saveAsSkill({ ...draft, slug: chosen });
                setBusy(false);
                if (!result.ok) {
                  setProblem(
                    result.error || t("That could not be saved. Try again."),
                  );
                  return;
                }
                setSlug(chosen);
                setSaved(true);
              }}
              type="button"
            >
              {busy ? t("Saving…") : t("Save as a skill")}
            </button>
          </div>
        </>
      ) : (
        <button
          className="self-start rounded-md bg-primary px-3 py-1 font-medium text-primary-foreground text-xs disabled:opacity-60"
          disabled={busy || recording.steps.length === 0}
          onClick={async () => {
            setBusy(true);
            setProblem(null);
            const written = await writeUpRecording(computerId);
            setBusy(false);
            if (!written) {
              // The recording is still there, so the honest offer is to say so and let them press
              // it again rather than to show a procedure nobody wrote.
              setProblem(
                t("The recording could not be written up. Try again."),
              );
              return;
            }
            setDraft(written);
          }}
          type="button"
        >
          {busy ? t("Writing it up…") : t("Turn this into a skill")}
        </button>
      )}

      {problem ? (
        <p className="text-destructive text-xs" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One recorded step, in words.
 *
 * Plain and short, because this list is read as a check rather than as prose: somebody is looking
 * for the step that went wrong, not reading a story. A press with no name is said as one — the
 * page had nothing to call it, and pretending otherwise would hide the step worth looking at.
 */
function describe(step: RecordedStepLike): string {
  if (step.kind === "opened") return t("Opened {url}", { url: step.url });
  if (step.kind === "pressed") {
    return step.element?.name
      ? t("Pressed {name}", { name: step.element.name })
      : t("Pressed something with no name");
  }
  if (step.kind === "typed") {
    return step.into
      ? t("Typed into {name}", { name: step.into })
      : t("Typed something");
  }
  return t("Pressed the {key} key", { key: step.key });
}

type RecordedStepLike = Recording["steps"][number];
