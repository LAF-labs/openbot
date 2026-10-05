/**
 * A component authored in the browser rather than compiled into the build — ON THE WIRE, said once
 * for both sides.
 *
 * The server keeps one and publishes it (`server/src/components/sandboxed.ts`, which says why they
 * exist and why a draft is not what a Bot draws with); the playground edits it and a conversation
 * renders the published half (`app/src/lib/sandboxed/`). Each side used to declare its own copy of
 * both shapes, field for field.
 */

/** A component authored in the browser, as the playground edits it. */
export type SandboxedRecord = {
  name: string;
  title: string;
  draftDescription: string;
  draftHtml: string;
  draftCss: string;
  draftJsFunctions: string;
  draftArgumentSchema: Record<string, unknown>;
  publishedHtml: string | null;
  publishedCss: string | null;
  publishedJsFunctions: string | null;
  publishedArgumentSchema: Record<string, unknown> | null;
  sampleArguments: Record<string, unknown>;
  revision: number;
  published: boolean;
  publishedAt: string | null;
  authoredBy: string | null;
  hasUnpublishedChanges: boolean;
};

/**
 * What a Bot may actually draw with: the published source, or nothing at all. The draft never
 * appears here.
 */
export type PublishedSandboxed = {
  name: string;
  html: string;
  css: string;
  jsFunctions: string;
  /**
   * The arguments this component takes, as the author described them — what the model fills in.
   *
   * Without this the tool advertises no parameters, and a model told a tool takes nothing calls it
   * with nothing.
   */
  argumentSchema: Record<string, unknown>;
};
