import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  applyThemePreference,
  parseThemePreference,
  resolveDark,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@/lib/theme";

type ThemeContextValue = {
  /** What is on screen right now. */
  dark: boolean;
  /** What the person chose, which may be "system". */
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(DARK_QUERY).matches
  );
}

/** Private browsing throws on read; an unreadable store means no choice was made. */
function storedPreference(): ThemePreference {
  try {
    return parseThemePreference(
      // The pre-rename key keeps an existing person's choice; the next change
      // they make writes it under the new one.
      window.localStorage.getItem(THEME_STORAGE_KEY) ??
        window.localStorage.getItem("openbot-theme"),
    );
  } catch {
    return "system";
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] =
    useState<ThemePreference>(storedPreference);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);

  /*
   * The machine can change its mind while the app is open — every desktop OS flips at sunset — and
   * an app following "system" has to follow it then too, not only at load.
   */
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(DARK_QUERY);
    const handleChange = (event: MediaQueryListEvent) =>
      setPrefersDark(event.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    applyThemePreference(preference, prefersDark, {
      setStoredValue: (key, value) => {
        try {
          window.localStorage.setItem(key, value);
        } catch {
          // Nothing to persist into. The class below still applies for this tab.
        }
      },
      toggleRootClass: (name, force) =>
        document.documentElement.classList.toggle(name, force),
    });
  }, [preference, prefersDark]);

  return (
    <ThemeContext.Provider
      value={{
        dark: resolveDark(preference, prefersDark),
        preference,
        setPreference,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const value = useContext(ThemeContext);

  if (!value) {
    throw new Error("useTheme must be used within ThemeProvider");
  }

  return value;
}
