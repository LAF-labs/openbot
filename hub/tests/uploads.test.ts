import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HUB_FACTS } from "../../shared/hub/protocol";
import { createLogger } from "../../shared/log";
import { serveUploads } from "../src/uploads";
import {
  asMember,
  newPass,
  putMember,
  startTestHub,
  type TestHub,
} from "./support/hub";

/** `PUT /files` as a VM sends it, to the given base. */
function upload(base: string, pass: string, bytes: string, name: string) {
  const form = new FormData();
  form.append(
    "meta",
    new Blob([JSON.stringify({ name })], { type: "application/json" }),
  );
  form.append("blob", new Blob([bytes], { type: "text/plain" }), "blob");
  return fetch(`${base}/hub/v1/files`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${pass}`,
      "idempotency-key": randomUUID(),
    },
    body: form,
  });
}

describe("the upload listener", () => {
  let hub: TestHub;
  let server: Server;
  let base: string;
  let pass: string;

  beforeEach(async () => {
    hub = await startTestHub({ fileMaxBytes: 1024 });
    server = await serveUploads({
      app: hub.app,
      port: 0,
      hostname: "127.0.0.1",
      log: createLogger("hub", () => {}),
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    pass = newPass();
    await putMember(hub, {
      email: "a@example.com",
      vmOrigin: "https://a.example",
      pass,
    });
  });

  afterEach(async () => {
    server.close();
    await hub.stop();
  });

  test("a file put through it is the hub's file, read back through the main listener", async () => {
    const response = await upload(base, pass, "hello hub", "hello.txt");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    const content = await fetch(
      `${hub.url}/hub/v1/files/${body.id}/content`,
      asMember(pass),
    );
    expect(await content.text()).toBe("hello hub");
  });

  test("the route's own rules apply: no pass, and a file over the limit", async () => {
    expect((await upload(base, "0".repeat(64), "x", "x.txt")).status).toBe(401);
    const large = await upload(base, pass, "x".repeat(2048), "large.bin");
    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({
      ok: false,
      code: HUB_FACTS.fileTooLarge,
    });
  });

  test.each([
    ["GET", "/hub/v1/files"],
    ["POST", "/hub/v1/files"],
    ["PUT", "/hub/v1/files/f_1"],
    ["GET", "/hub/v1/health"],
  ])("%s %s is not served here", async (method, path) => {
    const response = await fetch(`${base}${path}`, {
      method,
      ...asMember(pass),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      code: HUB_FACTS.notFound,
    });
  });
});
