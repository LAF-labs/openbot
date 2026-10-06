/**
 * Hand-rolled, gettext-style: the English source string is the key.
 *
 * The dictionary approach the previous LAF client proved out. No i18n
 * framework — the runtime is a lookup and a template substitution, small
 * enough to read in one sitting, and adding a language is adding one file.
 *
 * Locale changes reload the page instead of re-rendering in place. A settings
 * toggle is not a hot path, and reload means `t()` can be a plain function
 * with no hook, no context and no provider — which is what makes sweeping a
 * hundred call sites bearable.
 */
import { ko } from "./i18n-ko";
import { own } from "./own";

export type Locale = "system" | "en" | "ko";

const STORAGE_KEY = "laf.locale";
/** False under test runners: this module must import cleanly without a DOM. */
const inBrowser = typeof document !== "undefined";

function storedLocale(): Locale {
  if (!inBrowser) {
    return "system";
  }
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value === "en" || value === "ko" || value === "system") {
      return value;
    }
  } catch {
    // Private browsing throws; the default answers.
  }
  return "system";
}

function resolve(locale: Locale): "en" | "ko" {
  if (locale === "system") {
    const language = typeof navigator === "undefined" ? "" : navigator.language;
    return language?.toLowerCase().startsWith("ko") ? "ko" : "en";
  }
  return locale;
}

/** The choice as stored (may be "system"), for the settings control. */
export const localeSetting: Locale = storedLocale();
/** The language actually rendered this page load. */
export const activeLocale: "en" | "ko" = resolve(localeSetting);

if (inBrowser) {
  document.documentElement.lang = activeLocale;
}

export function setLocaleSetting(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Nothing to persist into; the reload still applies it for this tab.
  }
  window.location.reload();
}

/**
 * The Korean for a source string, where the dictionary itself holds one.
 *
 * By its own keys (`./own`): `ko["constructor"]` is a function, and a string from outside does
 * reach `t()` as its key — `?connected=constructor` on the connections screen said
 * "function Object() { [native code] }에 연결했어요", and a custom server's title is drawn the
 * same way. Apart from `t()` so that a test can ask it in a runner whose language is English.
 */
export function koreanFor(source: string): string | undefined {
  return own(ko, source);
}

/**
 * Translate an English source string, with optional `{name}` substitutions.
 * A missing entry falls back to the English source — untranslated is a to-do,
 * never a crash and never a blank.
 */
export function t(
  source: string,
  params?: Record<string, string | number>,
): string {
  let text = activeLocale === "ko" ? (koreanFor(source) ?? source) : source;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      /*
       * Through a function, so the value is put in as it is. Given as a string it is a replacement
       * PATTERN: `$$` is one dollar, `$&` the slot's own name. A value is a Bot's name, a file's, and
       * since 2026-10-02 what a person typed to answer a card — "$$ 정도" was drawn "$ 정도".
       */
      text = text.replaceAll(`{${name}}`, () => String(value));
    }
  }
  return text;
}
