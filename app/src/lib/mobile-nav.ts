import { useSyncExternalStore } from "react";

/**
 * WHETHER THE SIDEBAR IS OUT OVER THE PAGE, ON A PHONE.
 *
 * Below `md` the sidebar is not a column at all (UI/UX audit 0.5.3, item 20): at 375px its 64px rail
 * was 15% of the screen, five unlabelled icons nobody could name — the cube for 스킬 least of all.
 * There it slides in over the page from a menu button in each screen's header, with every label, and
 * goes away when a place is chosen. One flag, in a store, because the button lives in the screen and
 * the sheet lives in the layout beside it.
 */
let isOpen = false;
/*
 * WHETHER THERE IS A SHEET TO OPEN AT ALL. `PageShell` draws Settings and Admin too, and those have
 * no sidebar — their own rail becomes a row of links (`rail-nav.tsx`) — so a menu button there
 * would open nothing. The sidebar says it is mounted; the button draws only while it is.
 */
let sheets = 0;
const watchers = new Set<() => void>();

function notify(): void {
  for (const watcher of watchers) watcher();
}

function set(next: boolean): void {
  if (isOpen === next) return;
  isOpen = next;
  notify();
}

/** Said by the sidebar while it is mounted; the cleanup it returns takes it back. */
export function registerMobileNav(): () => void {
  sheets += 1;
  notify();
  return () => {
    sheets -= 1;
    if (sheets === 0) isOpen = false;
    notify();
  };
}

const readAvailable = () => sheets > 0;

export function useMobileNavAvailable(): boolean {
  return useSyncExternalStore(watch, readAvailable, readOnServer);
}

export const openMobileNav = () => set(true);
export const closeMobileNav = () => set(false);

function watch(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => {
    watchers.delete(onChange);
  };
}

const read = () => isOpen;
const readOnServer = () => false;

export function useMobileNavOpen(): boolean {
  return useSyncExternalStore(watch, read, readOnServer);
}
