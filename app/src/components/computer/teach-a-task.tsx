import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type Draft,
  type Recording,
  discardRecording,
  saveAsSkill,
  slugFrom,
  writeUpRecording,
} from "@/lib/computer/demonstration";
import { focusRing } from "@/components/ui/focus";
import { t } from "@/lib/i18n";

/**
 * One row of the computer card, on the card's own left rule.
 *
 * These rows used to pad themselves 12px inwards and draw a tinted band, which put their words to
 * the right of the picture above them and of each other. The hairline says a new row has started;
 * the words start where every other row's words start.
 */
const ROW = "border-t pt-2 text-sm";

/** The house ring from `ui/focus.ts`, for the two fields this panel rolls by hand. */
const FIELD_FOCUS = focusRing;

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

  /*
   * The count while somebody is driving.
   *
   * The events are recorded on the server as they pass through the proxy, so this component never
   * sees one and has nothing to count. Without asking, the number is whatever it was when the wheel
   * was taken — which is zero, for as long as the demonstration lasts. A counter that says nothing
   * is happening while somebody works is worse than no counter: it reads as a feature that is not
   * running.
   *
   * A second is plenty. Nothing acts on this number; it is there so a person can see the recording
   * keeping up with them.
   */
  const live = Boolean(recording && !recording.finished);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void onRefresh(), 1_000);
    return () => clearInterval(timer);
  }, [live, onRefresh]);

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
      <div
        className={`flex flex-wrap items-center justify-between gap-2 ${ROW}`}
      >
        <span className="text-muted-foreground">
          {t("Record yourself doing a task, and this Bot can do it next time.")}
        </span>
        <Button
          onClick={() => void onStart()}
          size="sm"
          type="button"
          variant="outline"
        >
          {t("Teach a task")}
        </Button>
      </div>
    );
  }

  // Recording, because they still hold the wheel. See the note above on why there is no Stop.
  if (recording && !recording.finished) {
    return (
      <div
        className={`flex flex-wrap items-center justify-between gap-2 ${ROW}`}
      >
        <span>
          {/*
           * The `bg-primary/5` band that used to say "this is live" is gone with the other tinted
           * rows, and nothing coloured replaces it: `--primary` and `--foreground` are the same
           * near-black in the light theme and the same near-white in the dark one, so `text-primary`
           * here would be a class that looks like it does something and does nothing. The word is
           * bold and the number beside it climbs once a second, which is the signal.
           */}
          <strong className="font-medium">{t("Recording")}</strong>{" "}
          <span className="text-muted-foreground">
            {t("{count} steps so far. Hand back when you are done.", {
              count: String(recording.steps.length),
            })}
          </span>
        </span>
        <Button
          onClick={() => void forget()}
          size="sm"
          type="button"
          variant="outline"
        >
          {t("Discard recording")}
        </Button>
      </div>
    );
  }

  if (!recording) return null;

  if (saved) {
    return (
      <div
        className={`flex flex-wrap items-center justify-between gap-2 ${ROW}`}
      >
        <span>{t("Saved. Type /{slug} to ask for it.", { slug })}</span>
        <Button
          onClick={() => void forget()}
          size="sm"
          type="button"
          variant="outline"
        >
          {t("Done")}
        </Button>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-2 ${ROW}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span>
          {t("Recorded {count} steps.", {
            count: String(recording.steps.length),
          })}
        </span>
        <Button
          // Flush right, so it lands on the same right edge as the buttons in the rows around it.
          className="px-0 text-muted-foreground"
          onClick={() => void forget()}
          size="xs"
          type="button"
          variant="link"
        >
          {t("Discard recording")}
        </Button>
      </div>

      {/*
       * The steps as recorded, before anything is made of them. Somebody who is about to save an
       * instruction for a Bot should be able to see what it was drawn from — and a recording that
       * went wrong is obvious here and nowhere else.
       *
       * `list-inside` puts the numbers on the card's left rule instead of in a padding well 12px
       * further right, which is where the third of this card's three left edges came from.
       */}
      <ol className="max-h-40 list-inside list-decimal overflow-y-auto text-muted-foreground text-xs">
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
            className={`w-full rounded-md border bg-background px-2 py-1 text-sm ${FIELD_FOCUS}`}
            onChange={(event) =>
              setDraft({ ...draft, title: event.target.value })
            }
            value={draft.title}
          />
          <textarea
            aria-label={t("What the Bot should do")}
            className={`w-full rounded-md border bg-background px-2 py-1 font-mono text-xs ${FIELD_FOCUS}`}
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
            <Button
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
              size="sm"
              type="button"
            >
              {busy ? t("Saving…") : t("Save as a skill")}
            </Button>
          </div>
        </>
      ) : (
        <Button
          className="self-start"
          disabled={busy || recording.steps.length === 0}
          onClick={async () => {
            setBusy(true);
            setProblem(null);
            const written = await writeUpRecording(computerId);
            setBusy(false);
            if (!written.ok) {
              /*
               * The recording is still there either way, so the offer is always to press again —
               * but not always now. A provider refusing in under a second will refuse the next
               * press too, and "try again" in front of that is how a working feature comes to look
               * broken.
               */
              setProblem(
                written.retryLater
                  ? t("The model is busy. Try again in a moment.")
                  : t("The recording could not be written up. Try again."),
              );
              return;
            }
            setDraft(written.draft);
          }}
          size="sm"
          type="button"
        >
          {busy ? t("Writing it up…") : t("Turn this into a skill")}
        </Button>
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
