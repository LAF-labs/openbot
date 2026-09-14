/**
 * The pieces every route is handed, and the shape of a request once it has named its Bot.
 *
 * Built once in `index.ts`. A value rather than module-level singletons, so no module reaches for a
 * browser or a directory it was not given.
 */
import type { ComputerConfig } from "./config";
import type { Profiles } from "./profiles";
import type { BotSession, Sessions } from "./sessions";
import type { Workspace } from "./workspace";

export type Computer = {
  config: ComputerConfig;
  /** The Bot's browser and the profile that outlives it. See profiles.ts. */
  profiles: Profiles;
  /** The Bot's durable files. See workspace.ts. */
  workspace: Workspace;
  sessions: Sessions;
};

/** A request that has passed the token and named a Bot this process will treat as a name. */
export type BotRequest = {
  request: Request;
  url: URL;
  botId: string;
  /** Resolved once per request; see sessions.ts. */
  session: BotSession;
};

export type BotRoute = (
  asked: BotRequest,
  computer: Computer,
) => Promise<Response> | Response;
