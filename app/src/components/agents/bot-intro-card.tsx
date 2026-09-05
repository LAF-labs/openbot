import { IconX } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Mascot } from "@/components/agents/mascot";
import { MascotPicker } from "@/components/agents/mascot-picker";
import { Button } from "@/components/ui/button";
import { updateAgentMutationOptions } from "@/lib/agents/mutations";
import {
  type AgentPreset,
  pickSuggestions,
  workPattern,
} from "@/lib/agents/presets";
import type { AgentProfile } from "@/lib/agents/queries";
import { t } from "@/lib/i18n";
import { useSavedFlash } from "@/lib/saved-flash";

/**
 * WHAT THE CREATION FORM USED TO ASK, ASKED BESIDE THE BOT INSTEAD OF INSTEAD OF IT.
 *
 * A Bot is made in one press now, so the first thing anybody sees of it is an empty conversation
 * with a stranger called 초롱. This card sits above that conversation: its face, its name, and one
 * line for what it does — every one of them optional, every one of them saved as it is typed.
 *
 * The chips are the old suggestion cards, reduced to the only part of them that was doing any work.
 * The full card carried a name, a job title, a paragraph of standing instruction and a face, which
 * is a Bot somebody else designed; the chip carries the KIND OF WORK, and filling that in is what a
 * person cannot easily do from a blank page. The name and the face stay theirs.
 *
 * Dismissible, and it does not come back. Somebody who knows what their Bot is for should be able
 * to get on with talking to it, and everything here is on the profile pane for good.
 */
export function BotIntroCard({ agent }: { agent: AgentProfile }) {
  const queryClient = useQueryClient();
  const updateAgent = useMutation(updateAgentMutationOptions(queryClient));
  const [dismissed, setDismissed] = useState(false);
  const [pickingFace, setPickingFace] = useState(false);
  const [name, setName] = useState(agent.name);
  const [title, setTitle] = useState(agent.title);
  const [saved, flashSaved] = useSavedFlash();
  /*
   * Dealt once, in an initialiser. Calling `pickSuggestions` in the render body deals a new hand on
   * every keystroke in the name field — the chips a person is reading would move while they read.
   */
  const [suggestions] = useState(() => pickSuggestions(5));

  /*
   * A PATCH REPLACES THE FIELDS IT CARRIES, so the ones the parser requires go back unchanged:
   * naming a Bot must not clear what it does, and picking a face must not rename it.
   *
   * `endpoint` is deliberately absent, for the reason the face picker records — an address that is
   * already saved and already working is re-validated as if it had just been typed, and refused on
   * any deployment that forbids private hosts.
   */
  const save = async (patch: {
    name?: string;
    title?: string;
    roleDescription?: string;
    avatarSeed?: string;
  }) => {
    await updateAgent.mutateAsync({
      agentId: agent.id,
      input: {
        name: agent.name,
        title: agent.title,
        roleDescription: agent.roleDescription,
        visibility: agent.visibility,
        ...patch,
      },
    });
    flashSaved();
  };

  const applyPreset = async (preset: AgentPreset) => {
    // The translated text, not the English key: these become the Bot's own words, shown on every
    // screen and handed to the model for as long as it exists.
    setTitle(t(preset.title));
    await save({
      roleDescription: t(preset.roleDescription),
      title: t(preset.title),
    });
  };

  if (dismissed) return null;

  return (
    /*
     * `pointer-events-auto`, AND IT IS NOT DECORATION.
     *
     * Measured in the browser: every chip and both fields were dead. `ConversationView` lays its
     * empty state over the transcript as `pointer-events-none` so an overlay can never sit between
     * somebody and the composer, and it expects a control-bearing empty state to opt back in on its
     * own element — the roster strip next door does exactly this. Without it the card renders
     * perfectly, saves nothing, and nothing anywhere reports a problem.
     */
    <section className="pointer-events-auto mx-auto flex w-full max-w-md flex-col gap-3 rounded-2xl border border-border bg-card p-4 text-left">
      <div className="flex items-start gap-3">
        {/* The face is the control: the only edit anybody wants to make to a picture is another one. */}
        <button
          aria-label={t("Pick a face")}
          className="inline-flex size-14 shrink-0 overflow-hidden rounded-xl ring-1 ring-border transition hover:ring-ring/50"
          onClick={() => setPickingFace(true)}
          type="button"
        >
          <Mascot
            className="size-full object-cover"
            seed={agent.avatarSeed}
            size={56}
          />
        </button>
        <div className="flex min-w-0 flex-1 flex-col">
          {/*
           * TYPED IN PLACE. A name given by the product is a placeholder somebody should be able to
           * overwrite where they are reading it, not after finding a settings pane — so this is the
           * heading and the field at once, saved when it loses focus.
           */}
          <input
            aria-label={t("Name")}
            className="w-full truncate rounded-md bg-transparent font-semibold text-[15px] outline-none focus-visible:bg-muted/60 focus-visible:px-1"
            onBlur={() => {
              const next = name.trim();
              if (!next || next === agent.name) {
                setName(agent.name);
                return;
              }
              void save({ name: next });
            }}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setName(agent.name);
            }}
            value={name}
          />
          <input
            aria-label={t("What it does")}
            className="w-full truncate rounded-md bg-transparent text-[13px] text-muted-foreground outline-none focus-visible:bg-muted/60 focus-visible:px-1"
            onBlur={() => {
              const next = title.trim();
              if (next === agent.title) return;
              void save({ title: next });
            }}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setTitle(agent.title);
            }}
            placeholder={t("What it does (optional)")}
            value={title}
          />
        </div>
        <Button
          aria-label={t("Close")}
          className="-mr-1 -mt-1 shrink-0"
          onClick={() => setDismissed(true)}
          size="icon-sm"
          variant="ghost"
        >
          <IconX className="size-4" />
        </Button>
      </div>

      {/*
       * NOT A CATALOGUE. Five, one per kind of work, and the label is the work rather than a name
       * somebody else invented for a Bot — "리뷰·평판" is a thing a shop owner already knows they
       * have; "리뷰 지킴이" is a character they have to imagine a job for.
       */}
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map((preset) => (
          <button
            className="rounded-full border border-border px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:border-ring/40 hover:text-foreground disabled:opacity-50"
            disabled={updateAgent.isPending}
            key={preset.id}
            onClick={() => void applyPreset(preset)}
            type="button"
          >
            {t(workPattern(preset.pattern).name)}
          </button>
        ))}
      </div>

      <p className="text-[12px] text-muted-foreground">
        {saved ? (
          /* It saved as you typed, so the only honest confirmation is a quiet one that goes away. */
          <span className="text-foreground/70">{t("Saved")}</span>
        ) : updateAgent.error ? (
          <span className="text-destructive" role="alert">
            {updateAgent.error.message}
          </span>
        ) : (
          t("Nothing here is required. You can change all of it later.")
        )}
      </p>

      <MascotPicker
        onOpenChange={setPickingFace}
        onSelect={async (avatarSeed) => {
          await save({ avatarSeed });
          setPickingFace(false);
        }}
        open={pickingFace}
        pending={updateAgent.isPending}
        seed={agent.avatarSeed}
      />
    </section>
  );
}
