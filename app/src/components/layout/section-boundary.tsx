import {
  isScreenSection,
  SCREEN_SECTIONS,
  type ScreenSection,
} from "@shared/screen-errors";
import {
  type QueryClient,
  QueryClientContext,
  type QueryKey,
} from "@tanstack/react-query";
import {
  type AnyRouter,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
  Component,
  createContext,
  createRef,
  type ErrorInfo,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { reportScreenError } from "@/lib/support/screen-errors";
import { cn } from "@/lib/utils";

/**
 * ONE PART OF THE SCREEN FAILS, AND ONLY THAT PART.
 *
 * Until 2026-09-18 the only boundary below the router's was `ToolRenderBoundary`, around a tool's
 * card in the transcript. Anything else that threw while drawing — the roster, a Bot's profile, the
 * screen card, a Settings page — was caught by the router, which puts its error screen where the
 * whole layout was: the roster, the conversation and the pane beside it, gone together, for a
 * failure in one of them. For an app somebody keeps open all day, that is the whole working surface
 * lost to its least important corner.
 *
 * So every part of the window that can fail on its own sits in one of these, and what a failure
 * leaves behind is a sentence and a button in that part's place — the rest of the window keeps
 * working, and the failure is reported to the deployment's own server in closed facts
 * (`lib/support/screen-errors.ts`). Where each one sits, and why there, is said at each seam.
 *
 * 다시 불러오기 DRAWS THE PART AGAIN, AFTER ITS DATA IS FETCHED AGAIN. A render that failed on the
 * data it was given fails again on the same data, so pressing it first refetches what the part was
 * reading, and only then draws. What the part alone was reading has nobody watching it once the
 * part is gone, so every query with no observer is refetched — no list of each part's queries to
 * keep, which would be a list that drifts. What it shared with a part still on screen is still
 * watched, and the seam names it in `queryKeys`.
 *
 * AND IT RESETS ITSELF WHEN THE ROUTE CHANGES, so a failed part is never what somebody finds on a
 * screen they have just gone to.
 */

/** How long 다시 불러오기 waits for the data before it draws the part anyway. */
const REFETCH_WAIT_MS = 8_000;

/*
 * WHETHER A SECTION IS ABOVE — FOR THE ROUTER, WHICH OTHERWISE CATCHES A PAGE FIRST.
 *
 * TanStack Router puts a catch boundary of its own around every route it draws, with the app's
 * `defaultErrorComponent` inside it. So a page drawn through an outlet that a section wraps — the
 * pane beside the roster, a Settings page, an admin page — never reached the section when it threw:
 * the router caught it one level down and drew its whole-screen "문제가 생겼습니다" inside the pane.
 * Measured 2026-09-18 on `/routines` and on Settings → 연결, each broken by its own answer: the
 * router's sentence, in the pane, every time — while the development trigger below failed the same
 * seams correctly, because it draws beside the outlet rather than inside it.
 *
 * The router's error screen reads this (`router.tsx`) and, inside a section, throws the failure on
 * up to it — the move TanStack's own not-found boundary makes with what is not a not-found — so a
 * page that fails is caught, said, reported and brought back by the part of the window it is in.
 */
const InsideSection = createContext(false);

/** Whether the caller is drawn inside a section boundary. See `InsideSection`. */
export const useIsInsideSection = () => useContext(InsideSection);

const NO_KEYS: readonly QueryKey[] = [];

/**
 * The part's data, fetched again before it is drawn again.
 *
 * Bounded, because a request that hangs would otherwise hold the button in its busy state for as
 * long as the connection does; past the wait the part is drawn with whatever there is.
 */
async function refetchSection(
  queryClient: QueryClient | undefined,
  queryKeys: readonly QueryKey[],
): Promise<void> {
  if (!queryClient) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, REFETCH_WAIT_MS);
  });
  try {
    await Promise.race([
      Promise.all([
        queryClient.refetchQueries({ type: "inactive" }),
        ...queryKeys.map((queryKey) =>
          queryClient.refetchQueries({ queryKey }),
        ),
      ]),
      waited,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/*
 * A WAY TO MAKE A PART FAIL, FOR CHECKING THIS BY HAND — IN DEVELOPMENT, AND NEVER IN A BUILD.
 *
 * In the browser's console, `__lafFailSection("sidebar")` makes that part throw on its next draw, and
 * 다시 불러오기 clears it. Everything here is behind `import.meta.env.DEV`, which Vite replaces with
 * `false` in a production build, so the branch, the function and the global are all dropped from the
 * bundle — `bun run build` in `app` and a search of `dist/` for `__lafFailSection` is how that is
 * checked. The message it throws holds a password and a Korean sentence on purpose: the server's line
 * and the diagnostic details are then searched for both.
 */
type DevFailures = {
  isFailing: (section: ScreenSection) => boolean;
  subscribe: (listener: () => void) => () => void;
  clear: (section: ScreenSection) => void;
};

function createDevFailures(): DevFailures {
  const failing = new Set<ScreenSection>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  (window as unknown as Record<string, unknown>).__lafFailSection = (
    section?: string,
  ) => {
    if (!isScreenSection(section)) {
      return `Name one of: ${SCREEN_SECTIONS.join(", ")}`;
    }
    failing.add(section);
    notify();
    return `${section} fails on its next draw`;
  };
  return {
    isFailing: (section) => failing.has(section),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear: (section) => {
      if (failing.delete(section)) notify();
    },
  };
}

const devFailures: DevFailures | null =
  import.meta.env.DEV && typeof window !== "undefined"
    ? createDevFailures()
    : null;

const noSubscription = () => () => {};

const DevFailure = ({ section }: { section: ScreenSection }) => {
  const isFailing = useSyncExternalStore(
    devFailures?.subscribe ?? noSubscription,
    () => devFailures?.isFailing(section) ?? false,
  );
  if (isFailing) {
    throw new Error(
      `${section} was asked to fail. 비밀번호는 hunter2-canary 입니다. 사장님 리뷰에 답글 달아 줘.`,
    );
  }
  return null;
};

type BoundaryProps = {
  section: ScreenSection;
  children: ReactNode;
  queryKeys: readonly QueryKey[];
  layout: "block" | "line";
  className: string | undefined;
  /** The path on screen. A new one is a new screen, and a failed part tries again on it. */
  resetKey: string;
  queryClient: QueryClient | undefined;
};

type BoundaryState = { hasFailed: boolean; isRetrying: boolean };

class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasFailed: false, isRetrying: false };

  private readonly retryButton = createRef<HTMLButtonElement>();

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { hasFailed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    void reportScreenError(this.props.section, error, info.componentStack);
  }

  componentDidUpdate(previous: BoundaryProps, previousState: BoundaryState) {
    /*
     * Only a part that had ALREADY failed is reset by a route change. A part that failed in the same
     * update the route changed in failed on the new screen, and drawing it again at once would only
     * fail again.
     */
    if (
      previousState.hasFailed &&
      this.state.hasFailed &&
      previous.resetKey !== this.props.resetKey
    ) {
      this.reset();
      return;
    }
    /*
     * FOCUS, ONLY WHEN IT WAS LOST WITH THE PART. A keyboard user inside the part that failed is left
     * on the page's body, with nothing to say where they are; the button is the one thing here that
     * can be acted on. Somebody typing elsewhere — in the composer beside a roster that failed —
     * keeps their place.
     */
    if (!previousState.hasFailed && this.state.hasFailed) {
      const focused = document.activeElement;
      if (focused === null || focused === document.body) {
        this.retryButton.current?.focus();
      }
    }
  }

  reset() {
    devFailures?.clear(this.props.section);
    this.setState({ hasFailed: false, isRetrying: false });
  }

  handleRetry = async () => {
    if (this.state.isRetrying) return;
    this.setState({ isRetrying: true });
    await refetchSection(this.props.queryClient, this.props.queryKeys);
    this.reset();
  };

  render() {
    const { children, className, layout, section } = this.props;
    if (!this.state.hasFailed) {
      return (
        <InsideSection.Provider value={true}>
          {import.meta.env.DEV ? <DevFailure section={section} /> : null}
          {children}
        </InsideSection.Provider>
      );
    }
    return (
      <div
        className={cn(
          layout === "line"
            ? "flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2"
            : "flex flex-col items-center justify-center gap-3 p-6 text-center",
          className,
        )}
        data-failed-section={section}
      >
        <p className="text-pretty text-muted-foreground text-sm" role="alert">
          {t("This part of the screen ran into an unexpected problem.")}
        </p>
        <Button
          disabled={this.state.isRetrying}
          onClick={this.handleRetry}
          ref={this.retryButton}
          size="sm"
          variant="outline"
        >
          {this.state.isRetrying ? t("Reloading…") : t("Reload")}
        </Button>
      </div>
    );
  }
}

type SectionBoundaryProps = {
  section: ScreenSection;
  children: ReactNode;
  queryKeys?: readonly QueryKey[];
  layout?: "block" | "line";
  className?: string;
};

/** The same boundary, keyed on the path on screen — split out so its hook runs only under a router. */
const RoutedBoundary = ({
  children,
  ...props
}: Omit<BoundaryProps, "resetKey">) => {
  const resetKey = useRouterState({
    select: (state) => state.location.pathname,
  });
  return (
    <Boundary {...props} resetKey={resetKey}>
      {children}
    </Boundary>
  );
};

/**
 * A part of the window that fails on its own.
 *
 * `queryKeys` names what the part reads that a part still on screen reads too; everything only this
 * part reads is found without it (see the module note). `layout="line"` is for a strip — a banner —
 * where a block would push the screen down; `className` gives the fallback the place the part had.
 *
 * THE BOUNDARY ITSELF MUST NOT THROW, so it asks for the router and the query client in the two ways
 * that cannot: `useQueryClient()` throws where there is no provider, and so does the router's state
 * hook where there is no router. Measured: the Settings frame's own test draws the layout in a router
 * with no query client, and the first version of this boundary was the thing that failed there. In
 * the app both are always present; drawn without them, a part still gets its boundary, without the
 * route reset or the refetch it would have nothing to do them with.
 */
export const SectionBoundary = ({
  section,
  children,
  queryKeys = NO_KEYS,
  layout = "block",
  className,
}: SectionBoundaryProps) => {
  const router = useRouter({ warn: false }) as AnyRouter | undefined;
  const queryClient = useContext(QueryClientContext);
  const props = { className, layout, queryClient, queryKeys, section };
  return router ? (
    <RoutedBoundary {...props}>{children}</RoutedBoundary>
  ) : (
    <Boundary {...props} resetKey="">
      {children}
    </Boundary>
  );
};
