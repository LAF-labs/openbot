/**
 * WHICH CONVERSATIONS ARE PROJECTS, by thread and by channel, in memory (record §3, piece 4-2's
 * second part, 2026-10-11).
 *
 * What a run in a project writes goes in the project's own folder (`shared/file-scope.ts`), so
 * everything that files something for a run has to know whose run it is — the gateway, at every
 * act; the middleware that files a long tool result, which is not async and cannot ask the
 * database; the door an attachment arrives at. They all ask here.
 *
 * IN MEMORY, AND RIGHT TO BE: one API server process per deployment
 * (`docs/laf/deployment-model.md`), a person has at most fifty projects per Bot, and a
 * conversation is a project from the moment it is made until it is deleted — its kind is never
 * changed. Read whole at boot, before anything runs; told of a project when it is made; told when
 * it is gone. A thread it has never heard of is asked of the database once ({@link of}), which
 * is the answer for one made by another path than the one that tells it.
 */
import { eq } from "drizzle-orm";
import {
  type FileScope,
  MAIN_SCOPE,
  projectScope,
} from "../../../shared/file-scope";
import type { Database } from "../db/client";
import { channels, channelThreads } from "../db/schema";

export function createThreadProjects(database: Pick<Database, "select">) {
  /** The project a thread is: its channel's id. Null for a thread known to be no project's. */
  const byThread = new Map<string, string | null>();
  const projectChannels = new Set<string>();

  const remember = (channelId: string, threadId: string) => {
    projectChannels.add(channelId);
    byThread.set(threadId, channelId);
  };

  const scopeOf = (projectId: string | null | undefined): FileScope =>
    projectId ? projectScope(projectId) : MAIN_SCOPE;

  return {
    /** Every project there is. Called once, at boot, before any run. Answers how many. */
    async load(): Promise<number> {
      const rows = await database
        .select({ channelId: channels.id, threadId: channelThreads.threadId })
        .from(channels)
        .innerJoin(channelThreads, eq(channelThreads.channelId, channels.id))
        .where(eq(channels.kind, "project"));
      for (const row of rows) remember(row.channelId, row.threadId);
      return projectChannels.size;
    },

    /** A project has been made. */
    remember,

    /** A project is gone: its folder is, and nothing files into it again. */
    forget(channelId: string) {
      projectChannels.delete(channelId);
      for (const [threadId, held] of byThread) {
        if (held === channelId) byThread.delete(threadId);
      }
    },

    /**
     * Whose files a thread's run may touch, WITHOUT ASKING ANYTHING: what was loaded and told.
     * For the one caller that cannot wait (`copilot.ts`, filing a long result). A thread never
     * heard of is the main folder's — a routine's, a check's — which `load` and `remember` make
     * true of every thread that is not a project's.
     */
    scopeOfThread(threadId: string | undefined): FileScope {
      return scopeOf(threadId ? byThread.get(threadId) : null);
    },

    /** The same, asking the database about a thread never heard of. Throws when it cannot. */
    async of(threadId: string): Promise<string | null> {
      const known = byThread.get(threadId);
      if (known !== undefined) return known;
      const [row] = await database
        .select({ channelId: channels.id, kind: channels.kind })
        .from(channelThreads)
        .innerJoin(channels, eq(channels.id, channelThreads.channelId))
        .where(eq(channelThreads.threadId, threadId))
        .limit(1);
      const projectId = row?.kind === "project" ? row.channelId : null;
      // Only what is settled is kept: a thread with no channel yet may be given one.
      if (row) {
        if (projectId) remember(projectId, threadId);
        else byThread.set(threadId, null);
      }
      return projectId;
    },

    /** Whose files something arriving in a channel is — an attachment's readable copy. */
    scopeOfChannel(channelId: string): FileScope {
      return scopeOf(projectChannels.has(channelId) ? channelId : null);
    },
  };
}
