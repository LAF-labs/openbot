import { isOlderThanItsFolder } from "@shared/file-scope";
import type { ChannelSummary } from "@/lib/channels/queries";
import { t } from "@/lib/i18n";

/**
 * PROJECTS: THE OTHER CONVERSATIONS A PERSON HAS WITH THEIR BOT (2026-10-10, record §3, piece
 * 4-2). The Bot's main conversation is one and always there (`agents/my-bots.ts`
 * `conversationOf`); a project is one a person made beside it, by a name, for something worked
 * on over days. Same Bot; its own record.
 *
 * WHAT A PROJECT IS, IS WHAT THE SERVER SAYS (`channels.kind`). Nothing here guesses one from its
 * age or its name: a server from before the column says of none of them that it is a project, and
 * then there are none to list.
 */

/** This Bot's projects, in the order the list came in: last spoken in first. */
export function projectsOf(
  agentId: string,
  channels: readonly ChannelSummary[] | undefined,
): ChannelSummary[] {
  return (Array.isArray(channels) ? channels : []).filter(
    (channel) =>
      channel?.kind === "project" &&
      Array.isArray(channel.agentIds) &&
      channel.agentIds.length === 1 &&
      channel.agentIds[0] === agentId,
  );
}

/** Whether this conversation is a project, by what it says it is. */
export function isProject(
  channel: Pick<ChannelSummary, "kind"> | null | undefined,
): boolean {
  return channel?.kind === "project";
}

/**
 * What a project is called: the person's own name for it — or, where they gave none, the words
 * for that. The server stores the name as given and an empty one empty; these words are the
 * surface's.
 */
export function projectName(channel: { name?: unknown }): string {
  const name = typeof channel.name === "string" ? channel.name.trim() : "";
  return name || t("Untitled project");
}

/**
 * What deleting a project takes, said before the press (`routes/_authed/_app/projects.tsx`).
 *
 * A project's files go with it since it has a folder of its own (`@shared/file-scope`). One older
 * than its folder holds files nothing can tell are its own — what it downloaded and wrote went in
 * the Bot's folder beside everything else — and those stay: said here, where the person can still
 * decide, and not after.
 */
export function projectDeletionWords(project: { createdAt: string }): string {
  const goes = t(
    "The project, everything said in it and the files made in it go. What your Bot learned there stays.",
  );
  return isOlderThanItsFolder(project.createdAt)
    ? `${goes} ${t("Files made before projects had folders of their own stay in your Bot's folder.")}`
    : goes;
}
