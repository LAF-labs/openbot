import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { HUB_FACTS, HUB_PREFIX } from "../../shared/hub/protocol";
import type { Logger } from "../../shared/log";

/**
 * `PUT /hub/v1/files`, and nothing else, on a listener of its own — `node:http`, not `Bun.serve`.
 *
 * WHY: Bun 1.3.14's `Bun.serve` reads a request body off the socket as fast as it arrives, whether
 * or not the handler is reading it. Measured on the same machine, a 300 MB body streamed to a file
 * by a reader that keeps up: 773 MB resident at the peak through `Bun.serve`, 117 MB through
 * `node:http` in the same Bun with the body handed on as a web stream. `node:http` pauses the socket
 * while the stream's reader is behind, so the network waits for the disk instead of the heap holding
 * the difference. In the hub's container (512 MB) through `Bun.serve`, a 1 GB upload was killed
 * for memory and two 300 MB ones at once peaked at 502 MB; through this listener the same 1 GB
 * peaked at 172 MB resident.
 *
 * The request is handed to the SAME Hono app as every other route: the pass, the limits and the
 * trail are the ones `src/files/routes.ts` applies, and nothing about an upload is decided here.
 * The front door (hub/Caddyfile) sends `PUT /hub/v1/files` here and everything else to `Bun.serve`,
 * which keeps the websockets this listener could not serve.
 */

/** The paths served: the one route, with or without the slash Hono's routing also accepts. */
const UPLOAD_PATHS = new Set([`${HUB_PREFIX}/files`, `${HUB_PREFIX}/files/`]);

/** The request, as the Hono app reads one, with a body that pulls from the socket as it is read. */
export function toFetchRequest(incoming: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) {
      headers.append(name, one);
    }
  }
  return new Request(
    `http://${incoming.headers.host ?? "hub"}${incoming.url}`,
    {
      method: incoming.method,
      headers,
      // Node's web-stream type and the DOM's differ only in name.
      body: Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>,
      // A streamed request body: required by the fetch standard, unknown to the DOM types.
      duplex: "half",
    } as RequestInit,
  );
}

async function send(response: Response, outgoing: ServerResponse) {
  if (outgoing.destroyed) return;
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => {
    outgoing.setHeader(name, value);
  });
  // The route's answers are a few hundred bytes of JSON.
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

function refuse(outgoing: ServerResponse, status: number, code: string) {
  outgoing.statusCode = status;
  outgoing.setHeader("content-type", "application/json");
  outgoing.end(JSON.stringify({ ok: false, code }));
}

export function serveUploads(options: {
  app: { fetch(request: Request): Response | Promise<Response> };
  port: number;
  hostname?: string;
  log: Logger;
}): Promise<Server> {
  const server = createServer((incoming, outgoing) => {
    const path = (incoming.url ?? "").split("?")[0] ?? "";
    if (incoming.method !== "PUT" || !UPLOAD_PATHS.has(path)) {
      // Drained, not read: the request ends here and its body goes nowhere.
      incoming.resume();
      refuse(outgoing, 404, HUB_FACTS.notFound);
      return;
    }
    Promise.resolve(options.app.fetch(toFetchRequest(incoming)))
      .then((response) => send(response, outgoing))
      .catch((error: unknown) => {
        options.log.error("upload_failed", { error });
        if (!outgoing.headersSent && !outgoing.destroyed) {
          refuse(outgoing, 500, "laf:hub_failed");
        }
      });
  });
  // A gigabyte over a slow line is many minutes: no cap on the whole request (Node's default is
  // five), only on a socket that has gone quiet — Bun.serve's `idleTimeout` on the other listener.
  server.requestTimeout = 0;
  server.setTimeout(60_000, (socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/**
 * Stops taking connections, and resolves once the uploads already in flight have been answered — so
 * a stopping hub waits for an upload it is writing instead of closing the database under it.
 */
export function closeUploads(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
