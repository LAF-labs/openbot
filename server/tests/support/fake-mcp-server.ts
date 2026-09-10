/**
 * A Streamable HTTP MCP server with one tool, in a process of its own.
 *
 * OUT OF PROCESS ON PURPOSE. `plugin-mcp-limits.integration.test.ts` measures how much THIS process
 * grows when a server answers fifty megabytes, and a fake served by `Bun.serve` in the same process
 * puts the answer on the wrong side of the scale: measured 2026-09-10, an in-process fake had the
 * server hand every byte to the socket whatever the client did, and the test process grew by the
 * whole answer with the cap in place. Spawned, the server's memory is the server's.
 *
 * Speaks just enough of the protocol to be called: `initialize`, the `initialized` notification,
 * `tools/list` and `tools/call`. The one tool, `dump`, answers according to `arguments.mode`:
 *
 *  - `small` — one short text part;
 *  - `huge`  — fifty megabytes of text, STREAMED a megabyte at a time (never held whole here
 *              either, so the server's own cost is one megabyte);
 *  - `hang`  — no answer at all, until the process is killed.
 *
 * Prints one JSON line with its port on stdout once it listens, which is how the spawner finds it.
 */

const MEGABYTE = 1024 * 1024;
const HUGE_BYTES = 50 * MEGABYTE;
const chunk = new Uint8Array(MEGABYTE).fill(0x78);
const encoder = new TextEncoder();

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    // The SDK opens a GET stream after the handshake when a server allows it; 405 says we do not.
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = (await request.json()) as {
      id?: number | string;
      method?: string;
      params?: {
        protocolVersion?: string;
        arguments?: { mode?: string };
      };
    };
    const reply = (result: unknown) =>
      Response.json({ jsonrpc: "2.0", id: message.id, result });

    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "laf-fake-mcp", version: "0" },
        });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return reply({
          tools: [
            {
              name: "dump",
              description: "Answers according to `mode`.",
              inputSchema: {
                type: "object",
                properties: { mode: { type: "string" } },
              },
              annotations: { readOnlyHint: true },
            },
          ],
        });
      case "tools/call": {
        const mode = message.params?.arguments?.mode ?? "small";
        if (mode === "hang") {
          return new Promise<Response>(() => {});
        }
        if (mode !== "huge") {
          return reply({ content: [{ type: "text", text: "small" }] });
        }
        const head = encoder.encode(
          `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":{"content":[{"type":"text","text":"`,
        );
        const tail = encoder.encode(`"}]}}`);
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(head);
          },
          pull(controller) {
            if (sent < HUGE_BYTES) {
              controller.enqueue(chunk);
              sent += chunk.byteLength;
              return;
            }
            controller.enqueue(tail);
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      default:
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "no such method" },
        });
    }
  },
});

console.log(JSON.stringify({ port: server.port }));
