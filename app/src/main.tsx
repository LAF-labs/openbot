import "@/lib/zod-jitless";
import "@/lib/i18n";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OldEngineScreen } from "./components/layout/old-engine-screen";
import { authKeys } from "./lib/auth/queries";
import { watchSession } from "./lib/auth/session-watch";
import { listenForStaleChunks } from "./lib/build-reload";
import { isEngineTooOld } from "./lib/engine-floor";
import { inShell } from "./lib/notifications/shell";
import { ignoreStrayDrops } from "./lib/stray-drop";
import {
  configureScreenErrorReports,
  listenForScreenErrors,
  routeTemplateOf,
} from "./lib/support/screen-errors";
import { buildQueryOptions } from "./lib/version";
import { queryClient } from "./query-client";
import { router } from "./router";
import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("LAF Agent could not find the application root element.");
}

/*
 * AN ENGINE TOO OLD TO DRAW A CONVERSATION IS TOLD SO, AND NOTHING OF THE APP STARTS
 * (`lib/engine-floor.ts`): no session watch, no request, no listener. Asked here, before the first
 * of them, because on such an engine every screen with a Bot's reply on it is a failed one, and a
 * person who is going to be told to update should not first be asked to sign in.
 */
if (isEngineTooOld()) {
  createRoot(rootElement).render(
    <StrictMode>
      <OldEngineScreen />
    </StrictMode>,
  );
} else {
  startApp(rootElement);
}

function startApp(root: HTMLElement) {
  // Before the first request: a session that ends is announced by whichever call meets it first.
  watchSession();

  /*
   * A PART OF THE SCREEN THAT FAILS IS REPORTED TO THIS DEPLOYMENT, and the window's own two events
   * are listened to before anything renders, so an error thrown on the way up is not missed.
   *
   * The build is the one `GET /api/version` answers, through the query the Settings footer already
   * uses: asked for only once something has failed, and then kept for the page's life. It names
   * the server's build at that moment; a page loaded before an upgrade and still open after it
   * would say the newer one, which the report cannot know better than the server does.
   */
  configureScreenErrorReports({
    route: () => routeTemplateOf(router),
    build: () => queryClient.fetchQuery(buildQueryOptions()),
    surface: () => (inShell() ? "shell" : "browser"),
    isSignedIn: () => {
      const user = queryClient.getQueryData(authKeys.currentUser());
      return typeof user === "object" && user !== null;
    },
  });
  listenForScreenErrors();
  /*
   * A PAGE FROM BEFORE A DEPLOY, asking for a chunk the new build does not have, reloads into the
   * new build once, keeping what was typed (`lib/build-reload.ts`). Listened for before anything
   * renders: the first route's own chunk can be the one that fails.
   */
  listenForStaleChunks();
  // A file let go where nothing takes it must not become the page (`lib/stray-drop.ts`).
  ignoreStrayDrops();

  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} context={{ queryClient }} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
