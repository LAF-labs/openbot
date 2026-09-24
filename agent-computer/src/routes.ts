/**
 * The door: who may speak to this computer, which Bot they are speaking about, and which route
 * answers them.
 *
 * Every rule about the caller is here and nothing about a page is. What a route does is in the
 * module that owns it; the table below is the index of them.
 */
import type { Server } from "bun";
import { ACTIONS, act, upload } from "./actions";
import {
  BOT_ID_INVALID,
  isBotId,
  isOpenPath,
  matchesToken,
  offeredToken,
} from "./authorisation";
import type { BotRoute, Computer } from "./computer";
import {
  health,
  listComputers,
  resetComputer,
  stopComputer,
} from "./computer-routes";
import {
  controlState,
  releaseControl,
  requestHelp,
  requestSecret,
  supplySecret,
  takeControl,
} from "./control-routes";
import { describePoint } from "./describe-point";
import { listFiles, readFile, writeFile } from "./file-routes";
import { HUMAN_INPUT, humanInput } from "./human-input";
import type { StreamData } from "./live-screen";
import { navigate } from "./navigation";
import { readPage, screenshot, snapshot, switchTab } from "./page-routes";
import { fact } from "./respond";
import { withoutTypedAddresses } from "./typed-values";
import { whereaboutsOf } from "./whereabouts";

/** Every route that names a Bot, by `METHOD /path`. A method the table does not list is a 404. */
const BOT_ROUTES = new Map<string, BotRoute>([
  ["GET /control", controlState],
  ["POST /control/request", requestHelp],
  ["POST /control/secret", requestSecret],
  ["POST /human/secret", supplySecret],
  ["POST /control/take", takeControl],
  ["POST /control/release", releaseControl],
  ...[...HUMAN_INPUT].map((path): [string, BotRoute] => [
    `POST ${path}`,
    humanInput,
  ]),
  ["POST /computers/stop", stopComputer],
  ["POST /computers/reset", resetComputer],
  ["POST /navigate", navigate],
  ["GET /screenshot", screenshot],
  ["POST /files/read", readFile],
  ["POST /files/list", listFiles],
  ["POST /files/write", writeFile],
  ["GET /read", readPage],
  ["POST /describe-point", describePoint],
  ["POST /snapshot", snapshot],
  ["POST /tabs/switch", switchTab],
  ["POST /upload", upload],
  ...[...ACTIONS].map((path): [string, BotRoute] => [`POST ${path}`, act]),
]);

/**
 * Which Bot is asking. Null when nobody said.
 *
 * REFUSED RATHER THAN GUESSED. This used to fall back to a fixed `"shared"` computer so the
 * container stayed demonstrable on its own, and the server had a `"default"` of its own at the other
 * end — two spellings of the blank page belonging to nobody that CLAUDE.md warns about. A caller
 * that does not name a Bot is a bug in the caller, and it is told so.
 */
function botIdOf(request: Request, fallback?: string | null): string | null {
  return (
    request.headers.get("x-openbot-bot-id")?.trim() || fallback?.trim() || null
  );
}

export function computerFetch(computer: Computer) {
  return async (
    request: Request,
    server: Server<StreamData>,
  ): Promise<Response> => {
    const url = new URL(request.url);

    /*
     * Nothing below this line happens for an untrusted caller.
     *
     * `/health` is the single exception: it names no Bot, touches no browser and reports nothing but
     * whether this process is up, and a container orchestrator has to be able to ask that without
     * holding a secret.
     *
     * The websocket upgrade is checked here too. A browser cannot set headers on an upgrade, so the
     * stream carries the token as a query
     * parameter the same way it already carries the Bot.
     */
    if (
      !isOpenPath(url.pathname) &&
      !matchesToken(computer.config.token, offeredToken(request.headers, url))
    ) {
      // Says nothing about what is here. A refusal that describes the endpoint it is protecting is a
      // directory listing for whoever is knocking — so the one fact is that the token was refused.
      return fact("laf:computer_token_refused");
    }

    if (url.pathname === "/health") {
      return health(botIdOf(request), computer);
    }

    if (url.pathname === "/computers" && request.method === "GET") {
      return listComputers(computer);
    }

    /*
     * The socket carries the Bot in the query because it cannot do it in a header. Every other call
     * here names its Bot in `x-openbot-bot-id`, but a websocket client sends no custom headers on
     * the upgrade, so the stream, and only the stream, also accepts the Bot as a query parameter.
     * The header still wins where there is one, and neither is still a refusal.
     */
    const botId = botIdOf(
      request,
      url.pathname === "/stream" ? url.searchParams.get("bot") : null,
    );
    if (!botId) {
      /*
       * A CALLER THAT DOES NOT NAME A BOT GETS NOTHING.
       *
       * The fallback that used to be here put every unnamed call on one fixed profile: a browser
       * with somebody else's cookies, or a blank page belonging to nobody, and either way an answer
       * that looks like it worked. The code is a fact for the server's logs; nobody reading it is a
       * person, because the surface never makes this call without the header.
       */
      return fact("laf:bot_header_missing");
    }
    /*
     * AND IT HAS TO BE A NAME, NOT A PATH.
     *
     * Refused here, before `sessionFor` — which is the first thing that turns the id into a
     * directory, because restoring the control state reads `<profiles>/<botId>/control.json` and
     * writing it back creates the directory. `../../tmp/x` got that far and wrote the file, as
     * root. Checked again on this side rather than trusted from the server: see `isBotId`.
     */
    if (!isBotId(botId)) return fact(BOT_ID_INVALID);
    // Resolved once per request. Everything below that touches a browser, a takeover or a snapshot
    // goes through this Bot's session, so there is no path where one Bot's call reaches another's.
    const session = computer.sessions.sessionFor(botId);

    if (url.pathname === "/stream") {
      if (server.upgrade(request, { data: { botId } }))
        return undefined as unknown as Response;
      return fact("laf:stream_upgrade_required");
    }

    const route = BOT_ROUTES.get(`${request.method} ${url.pathname}`);
    if (route) {
      /*
       * WHERE THE PERSON IS, BEFORE ANYTHING OPENS A PAGE. The server names its Bot's owner's zone
       * and coarse place on every call (whereabouts.ts), so the browser this call may be about to
       * start — or the page it is about to load — is on their clock and in their place, not the
       * VM's. A call that says nothing leaves the browser as it was.
       */
      await computer.profiles.follow(whereaboutsOf(request.headers));
      /*
       * AND NO ADDRESS LEAVES CARRYING WHAT A PERSON TYPED. A form sent by GET puts its boxes in the
       * address it lands on, and that address rode out on every answer after it (audit R3-03). The
       * one place every Bot route's answer passes is here, so this is where it is blanked — and an
       * answer from a Bot nobody has typed for goes out untouched. See `typed-values.ts`.
       */
      return withoutTypedAddresses(
        session,
        await route({ request, url, botId, session }, computer),
      );
    }

    return fact("laf:computer_route_unknown");
  };
}
