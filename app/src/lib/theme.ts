export const THEME_STORAGE_KEY = "openbot-theme";

/**
 * What a person chose, which is not the same as what is on screen.
 *
 * "system" is the default and the reason this is three states rather than a boolean: a machine set
 * to dark used to open this app in white, because an unset preference parsed as light. Storing the
 * CHOICE rather than the outcome is also what lets the app follow the machine when it flips at
 * sunset, instead of freezing whatever it happened to resolve to on the first visit.
 */
export type ThemePreference = "system" | "light" | "dark";

export function parseThemePreference(value: string | null): ThemePreference {
  return value === "dark" || value === "light" ? value : "system";
}

/** The choice plus what the machine says, resolved to the one bit the stylesheet needs. */
export function resolveDark(
  preference: ThemePreference,
  prefersDark: boolean,
): boolean {
  if (preference === "system") {
    return prefersDark;
  }
  return preference === "dark";
}

type ThemeEffects = {
  setStoredValue: (key: string, value: string) => void;
  toggleRootClass: (name: string, force: boolean) => void;
};

export function applyThemePreference(
  preference: ThemePreference,
  prefersDark: boolean,
  effects: ThemeEffects,
) {
  effects.setStoredValue(THEME_STORAGE_KEY, preference);
  effects.toggleRootClass("dark", resolveDark(preference, prefersDark));
}
