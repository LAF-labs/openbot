import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { primaryBot, useMyBots } from "@/lib/agents/my-bots";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { botAvatarParams, type ColorId } from "./bot-avatar";

/**
 * THE BOT'S COLOUR AS THE APP'S ACCENT.
 *
 * The face's colour is the one everything a person can press is drawn in — primary buttons, the
 * send button, focus rings, selection, links. The values live in `styles.css` as one block per
 * palette per theme (`:root[data-accent="…"]`), so all this module does is name the palette on
 * `<html>`: the attribute changes, and every `var(--primary)` in the app resolves again, with
 * nothing re-rendered and nothing reloaded.
 *
 * Nobody chooses the face, and so nobody chooses this colour, since 2026-10-08. A fixed accent is
 * still undecided (docs/laf/redesign-2026-10.md §8, 미정 1); until one is, the accent is the face's.
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

/*
 * There was a preview here, for a colour being chosen on the first run before it belonged to a Bot.
 * The first run chooses no face since 2026-10-08, so before the Bot exists there is no colour to
 * show, and the screen is drawn in the neutral control like any account without a Bot.
 */

/**
 * Keeps `<html data-accent>` on the person's Bot's palette for as long as the signed-in app is open.
 *
 * Only once the list has ANSWERED: before that, the value from the last load (put on by
 * `index.html`) is the best guess there is, and clearing it while the list is in flight is the
 * flash this whole arrangement exists to avoid. A list that answered with no Bot — the person has
 * not made one yet — does clear it, back to the neutral control.
 */
export function useBotAccent(): void {
  const mine = useMyBots();
  const { data: channels } = useQuery(channelListQueryOptions());
  const bot = mine.bots ? primaryBot(mine.bots, channels) : undefined;
  const isKnown = mine.bots !== undefined;
  const palette = accentOf(bot?.avatarSeed);
  useEffect(() => {
    if (!isKnown) return;
    applyAccent(palette);
  }, [isKnown, palette]);
}
