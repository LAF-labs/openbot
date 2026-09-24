import { useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { botAvatarParams, type ColorId } from "./bot-avatar";

/**
 * THE BOT'S COLOUR AS THE APP'S ACCENT.
 *
 * The person picked a colour for the face; that colour is the one everything they can press is drawn
 * in — primary buttons, the send button, focus rings, selection, links. The values live in
 * `styles.css` as one block per palette per theme (`:root[data-accent="…"]`), so all this module does
 * is name the palette on `<html>`. A colour changed on the profile reaches every control on the next
 * frame: the attribute changes, and every `var(--primary)` in the app resolves again, with nothing
 * re-rendered and nothing reloaded.
 *
 * Never the face's own value: that is too light to carry white text in light and too dark to be read
 * as text in dark. The accent is the same hue moved until it clears AA — see `--bot-accent`.
 */

/**
 * Where the last accent is kept, so `index.html` can put it on before the first paint. Without it
 * every load drew the neutral control for the moment before the Bots list answered and then
 * repainted every button in the window.
 */
export const ACCENT_STORAGE_KEY = "laf-accent";

/** The palette a face is drawn in — which is the accent — or nothing before there is a face. */
export function accentOf(seed: string | undefined): ColorId | undefined {
  if (seed === undefined) return undefined;
  return botAvatarParams(seed).palette;
}

/** Name the palette on the document, or take the name off, and remember it for the next load. */
export function applyAccent(palette: ColorId | undefined): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (palette) root.dataset.accent = palette;
  else delete root.dataset.accent;
  try {
    if (palette) window.localStorage.setItem(ACCENT_STORAGE_KEY, palette);
    else window.localStorage.removeItem(ACCENT_STORAGE_KEY);
  } catch {
    // Private browsing refuses the write; the attribute is already on, which is what matters now.
  }
}

/**
 * A colour being CHOSEN, before it belongs to a Bot — the first-run picker. Held here rather than
 * applied by the picker itself, because the shell's own `useBotAccent` runs its effect after every
 * child's and would take a preview straight back off: with no Bot yet, the list says "no accent".
 */
let preview: ColorId | undefined;
const previewWatchers = new Set<() => void>();

function setPreview(next: ColorId | undefined): void {
  if (preview === next) return;
  preview = next;
  for (const watcher of previewWatchers) watcher();
}

function watchPreview(onChange: () => void): () => void {
  previewWatchers.add(onChange);
  return () => {
    previewWatchers.delete(onChange);
  };
}

const readPreview = () => preview;

/**
 * Keeps `<html data-accent>` on the person's Bot's palette for as long as the signed-in app is open.
 *
 * Only once the list has ANSWERED: before that, the value from the last load (put on by
 * `index.html`) is the best guess there is, and clearing it while the list is in flight is the
 * flash this whole arrangement exists to avoid. A list that answered with no Bot — the person has
 * not made one yet — does clear it, back to the neutral control, unless a colour is being chosen.
 */
export function useBotAccent(): void {
  const mine = useMyBots();
  const { data: channels } = useQuery(channelListQueryOptions());
  const previewing = useSyncExternalStore(
    watchPreview,
    readPreview,
    readPreview,
  );
  const bot = mine.bots ? primaryBot(mine.bots, channels) : undefined;
  const isKnown = mine.bots !== undefined || previewing !== undefined;
  const palette = previewing ?? accentOf(bot?.avatarSeed);
  useEffect(() => {
    if (!isKnown) return;
    applyAccent(palette);
  }, [isKnown, palette]);
}

/** Draws the app in a colour while it is being picked, and hands back to the Bot's on the way out. */
export function useAccentPreview(seed: string | undefined): void {
  const palette = accentOf(seed);
  useEffect(() => {
    setPreview(palette);
    return () => setPreview(undefined);
  }, [palette]);
}
