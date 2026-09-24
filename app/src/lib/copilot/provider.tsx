import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { type ReactNode, useState } from "react";
import { deviceClock } from "@/lib/whereabouts/queries";
import { ActiveBotProvider } from "./active-bot";
import { ComputerTools } from "./computer-tools";
import { GalleryTools } from "./gallery-tools";
import { PluginTools } from "./plugin-tools";
import { SandboxedTools } from "./sandboxed-tools";
import { SelfTools } from "./self-tools";
import { NowToolLine } from "./now-tool-line";
import { SkillTools } from "./skill-tools";

/**
 * The CopilotKit client, wrapped once for the whole authenticated app.
 *
 * `credentials: "include"` is the load-bearing part. LAF Agent authenticates with a Better Auth
 * session cookie, and the runtime endpoint sits behind the same guard as every other API route, so
 * without it every run is rejected as anonymous while the rest of the app looks signed in.
 *
 * The URL is relative, like every other call in the app, so the Vite dev proxy and a single-origin
 * deployment both work without a build-time base URL to get wrong.
 *
 * There is no `publicApiKey`. The Intelligence key and licence token are deployment secrets held by
 * the server; a browser never sees them (see server/src/app.ts, where /api/capabilities projects the
 * runtime rather than returning it).
 */
export function CopilotProvider({ children }: { children: ReactNode }) {
  /*
   * THIS DEVICE'S CLOCK, ON EVERY RUN. `properties` is what CopilotKit forwards as every run's
   * `forwardedProps`, and the server's middleware reads `device` off it to tell the Bot the time where
   * the person is (`server/src/copilot.ts`) — not the VM's, and not the deployment's default. Read
   * once per mount, in state, so a re-render does not hand CopilotKit a new object each time. The
   * account keeps a copy for the runs with no device (`_authed.tsx`, `reportDevice`).
   */
  const [properties] = useState(() => ({ device: deviceClock() }));
  return (
    <CopilotKitProvider
      credentials="include"
      properties={properties}
      runtimeUrl="/api/copilotkit"
    >
      {/* Computer tools target the Bot declared by the mounted surface. */}
      <ActiveBotProvider>
        <ComputerTools />
        <SelfTools />
        {/* Gallery tools are registered once; their handlers re-read the active Bot to avoid shadowing renderers. */}
        <GalleryTools />
        {/* MCP tools share the same active-Bot context and server-side grant checks. */}
        <PluginTools />
        {/* The Bot reading its own skills; always registered, so the tool list never moves. */}
        <SkillTools />
        {/* The `now` call agent-bot answers itself, drawn in the person's words. */}
        <NowToolLine />
        {/* Browser-authored components use the same component grants as the compiled gallery. */}
        <SandboxedTools />
        {children}
      </ActiveBotProvider>
    </CopilotKitProvider>
  );
}
