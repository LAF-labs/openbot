import { type ComponentProps, lazy, Suspense } from "react";

/**
 * Shared markdown rendering for Bot prose and tool results.
 *
 * Links open in a new tab with `noreferrer` because content can come from a model or remote MCP
 * server.
 */
export const markdownComponents = {
  a: ({ href, children, ...rest }: ComponentProps<"a">) => (
    <a
      {...rest}
      className="underline underline-offset-2 hover:no-underline"
      href={href}
      rel="noreferrer noopener"
      target="_blank"
    >
      {children}
    </a>
  ),
};

/**
 * The transcript renderer, behind a lazy boundary, for anything that is not itself a route chunk.
 *
 * Streamdown is a megabyte with Shiki's core inside it, and the build keeps it out of the first
 * screen only as long as nothing on the way to that screen imports it statically. The transcript
 * and the help and legal pages are route components — split by the router into chunks fetched on
 * the way there — so they may import it directly. A tool renderer registered by the CopilotKit
 * provider is not: `import { Streamdown }` in `plugin-tools.tsx` put the whole renderer back into
 * every signed-in screen's first load (audit A4, finding 5), which is why this exists.
 *
 * The fallback is the text itself: a tool result arriving before the renderer has is still worth
 * reading, and a blank where an answer just landed reads as the answer having failed.
 */
const Renderer = lazy(async () => {
  const [{ Streamdown }, { markdownPlugins }] = await Promise.all([
    import("streamdown"),
    import("@/lib/markdown-plugins"),
  ]);
  function Rendered({ children }: { children: string }) {
    return (
      <Streamdown components={markdownComponents} plugins={markdownPlugins}>
        {children}
      </Streamdown>
    );
  }
  return { default: Rendered };
});

export const LazyMarkdown = ({ children }: { children: string }) => (
  <Suspense fallback={<span className="whitespace-pre-wrap">{children}</span>}>
    <Renderer>{children}</Renderer>
  </Suspense>
);
