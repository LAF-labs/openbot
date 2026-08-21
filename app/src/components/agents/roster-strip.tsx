import { Link } from "@tanstack/react-router";
import { Mascot } from "@/components/agents/mascot";
import type { AgentProfile } from "@/lib/agents/queries";
import { t } from "@/lib/i18n";

/**
 * The team, as faces you can point at.
 *
 * Home and the compose screen both ask the same question — which colleague is this for — and both
 * answered it differently: Home drew a row of faces, and compose drew a combobox over an empty
 * white page. One question deserves one control, and a roster of at most a handful of characters is
 * better pointed at than typed into.
 *
 * Selection is the caller's, because the two screens do different things with it: Home aims its
 * composer, compose puts the choice in the URL.
 */
export function RosterStrip({
  roster,
  selectedId,
  onSelect,
}: {
  roster: readonly AgentProfile[];
  selectedId: string | undefined;
  onSelect: (agentId: string) => void;
}) {
  return (
    // Wraps within the composer's measure: a team of a dozen ran off the right of the screen.
    <div className="flex max-w-2xl flex-wrap items-start justify-center gap-1">
      {roster.map((agent) => {
        const chosen = agent.id === selectedId;
        return (
          <button
            aria-pressed={chosen}
            className="group flex w-[76px] flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-accent"
            key={agent.id}
            onClick={() => onSelect(agent.id)}
            type="button"
          >
            <span
              className={
                "inline-flex size-12 overflow-hidden rounded-full ring-offset-2 ring-offset-background transition-all duration-150 group-hover:scale-105" +
                (chosen ? " ring-2 ring-primary" : " ring-1 ring-border")
              }
            >
              <Mascot
                className="size-full object-cover"
                seed={agent.avatarSeed}
                size={48}
              />
            </span>
            <span
              className={
                "max-w-full truncate text-[11px] leading-tight" +
                (chosen ? " font-medium" : " text-muted-foreground")
              }
            >
              {agent.name}
            </span>
          </button>
        );
      })}
      {/* `new: true` — the tile is labelled "New agent" and so it opens the form, not the list. */}
      <Link
        className="group flex w-[76px] flex-col items-center gap-1.5 rounded-xl p-2 transition-colors hover:bg-accent"
        search={{ new: true }}
        to="/agents"
      >
        <span className="inline-flex size-12 items-center justify-center rounded-full border border-border border-dashed text-[20px] text-muted-foreground transition-transform duration-150 group-hover:scale-105">
          +
        </span>
        <span className="max-w-full truncate text-[11px] text-muted-foreground leading-tight">
          {t("New agent")}
        </span>
      </Link>
    </div>
  );
}
