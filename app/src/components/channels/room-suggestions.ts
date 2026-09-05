/**
 * Three things to try in a brand-new room, held as English source strings.
 *
 * IN A MODULE OF ITS OWN, not beside the component that draws it. Vite's Fast Refresh refuses to
 * hot-update a file that exports both a component and something else — measured: every edit to
 * `room-intro.tsx` logged "Could not Fast Refresh (ROOM_SUGGESTIONS export is incompatible)" and
 * fell back to a full reload.
 *
 * They are strings rather than `t()` calls because a module-level `t()` would be resolved once at
 * import time, before the locale is known. Read through `t()` at the point of use — which is why
 * `i18n-coverage.test.ts` cannot see them, it only walks a literal call, and why
 * `room-intro.test.ts` walks this table instead the way `agent-presets.test.ts` walks its own.
 */
export const ROOM_SUGGESTIONS = [
  "What should we look at first today?",
  "Each of you say what you would take on.",
  "Sum up where things stand.",
] as const;
