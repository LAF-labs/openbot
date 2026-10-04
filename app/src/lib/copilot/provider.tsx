import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import type { ReactNode } from "react";
import { ActiveBotProvider } from "./active-bot";
import { ComputerTools } from "./computer-tools";
import { GalleryTools } from "./gallery-tools";
import { PluginTools } from "./plugin-tools";
import { SandboxedTools } from "./sandboxed-tools";
import { SelfTools } from "./self-tools";
import { NowToolLine } from "./now-tool-line";
import { SkillTools } from "./skill-tools";

/**
 * The CopilotKit client, on the screens that draw a Bot's conversation.
 *
 * WHAT IT IS FOR NOW: the registry of the Bot's tools and their renderers. A conversation asks it
 * which tools this window offers, so the turn can offer the same (`buildFrontendTools`,
 * `server-channel-chat.tsx`), and the transcript draws every tool line and card through the
 * renderers registered here (`useRenderToolCall`). It runs nothing: a turn is the server's
 * (`server/src/turns/engine.ts`), and the window that ran one through this client — `runAgent`,
 * with each tool's handler carried out in the page — was removed 2026-10-05. So there is no
 * `properties` either: they were what CopilotKit forwarded with every run it started, and the
 * conversation sends the device's clock with its own hand-over.
 *
 * `runtimeUrl` and `credentials: "include"` are still load-bearing. The client asks the runtime
 * what it serves before it settles (`/api/copilotkit/info`), that route sits behind the same
 * session guard as every other, and without the cookie the answer is a 401 on every mount. The URL
 * is relative, like every other call in the app, so the Vite dev proxy and a single-origin
 * deployment both work without a build-time base URL to get wrong.
 *
 * There is no `publicApiKey`. The Intelligence key and licence token are deployment secrets held by
 * the server; a browser never sees them (see server/src/app.ts, where /api/capabilities projects the
 * runtime rather than returning it).
 */
export function CopilotProvider({ children }: { children: ReactNode }) {
  return (
    <CopilotKitProvider credentials="include" runtimeUrl="/api/copilotkit">
      {/* The tools and their cards are for the Bot the mounted surface declares. */}
      <ActiveBotProvider>
        <ComputerTools />
        <SelfTools />
        {/* Gallery cards are registered once per name, and offered by this Bot's grants. */}
        <GalleryTools />
        {/* MCP tools: the same declared Bot, and the server's own grant check on every call. */}
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
