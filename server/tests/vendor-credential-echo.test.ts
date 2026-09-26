import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  CREDENTIAL_REDACTED,
  callTool,
  listTools,
  McpServerError,
  withoutCredential,
} from "../src/plugins/mcp";
import { createPublicDataTransport } from "../src/plugins/public-data-rest";
import { vendorRequest } from "../src/plugins/rest-support";
import { PluginRefusedError } from "../src/plugins/store";
import { realMcpModule } from "./support/mcp-module";

/**
 * A vendor that writes the credential it was sent back into what it answers.
 *
 * WHAT THIS IS ABOUT (security package item 10, 2026-09-26). No connector credential reaches
 * `agent-bot` or the model by construction — the token is decrypted inside the call path and spent
 * on one request. The one door left is the vendor's own text, which the model reads as the tool's
 * result: a custom server's debugging tool answering with the headers it saw, a 403 body quoting the
 * `Authorization` it refused, an error page repeating the query string a key rode in on. Before this
 * file, every one of those went to the model, the transcript, the audit row and the export as sent.
 *
 * Each case below has its positive control: the fake records the credential ARRIVING, so an
 * assertion that it is absent from the answer is about a credential that really went out and really
 * came back — not about a request that never carried one.
 */

/** Long and distinctive, so finding it anywhere means what it looks like it means. */
const TOKEN = "ya29.canary-access-token-7f3c9e1b5a2d4c6e8f0a";
/** A data.go.kr key as the environment carries it: the URL-encoded spelling. */
const SERVICE_KEY = "CanaryServiceKey9x7w5v%2BQ3r1t%3D%3D";
const SERVICE_KEY_DECODED = decodeURIComponent(SERVICE_KEY);

/** What each fake heard, so the credential can be seen leaving. */
const heard: string[] = [];

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: { protocolVersion?: string; arguments?: { mode?: string } };
};

/**
 * An MCP server that speaks just enough of Streamable HTTP to be called, and whose one tool says
 * back the header it was called with — or, asked to refuse, refuses with it in the body.
 */
const mcpVendor = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const authorization = request.headers.get("authorization") ?? "";
    heard.push(authorization);
    const message = (await request.json()) as RpcMessage;
    const reply = (result: unknown) =>
      Response.json({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "laf-echo-mcp", version: "0" },
        });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        // Refused the way Google's Workspace servers refuse, with the header quoted in the body.
        return Response.json(
          {
            error: {
              message: `Request had invalid credentials: ${authorization}`,
            },
          },
          { status: 403 },
        );
      case "tools/call": {
        const mode = message.params?.arguments?.mode ?? "echo";
        if (mode === "refuse") {
          return Response.json(
            {
              error: {
                message: `The API is not enabled for this project. You sent ${authorization}.`,
              },
            },
            { status: 403 },
          );
        }
        return reply({
          content: [
            {
              type: "text",
              text: `headers seen: authorization=${authorization}`,
            },
            { type: "text", text: `and again, bare: ${TOKEN}` },
          ],
          isError: mode === "error",
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

/** A REST vendor that refuses every request, quoting the bearer token it was shown. */
const restVendor = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => {
    const authorization = request.headers.get("authorization") ?? "";
    heard.push(authorization);
    return Response.json(
      {
        error: {
          code: 401,
          message: `Invalid access token: ${authorization.replace(/^Bearer /, "")}`,
        },
      },
      { status: 401 },
    );
  },
});

const connection = {
  url: `http://127.0.0.1:${mcpVendor.port}/mcp`,
  token: TOKEN,
};

beforeAll(() => {
  /*
   * The real transport, whatever another suite left in the registry: `plugin-consent` stubs
   * `../src/plugins/mcp` process-wide, and the subject here is what the real client hands back.
   */
  mock.module("../src/plugins/mcp", () => realMcpModule);
});

afterAll(() => {
  mcpVendor.stop(true);
  restVendor.stop(true);
});

describe("withoutCredential", () => {
  test("cuts every occurrence of every spelling it is given", () => {
    const text = `a ${TOKEN} b ${TOKEN} c ${SERVICE_KEY_DECODED}`;
    const said = withoutCredential(text, TOKEN, SERVICE_KEY_DECODED);
    expect(said).not.toContain(TOKEN);
    expect(said).not.toContain(SERVICE_KEY_DECODED);
    expect(said).toBe(
      `a ${CREDENTIAL_REDACTED} b ${CREDENTIAL_REDACTED} c ${CREDENTIAL_REDACTED}`,
    );
  });

  test("leaves the text alone for an absent, empty or too-short credential", () => {
    const text = "The vendor answered 403 for key abc.";
    expect(withoutCredential(text)).toBe(text);
    expect(withoutCredential(text, undefined, "")).toBe(text);
    // A one-letter "credential" would shred the sentence into brackets and protect nothing.
    expect(withoutCredential(text, "a", "key")).toBe(text);
  });
});

describe("an MCP server that echoes the credential", () => {
  test("a result carrying it reaches the model without it", async () => {
    heard.length = 0;
    const result = await callTool(connection, "echo", { mode: "echo" });

    // It went out, on every request of the exchange.
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every((value) => value === `Bearer ${TOKEN}`)).toBe(true);
    // And it came back, and was cut — the rest of what the server said is kept.
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain(TOKEN);
    expect(result.text).toContain("headers seen: authorization=Bearer");
    expect(result.text).toContain(CREDENTIAL_REDACTED);
  });

  test("a result the server marks as an error is cut the same way", async () => {
    const result = await callTool(connection, "echo", { mode: "error" });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(TOKEN);
    expect(result.text).toContain(CREDENTIAL_REDACTED);
  });

  test("a 403 whose body quotes it is a failure without it, and keeps the vendor's sentence", async () => {
    heard.length = 0;
    const thrown = await callTool(connection, "echo", { mode: "refuse" }).catch(
      (error: unknown) => error,
    );
    expect(heard).toContain(`Bearer ${TOKEN}`);
    expect(thrown).toBeInstanceOf(McpServerError);
    const message = (thrown as McpServerError).message;
    expect(message).not.toContain(TOKEN);
    // The 403's reason is still there: it is the sentence that names the API that is not enabled.
    expect(message).toContain("The API is not enabled for this project");
    expect((thrown as McpServerError).status).toBe(403);
  });

  test("a tool listing refused with it in the body fails without it", async () => {
    // The message that becomes `mcp_servers.last_error` on the admin page.
    const thrown = await listTools(connection).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(McpServerError);
    expect((thrown as Error).message).not.toContain(TOKEN);
    expect((thrown as Error).message).toContain(
      "Request had invalid credentials",
    );
  });
});

describe("a REST vendor that quotes the token it refused", () => {
  test("the refusal the adapter hands the model does not carry it", async () => {
    heard.length = 0;
    const answered = await vendorRequest(
      "Canary REST",
      { url: `http://127.0.0.1:${restVendor.port}`, token: TOKEN },
      { url: `http://127.0.0.1:${restVendor.port}/v1/things` },
    );
    expect(heard).toEqual([`Bearer ${TOKEN}`]);
    expect(answered.ok).toBe(false);
    if (answered.ok) return;
    expect(answered.status).toBe(401);
    expect(answered.message).not.toContain(TOKEN);
    expect(answered.message).toContain("Invalid access token");
  });
});

describe("the public data portal echoing the key back", () => {
  /** A portal page that answers with something unreadable that repeats what it was asked. */
  const portal = (echo: (address: string) => string) => {
    const asked: string[] = [];
    const fetchImpl = (async (address: string | URL | Request) => {
      asked.push(String(address));
      return new Response(echo(String(address)), { status: 200 });
    }) as typeof fetch;
    return {
      asked,
      transport: createPublicDataTransport({
        serviceKey: SERVICE_KEY,
        fetchImpl,
      }),
    };
  };

  test("in the spelling it was sent, the refusal's detail does not carry it", async () => {
    // The query string first: the detail keeps 120 characters, and the portal's path alone is longer.
    const { asked, transport } = portal(
      (address) => `bad: ${new URL(address).search} (${address})`,
    );
    const thrown = await transport
      .callTool({ url: "" }, "search_bids", {})
      .catch((error: unknown) => error);
    // It went out, as-is, on the query string.
    expect(asked[0]).toContain(`serviceKey=${SERVICE_KEY}`);
    expect(thrown).toBeInstanceOf(PluginRefusedError);
    const refused = thrown as PluginRefusedError;
    expect(refused.code).toBe("laf:public_data_unreadable");
    // The message is the audit row's `failure`, and the export carries the row.
    expect(refused.message).not.toContain(SERVICE_KEY);
    expect(refused.message).not.toContain(SERVICE_KEY_DECODED);
  });

  test("decoded, it is cut all the same", async () => {
    const { transport } = portal(() => `key ${SERVICE_KEY_DECODED} is unknown`);
    const thrown = await transport
      .callTool({ url: "" }, "search_bids", {})
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(PluginRefusedError);
    expect((thrown as Error).message).not.toContain(SERVICE_KEY_DECODED);
    expect((thrown as Error).message).toContain(CREDENTIAL_REDACTED);
  });
});
