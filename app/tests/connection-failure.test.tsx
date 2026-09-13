import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createElement } from "react";
import { knownFailureCode } from "../../server/src/plugins/connection-health";
import type { ConnectionFailureCode as ServerFailureCode } from "../../server/src/plugins/store";
import type { OauthAccount } from "../src/lib/connections/queries";
import { ko } from "../src/lib/i18n-ko";
import { mount, unmountAll } from "./support/mount";

/**
 * A CONNECTION THAT STOPPED WORKING SAYS WHY — IN THE WORDS FOR THE REASON THE SERVER ACTUALLY SENT.
 *
 * `connectionFailureText` keyed its sentences on `laf:refresh_refused`, `laf:credential_missing`
 * and `laf:scope_missing`. No server in this repository has ever written any of the three: a
 * connection's health carries what `judgeHealth` decides — `revoked`, `refresh_failed`,
 * `vendor_down` (server/src/plugins/connection-health.ts, since `fcf4d56`) — so every row that
 * needed attention drew the one generic sentence, and a vendor's five-minute outage drew nothing at
 * all on the one screen a person opens when something is wrong.
 *
 * The row is rendered, for each code the server's own filter admits.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/settings" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(unmountAll);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const GENERIC =
  "This connection has stopped working. Turn it off and on again.";

function account(overrides: Partial<OauthAccount>): OauthAccount {
  return {
    kind: "oauth",
    id: "google-drive",
    serverId: "server-1",
    title: "Google Drive",
    vendor: "google",
    status: "connected",
    connectedAt: "2026-09-01T00:00:00.000Z",
    account: null,
    needsInstanceName: false,
    health: {
      status: "ok",
      lastOkAt: "2026-09-12T00:00:00.000Z",
      lastFailureAt: null,
      failureCode: null,
    },
    ...overrides,
  };
}

/** The row as a person reads it: the line under the name that says where it got to. */
async function rowStatus(shown: OauthAccount): Promise<string> {
  const { OauthRow } = await import("../src/components/connections/oauth-row");
  const view = await mount(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(OauthRow, { account: shown, onWaiting: () => {} }),
    ),
  );
  // Under the name: what it can do, and then — when there is one — the line saying where it got to.
  const lines = [...view.host.querySelectorAll("p")].map(
    (line) => line.textContent ?? "",
  );
  return lines[1] ?? "";
}

describe("the line under a connection that needs attention", () => {
  test("a grant the vendor revoked says the account signed it out", async () => {
    const said = await rowStatus(
      account({
        status: "needs_reconnect",
        health: {
          status: "needs_reconnect",
          lastOkAt: "2026-09-01T00:00:00.000Z",
          lastFailureAt: "2026-09-12T00:00:00.000Z",
          failureCode: "revoked",
        },
      }),
    );
    expect(said).toBe(
      "Your account signed this out. Turn it off and on again to reconnect.",
    );
  });

  test("a refused refresh, or a 401 after a good one, says to consent again to everything", async () => {
    const said = await rowStatus(
      account({
        status: "needs_reconnect",
        health: {
          status: "needs_reconnect",
          lastOkAt: "2026-09-01T00:00:00.000Z",
          lastFailureAt: "2026-09-12T00:00:00.000Z",
          failureCode: "refresh_failed",
        },
      }),
    );
    expect(said).toBe(
      "This connection is missing something it needs. Turn it off and on again, and say yes to everything the service asks.",
    );
  });

  test("a vendor that did not answer says so on a row that stays connected, and asks for nothing", async () => {
    const said = await rowStatus(
      account({
        health: {
          status: "ok",
          lastOkAt: "2026-09-12T00:00:00.000Z",
          lastFailureAt: "2026-09-12T09:00:00.000Z",
          failureCode: "vendor_down",
        },
      }),
    );
    expect(said).toBe(
      "The service did not answer a moment ago. Nothing needs doing; the Bot tries again by itself.",
    );
    expect(said).not.toContain("Turn it off");
  });

  test("an outage a later call has already outlived is not news", async () => {
    const said = await rowStatus(
      account({
        health: {
          status: "ok",
          lastOkAt: "2026-09-12T10:00:00.000Z",
          lastFailureAt: "2026-09-12T09:00:00.000Z",
          failureCode: "vendor_down",
        },
      }),
    );
    expect(said.startsWith("Connected")).toBe(true);
  });
});

describe("the codes against the server's own set", () => {
  test("every code a connection can carry has words of its own, and Korean for them", async () => {
    // Imported here rather than at the top: Base UI decides at evaluation whether a DOM exists.
    const { CONNECTION_FAILURE_SENTENCES, connectionFailureText } =
      await import("../src/components/plugins/connections");
    /*
     * AT COMPILE TIME FIRST: a code added to the server's union without words here fails
     * `bun run typecheck` on this line, before any test runs.
     */
    const table: Record<ServerFailureCode, string> =
      CONNECTION_FAILURE_SENTENCES;
    expect(Object.keys(table).length).toBeGreaterThan(0);
    /*
     * What `knownFailureCode` admits is exactly what reaches a row; everything else is dropped on
     * the server. The candidates include the codes the plugin paths send per CALL, which it must
     * refuse — they are the Bot's to read, not a connection's state.
     */
    const candidates = [
      ...Object.keys(CONNECTION_FAILURE_SENTENCES),
      "laf:needs_reconnect",
      "laf:mcp_timeout",
      "laf:mcp_response_too_large",
      "laf:mcp_redirect_refused",
      "laf:grant_withdrawn",
      "laf:refresh_refused",
      "laf:credential_missing",
      "laf:scope_missing",
    ];
    const carried = candidates.filter(
      (code) => knownFailureCode(code) !== null,
    );
    expect(carried.sort()).toEqual(
      Object.keys(CONNECTION_FAILURE_SENTENCES).sort(),
    );
    for (const code of carried) {
      const sentence = connectionFailureText(code);
      expect({ code, specific: sentence !== GENERIC }).toEqual({
        code,
        specific: true,
      });
      expect(ko[sentence]).toBeString();
    }
    expect(ko[GENERIC]).toBeString();
  });
});
