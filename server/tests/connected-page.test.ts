import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  connectedPageHtml,
  createConnectedPageRoute,
} from "../src/plugins/connected-page";
import { shellConnectedUrlFor } from "../src/plugins/oauth";

/**
 * `GET /connected`: the one page this server draws for a person, and the one that needs no session.
 *
 * WHY IT EXISTS. In the desktop shell the consent screen is handed to the person's OWN browser,
 * which is right — a webview has no address bar, no password manager and no Google session. But
 * that browser has no session for the app either, so the callback's ordinary redirect into
 * `/settings/connected-accounts` bounced to `/sign`: measured as somebody consenting successfully
 * and being shown 로그인하세요, with the grant stored perfectly and nothing on screen to say so.
 *
 * Two properties are worth a test rather than a reading. It must carry the deep link, because
 * without it the page is a dead end in a browser the person did not open on purpose. And it must
 * reflect nothing it did not look up, because it is public, session-free and reachable by URL —
 * which is the shape a reflected script tag likes.
 */

const page = new Hono().route("/connected", createConnectedPageRoute());
const get = (query: string) => page.request(`http://t/connected?${query}`);

describe("what the page says when a connection worked", () => {
  test("names the vendor from the catalogue and offers the way back", async () => {
    const response = await get("ok=1&id=google-sheets&name=Google%20Sheets");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Google Sheets 연결을 마쳤습니다.");
    expect(html).toContain("앱으로 돌아가세요.");
    // The deep link is the whole point: it is what hands the browser back to the shell.
    expect(html).toContain("lafagent://connected/google-sheets");
    // And the tab is theirs to close, which nothing else on this page would tell them.
    expect(html).toContain("이 창은 닫아도 됩니다.");
  });

  test("says nothing about a URL that carries no id it recognises", async () => {
    // A slug this build does not know cannot be trusted into a scheme URL the operating system will
    // act on, so it becomes the failure link rather than a link naming whatever was in the query.
    const html = await (await get("ok=1&id=not-a-vendor")).text();
    expect(html).toContain("lafagent://connected/failed");
    expect(html).not.toContain("lafagent://connected/not-a-vendor");
  });
});

describe("what it says when one did not", () => {
  test("gives the reason its own sentence, and still offers the way back", async () => {
    const denied = await (await get("ok=0&reason=denied")).text();
    expect(denied).toContain("연결이 취소됐습니다.");
    expect(denied).toContain("lafagent://connected/failed");

    const expired = await (await get("ok=0&reason=expired")).text();
    expect(expired).toContain("시간이 지나 연결이 만료됐습니다.");
    // Genuinely different sentences: the whole reason for having five words rather than one.
    expect(expired).not.toContain("연결이 취소됐습니다.");
  });

  test("a reason nobody here wrote is no reason at all", async () => {
    const html = await (
      await get(
        `ok=0&reason=${encodeURIComponent("<script>alert(1)</script>")}`,
      )
    ).text();
    // Matched against the closed set rather than reflected, so there is nothing to escape.
    expect(html).toContain("연결하지 못했습니다");
    expect(html).not.toContain("alert(1)");
  });
});

/*
 * THE PAGE IS PUBLIC AND ITS URL IS TYPEABLE. Everything reflected on it is either looked up in the
 * catalogue or escaped, because a session-free page that echoes a query parameter is the oldest
 * shape there is.
 */
describe("what it will and will not put on the page", () => {
  test("a title from an unknown id is escaped rather than trusted", async () => {
    const html = await (
      await get(
        `ok=1&id=not-a-vendor&name=${encodeURIComponent("<script>alert(1)</script>")}`,
      )
    ).text();

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("the catalogue's own title wins over whatever the query said", async () => {
    const html = await (
      await get("ok=1&id=notion&name=Definitely%20Not%20Notion")
    ).text();

    expect(html).toContain("Notion 연결을 마쳤습니다.");
    expect(html).not.toContain("Definitely Not Notion");
  });

  test("nothing else from the query reaches the page", async () => {
    // A URL somebody pasted, with the shapes a callback URL really carries on it. None of them are
    // this page's to render, and a page that echoed one would be putting a code in a screenshot.
    const html = await (
      await get("ok=1&id=notion&code=super-secret&state=sealed-state&token=abc")
    ).text();

    for (const leaked of ["super-secret", "sealed-state", "abc"]) {
      expect({ leaked, present: html.includes(leaked) }).toEqual({
        leaked,
        present: false,
      });
    }
  });

  test("is never cached", async () => {
    // It names a connection somebody just made, on a shared machine as readily as their own.
    const response = await get("ok=1&id=notion");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

/**
 * The URL the callback builds, on the deployment's own origin.
 *
 * `publicUrl` rather than `appUrl`, because `/connected` is served by this server — and because a
 * browser the shell just handed a consent screen to has no session for the app anyway.
 */
describe("where the callback sends a consent the shell started", () => {
  test("carries the id and the title, and nothing else", () => {
    const url = new URL(
      shellConnectedUrlFor("https://laf.example/", {
        serverId: "google-sheets",
        title: "Google Sheets",
      }),
    );

    expect(url.origin).toBe("https://laf.example");
    expect(url.pathname).toBe("/connected");
    expect([...url.searchParams.keys()].sort()).toEqual(["id", "name", "ok"]);
    expect(url.searchParams.get("id")).toBe("google-sheets");
  });

  test("a failure carries the reason and no vendor's words", () => {
    const url = new URL(
      shellConnectedUrlFor("https://laf.example", {
        failed: true,
        reason: "exchange",
      }),
    );

    expect(url.searchParams.get("ok")).toBe("0");
    expect(url.searchParams.get("reason")).toBe("exchange");
    expect(url.searchParams.get("id")).toBeNull();
  });
});

/** The renderer on its own, for the two shapes a route cannot reach. */
describe("the page a caller builds directly", () => {
  test("a success with no title still reads as a sentence", () => {
    const html = connectedPageHtml({
      ok: true,
      id: "notion",
      title: "",
      reason: "",
    });
    // "  연결을 마쳤습니다" with a hole where a name should be reads as a bug rather than as Korean.
    expect(html).toContain("연결을 마쳤습니다. 앱으로 돌아가세요.");
    expect(html).not.toContain(" 연결을 마쳤습니다. 앱으로 돌아가세요.</p>");
  });

  test("an id that is not a slug never becomes a scheme URL", () => {
    const html = connectedPageHtml({
      ok: true,
      id: "../../etc/passwd",
      title: "x",
      reason: "",
    });
    expect(html).toContain("lafagent://connected/failed");
    expect(html).not.toContain("passwd");
  });
});
