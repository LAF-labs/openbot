import type { ReactNode } from "react";
import { ActiveBotProvider } from "./active-bot";
import { ComputerTools } from "./computer-tools";
import { GalleryTools } from "./gallery-tools";
import { PluginTools } from "./plugin-tools";
import { SandboxedTools } from "./sandboxed-tools";
import { SelfTools } from "./self-tools";
import { NowToolLine } from "./now-tool-line";
import { SkillTools } from "./skill-tools";
import { ToolRegistryProvider } from "./tool-registry";

/**
 * The Bot's tools and their renderers, on the screens that draw a Bot's conversation.
 *
 * A conversation asks the registry which tools this window offers, so the turn can offer the same
 * (`buildFrontendTools`, `server-channel-chat.tsx`), and the transcript draws every tool line and
 * card through the renderers registered here (`useRenderToolCall`). It runs nothing: a turn is the
 * server's (`server/src/turns/engine.ts`), and the window that ran one in the page — each tool's
 * handler carried out here — was removed 2026-10-05.
 *
 * The registry is the app's own (`tool-registry.tsx`) since 2026-10-13. Until then this mounted
 * CopilotKit's client for it, which asked the server what it served on every mount
 * (`/api/copilotkit/info`); the registry asks nothing of anybody, so there is no URL and no
 * credentials here to get wrong.
 */
export function CopilotProvider({ children }: { children: ReactNode }) {
  return (
    <ToolRegistryProvider>
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
    </ToolRegistryProvider>
  );
}
