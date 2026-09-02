import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  MASCOT_TILES,
  Mascot,
  mascotBackground,
} from "@/components/agents/mascot";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { agentInputFrom, emptyAgentForm } from "@/lib/agents/form";
import { createAgentMutationOptions } from "@/lib/agents/mutations";
import {
  type AgentPreset,
  pickSuggestions,
  workPattern,
} from "@/lib/agents/presets";
import { t } from "@/lib/i18n";

/**
 * Making a colleague.
 *
 * IT USED TO BE THE EDIT FORM WITH A DIFFERENT TITLE — six fields including an AG-UI endpoint and a
 * bearer token, presented to somebody who has not yet seen a Bot answer anything. Two of those
 * fields are for connecting a Bot you host yourself, which is a thing almost nobody does and never
 * on the first one.
 *
 * So: a face, a name, and what the job is. The face is picked inline rather than behind a dialog,
 * because choosing it is the fun part and it is what makes the roster yours. A suggestion
 * underneath fills every one of them at once, for anybody who would rather start from a job that
 * already exists than invent one — six at a time out of thirty-two, one per kind of work, because a
 * catalogue gets read and a handful gets taken.
 *
 * Connecting your own endpoint has not gone anywhere — it is on the Bot's profile, where it belongs:
 * an existing colleague being pointed somewhere else.
 */
export function NewAgent() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createAgent = useMutation(createAgentMutationOptions(queryClient));

  const [avatarSeed, setAvatarSeed] = useState(MASCOT_TILES[0]?.id ?? "r0c1");
  /*
   * Chosen once, in an initialiser. Calling `pickSuggestions()` in the render body would deal a new
   * six on every keystroke in the name field — the cards a person was reading would move while they
   * read them. `Show me others` is the only thing that redeals.
   */
  const [suggestions, setSuggestions] = useState(() => pickSuggestions(6));
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState("");

  /*
   * A NAME IS ALL THAT IS ASKED. A bot starts with nothing set and can become anything; the
   * description is what it will be, and a person who does not know that yet should be able to make
   * the bot anyway and find out by talking to it. A bot created with no description opens by asking
   * what it is for.
   */
  const ready = name.trim().length > 0;

  /*
   * The translated text, not the English source. A preset is a starting point for a Bot's own name,
   * title and standing instruction — the words a person will read on the roster for as long as the
   * Bot exists, and the words the model is given. Filling the form with the key rather than the
   * translation would show a Korean card that produces an English colleague.
   */
  const applyPreset = (preset: AgentPreset) => {
    setAvatarSeed(preset.avatarSeed);
    setName(t(preset.name));
    setTitle(t(preset.title));
    setRole(t(preset.roleDescription));
  };

  return (
    <form
      className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!ready || createAgent.isPending) return;
        const agent = await createAgent.mutateAsync({
          // `agentInputFrom` shapes the edit form, which has an endpoint and a key this screen
          // deliberately does not ask for. The face is the one field it adds.
          ...agentInputFrom({
            ...emptyAgentForm,
            name: name.trim(),
            // Not asked for here — a preset may carry one, and the profile screen edits it later.
            title: title.trim(),
            roleDescription: role.trim(),
          }),
          avatarSeed,
        });
        // The panel swaps to the new colleague's profile; the roster behind it has the new card.
        await navigate({ search: { agent: agent.id }, to: "/agents" });
      }}
    >
      {/* The face, big, on its own ground — the same way it will appear everywhere else. */}
      <div className="flex flex-col items-center gap-4">
        <span
          className="inline-flex size-20 items-end justify-center overflow-hidden rounded-full ring-1 ring-border"
          style={{ background: mascotBackground(avatarSeed) }}
        >
          <Mascot
            className="size-full object-cover"
            seed={avatarSeed}
            size={80}
          />
        </span>

        {/* `aria-pressed` toggles, matching the picker dialog: one selection state, one grammar. */}
        <fieldset className="flex max-w-md flex-wrap justify-center gap-1.5">
          <legend className="sr-only">{t("Pick a face")}</legend>
          {MASCOT_TILES.map((tile) => (
            <button
              aria-label={t(tile.name)}
              aria-pressed={tile.id === avatarSeed}
              className={
                "size-8 overflow-hidden rounded-lg ring-offset-2 ring-offset-background transition hover:scale-110" +
                (tile.id === avatarSeed
                  ? " ring-2 ring-primary"
                  : " ring-1 ring-border")
              }
              key={tile.id}
              onClick={() => setAvatarSeed(tile.id)}
              style={{ background: tile.background }}
              type="button"
            >
              <Mascot className="size-full" seed={tile.id} size={32} />
            </button>
          ))}
        </fieldset>
      </div>

      <Field>
        <FieldLabel htmlFor="new-bot-name">{t("Name")}</FieldLabel>
        <Input
          autoFocus
          id="new-bot-name"
          onChange={(event) => setName(event.target.value)}
          placeholder={t("Expense Manager")}
          value={name}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="new-bot-role">
          {t("What should this Bot help with?")}{" "}
          <span className="font-normal text-muted-foreground">
            {t("(Optional)")}
          </span>
        </FieldLabel>
        <Textarea
          id="new-bot-role"
          onChange={(event) => setRole(event.target.value)}
          placeholder={t(
            "Review receipts, categorize expenses, and prepare reimbursement reports.",
          )}
          rows={3}
          value={role}
        />
        <p className="text-muted-foreground text-sm">
          {t(
            "This is what the Bot is for. Leave it blank and it will ask you itself. You can change it any time.",
          )}
        </p>
      </Field>

      {createAgent.error ? (
        <p className="text-destructive text-sm" role="alert">
          {createAgent.error.message}
        </p>
      ) : null}

      <Button
        className="w-full"
        disabled={!ready || createAgent.isPending}
        type="submit"
      >
        {createAgent.isPending ? t("Creating…") : t("Get started")}
      </Button>

      <section className="flex flex-col gap-3 border-border border-t pt-6">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="font-medium text-muted-foreground text-xs">
            {t("Suggestions")}
          </h2>
          <button
            className="text-muted-foreground text-xs underline-offset-4 transition-colors hover:text-foreground hover:underline"
            onClick={() => setSuggestions(pickSuggestions(6))}
            type="button"
          >
            {t("Show me others")}
          </button>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
          {suggestions.map((preset) => {
            const pattern = workPattern(preset.pattern);
            return (
              <button
                className="flex items-start gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-ring/40"
                key={preset.id}
                onClick={() => applyPreset(preset)}
                type="button"
              >
                <span
                  className="inline-flex size-8 shrink-0 overflow-hidden rounded-lg"
                  style={{ background: mascotBackground(preset.avatarSeed) }}
                >
                  <Mascot
                    className="size-full"
                    seed={preset.avatarSeed}
                    size={32}
                  />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  {/*
                   * THE PATTERN, ABOVE THE NAME. "지출 관리" is a name somebody has to imagine a job
                   * for; "정산·대조 · 시트" is the job, in the words the business plan uses and a
                   * shop owner already thinks in. The connection beside it answers the question
                   * that always follows — what would it be using to do that.
                   */}
                  <span className="truncate text-[11px] text-muted-foreground">
                    {t(pattern.name)} · {t(pattern.connection)}
                  </span>
                  <span className="truncate font-medium text-[13px]">
                    {t(preset.name)}
                  </span>
                  <span className="line-clamp-2 text-[12px] text-muted-foreground leading-snug">
                    {t(preset.roleDescription)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </form>
  );
}
