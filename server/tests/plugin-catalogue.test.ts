import { describe, expect, test } from "bun:test";
import {
  CATALOGUE,
  type CatalogueEntry,
  catalogueEntry,
  classifyTool,
  customUrlRefusal,
  hostAdmissible,
  resolveServerUrl,
  serverCredentialKind,
} from "../src/plugins/catalogue";
import { unlistedAdvertisedTools } from "../src/plugins/store";

/**
 * The catalogue decides two things that are worth being sure about: which addresses this deployment
 * will talk to at all, and which of a server's tools change something.
 *
 * Both fail closed, and both are tested for that rather than for the happy path. An admissibility
 * check that accepts one address too many is a request-forgery primitive; an effect classifier that
 * calls a write a read is a governance surface that quietly stops covering the thing it exists for.
 */

describe("which servers this deployment will talk to", () => {
  test("a pinned host matches only itself", () => {
    const notion = catalogueEntry("notion");
    expect(notion).not.toBeNull();
    expect(hostAdmissible(notion!, "https://mcp.notion.com")).toBe(true);
    // A prefix, a suffix and a lookalike are each refused. The suffix case is the one that matters:
    // a check written with endsWith rather than equality would accept it.
    expect(hostAdmissible(notion!, "https://mcp.notion.com.evil.test")).toBe(
      false,
    );
    expect(hostAdmissible(notion!, "https://evil.test/mcp.notion.com")).toBe(
      false,
    );
    expect(hostAdmissible(notion!, "http://mcp.notion.com")).toBe(false);
  });

  /**
   * No current entry is per-instance (ServiceNow's shape is in the history), and what must hold
   * while none is: the pattern map is compiled from the FROZEN catalogue and from nothing else, so
   * an entry value a caller constructed — however plausible its pattern reads — is refused
   * wholesale. That is the fail-closed floor a request-forgery attempt would have to get past.
   */
  const perInstance: CatalogueEntry = {
    key: "per-instance-test",
    title: "Per-instance",
    vendor: "Example",
    summary: "",
    host: null,
    hostPattern:
      "^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)\\.example-vendor\\.com$",
    path: "/mcp",
    auth: { kind: "deployment-bearer" },
    writeTools: Object.freeze([]),
    docsUrl: "",
  };

  test("a per-instance entry outside the frozen catalogue is refused wholesale", () => {
    // Even its own legitimate-looking instance: the compiled pattern map is the authority, and this
    // key is not in it, so every branch that cannot prove admissibility answers no.
    expect(hostAdmissible(perInstance, "https://acme.example-vendor.com")).toBe(
      false,
    );
    expect(
      hostAdmissible(perInstance, "https://acme.example-vendor.com.evil.test"),
    ).toBe(false);
    expect(resolveServerUrl(perInstance.key)).toBeNull();
    expect(
      resolveServerUrl(perInstance.key, "https://acme.example-vendor.com"),
    ).toBeNull();
  });

  test("a server not in the catalogue resolves to nothing", () => {
    expect(resolveServerUrl("not-a-vendor")).toBeNull();
    expect(catalogueEntry("not-a-vendor")).toBeNull();
  });

  test("the path is the catalogue's, never the caller's", () => {
    const resolved = resolveServerUrl("notion");
    expect(resolved?.url).toBe("https://mcp.notion.com/mcp");
    // The Drive entry rides its REST transport, and the URL is still pinned code.
    expect(resolveServerUrl("google-drive")?.url).toBe(
      "https://www.googleapis.com/drive/v3",
    );
  });

  test("every catalogue entry pins a host or an anchored pattern", () => {
    expect(CATALOGUE.length).toBeGreaterThan(0);
    for (const entry of CATALOGUE) {
      if (entry.host === null) {
        expect(entry.hostPattern).toBeDefined();
        // Anchored at both ends or the pattern is decoration.
        expect(entry.hostPattern?.startsWith("^")).toBe(true);
        expect(entry.hostPattern?.endsWith("$")).toBe(true);
      } else {
        expect(entry.host.startsWith("https://")).toBe(true);
      }
    }
  });

  test("every OAuth address is pinned https, and dynamic entries name their registration endpoint", () => {
    for (const entry of CATALOGUE) {
      if (entry.auth.kind !== "user-oauth") continue;
      /*
       * A `{host}` template counts as pinned, because the only thing it can become is an origin
       * `hostAdmissible` already accepted — and every entry's pattern is anchored on `https://`,
       * which the test above checks. What must never appear is an ABSOLUTE address that is not
       * https, so a template is required to be a template all the way to its first slash rather
       * than something like `http://{host}`.
       */
      for (const address of [
        entry.auth.authorizationUrl,
        entry.auth.tokenUrl,
        entry.auth.revokeUrl,
      ]) {
        expect(
          address.startsWith("https://") || address.startsWith("{host}/"),
        ).toBe(true);
      }
      if (entry.auth.clientRegistration === "dynamic") {
        expect(entry.auth.registrationUrl?.startsWith("https://")).toBe(true);
      }
    }
  });

  test("a user-oauth entry takes no pasted credential; a bearer one takes the server's own kind", () => {
    expect(serverCredentialKind(catalogueEntry("notion")!)).toBeNull();
    expect(serverCredentialKind(catalogueEntry("google-drive")!)).toBeNull();
    expect(serverCredentialKind(perInstance)).toBe("mcp");
  });
});

describe("what a tool does", () => {
  const notion = catalogueEntry("notion")!;

  test("a named write is a write", () => {
    expect(classifyTool(notion, "notion-create-pages", true)).toBe("write");
  });

  test("an advertised tool that is not a named write is a read", () => {
    expect(classifyTool(notion, "notion-search", true)).toBe("read");
  });

  test("a tool the server never advertised is a write", () => {
    // The only thing that produced this name was a model, so nothing has vouched for it.
    expect(classifyTool(notion, "notion-search", false)).toBe("write");
  });

  test("every tool on a server nobody reviewed is a write", () => {
    expect(classifyTool(null, "anything_at_all", true)).toBe("write");
  });

  test("a tool that edits rather than creates is still a write", () => {
    // The naming does not carry it: "update" and "move" both change somebody else's system, and a
    // list built by reading verbs off tool names lets the edits through.
    expect(classifyTool(notion, "notion-update-page", true)).toBe("write");
    expect(classifyTool(notion, "notion-move-pages", true)).toBe("write");
    expect(classifyTool(notion, "notion-get-comments", true)).toBe("read");
  });

  test("Drive's writes are named even though its scope refuses them", () => {
    // Belt and braces: the read-only scope is what stops them at Google, and the list is what
    // keeps a boundary written about writes covering them if the scope is ever widened.
    const drive = catalogueEntry("google-drive")!;
    expect(classifyTool(drive, "create_file", true)).toBe("write");
    expect(classifyTool(drive, "search_files", true)).toBe("read");
  });
});

describe("the write-list reconciliation trail", () => {
  test("only a scope-less user-oauth vendor is reconciled, and only unlisted names are reported", () => {
    const notion = catalogueEntry("notion")!;
    const drive = catalogueEntry("google-drive")!;
    // Notion has no scope strings, so the write list is the whole barrier: an advertised name it
    // does not carry is worth a row.
    expect(
      unlistedAdvertisedTools(notion, ["notion-search", "notion-create-pages"]),
    ).toEqual(["notion-search"]);
    // Drive expresses a read-only scope, so there is a second barrier and nothing is reported.
    expect(unlistedAdvertisedTools(drive, ["search_files"])).toEqual([]);
    // A custom server has no reviewed list at all; everything is already a write.
    expect(unlistedAdvertisedTools(null, ["anything"])).toEqual([]);
  });
});

describe("a URL an administrator typed", () => {
  test("an ordinary vendor URL is accepted", () => {
    expect(customUrlRefusal("https://mcp.example.com/mcp")).toBeNull();
  });

  test("plaintext is refused", () => {
    expect(customUrlRefusal("http://mcp.example.com")).toContain("https");
  });

  test("an address literal is refused", () => {
    // The cloud metadata endpoint, which is the reason this check exists.
    expect(
      customUrlRefusal("https://169.254.169.254/latest/meta-data/"),
    ).toContain("hostname");
    expect(customUrlRefusal("https://127.0.0.1/mcp")).toContain("hostname");
    expect(customUrlRefusal("https://[::1]/mcp")).toContain("hostname");
  });

  test("names that only resolve inside the network are refused", () => {
    expect(customUrlRefusal("https://localhost/mcp")).not.toBeNull();
    expect(customUrlRefusal("https://database/mcp")).not.toBeNull();
    expect(customUrlRefusal("https://vault.internal/mcp")).not.toBeNull();
    expect(customUrlRefusal("https://printer.local/mcp")).not.toBeNull();
    // How a Kubernetes service is addressed from inside a cluster: dots, no refused suffix above.
    expect(customUrlRefusal("https://vault.ns.svc/mcp")).not.toBeNull();
  });

  test("the metadata endpoint is refused by name, in every spelling", () => {
    expect(customUrlRefusal("https://metadata.goog/computeMetadata")).toContain(
      "cloud credentials",
    );
    expect(
      customUrlRefusal("https://metadata.google.internal/computeMetadata"),
    ).not.toBeNull();
    // The root-anchored spelling resolves to the same place and must not walk through.
    expect(customUrlRefusal("https://metadata.goog./x")).toContain(
      "cloud credentials",
    );
    expect(customUrlRefusal("https://localhost./mcp")).not.toBeNull();
  });

  test("a credential written into the address is refused wherever it hides", () => {
    // Userinfo is stored and audited verbatim with the rest of the string.
    expect(customUrlRefusal("https://user:secret@mcp.example.com/")).toContain(
      "token field",
    );
    // The query, by parameter name — and one word away from the obvious spelling still counts.
    expect(
      customUrlRefusal("https://mcp.example.com/mcp?api_token=abc"),
    ).toContain("token field");
    expect(
      customUrlRefusal("https://mcp.example.com/mcp?apiKey=abc"),
    ).toContain("token field");
    // The fragment never reaches the server and is still stored, which is the concern.
    expect(
      customUrlRefusal("https://mcp.example.com/mcp#access_token=abc"),
    ).toContain("token field");
    // Ordinary routing parameters are left alone; a floor an operator works around is a gap.
    expect(customUrlRefusal("https://mcp.example.com/mcp?version=2")).toBe(
      null,
    );
    expect(customUrlRefusal("https://mcp.example.com/mcp#section")).toBe(null);
  });

  test("nonsense is refused rather than thrown", () => {
    expect(customUrlRefusal("not a url")).toBe("That is not a URL.");
  });
});
