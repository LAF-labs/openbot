import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { HUB_FACTS } from "../../shared/hub/protocol";
import { createLogger } from "../../shared/log";
import { serveUploads } from "../src/uploads";
import {
  adminOptions,
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

/** A port nothing is listening on, for a hub process that refuses port 0. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

describe("a hub told to stop", () => {
  test("answers the upload it is reading before it exits", async () => {
    const source = new URL(
      process.env.DATABASE_URL ??
        "postgres://openbot:openbot@localhost:55432/openbot",
    );
    const name = `${decodeURIComponent(source.pathname.slice(1))}_hub_${randomBytes(4).toString("hex")}`;
    const admin = postgres({ ...adminOptions(source), max: 1 });
    await admin.unsafe(`create database "${name}"`);
    const target = new URL(source);
    target.pathname = `/${name}`;
    const filesDir = await mkdtemp(join(tmpdir(), "laf-hub-stop-"));
    const fleetKey = randomBytes(32).toString("hex");
    const origin = "https://stop.hub.example";
    const [port, uploadPort] = [await freePort(), await freePort()];
    // The hub as its container runs it: its own process, so SIGTERM reaches the real handler.
    const child = Bun.spawn(["bun", "src/index.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH ?? "",
        DATABASE_URL: target.toString(),
        PORT: String(port),
        HUB_UPLOAD_PORT: String(uploadPort),
        HUB_PUBLIC_ORIGIN: origin,
        HUB_FLEET_SECRET: fleetKey,
        HUB_FILES_DIR: filesDir,
      },
      stdout: "pipe",
      stderr: "inherit",
    });
    try {
      const reader = child.stdout.getReader();
      let seen = "";
      while (!seen.includes('"boot"')) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`the hub exited before booting: ${seen}`);
        seen += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      void child.stdout.pipeTo(new WritableStream());
      const pass = newPass();
      await putMember(
        { url: `http://127.0.0.1:${port}`, fleetKey, origin } as TestHub,
        { email: "a@example.com", vmOrigin: "https://a.example", pass },
      );

      // A multipart body sent in two halves, by hand, so the hub is told to stop between them.
      const boundary = "laf-stop-boundary";
      const body = [
        `--${boundary}\r\ncontent-disposition: form-data; name="meta"\r\ncontent-type: application/json\r\n\r\n`,
        `${JSON.stringify({ name: "late.txt" })}\r\n`,
        `--${boundary}\r\ncontent-disposition: form-data; name="blob"; filename="blob"\r\ncontent-type: text/plain\r\n\r\n`,
        "arrived after the stop\r\n",
        `--${boundary}--\r\n`,
      ].join("");
      const half = body.length >> 1;
      const socket = connect(uploadPort, "127.0.0.1");
      let answer = "";
      const closed = new Promise<void>((resolve) => {
        socket.on("data", (chunk) => {
          answer += chunk.toString();
        });
        socket.on("close", () => resolve());
        socket.on("error", () => {});
      });
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write(
        [
          "PUT /hub/v1/files HTTP/1.1",
          "host: hub",
          `authorization: Bearer ${pass}`,
          `idempotency-key: ${randomUUID()}`,
          `content-type: multipart/form-data; boundary=${boundary}`,
          `content-length: ${Buffer.byteLength(body)}`,
          "connection: close",
          "",
          body.slice(0, half),
        ].join("\r\n"),
      );
      // The request has reached the route once its header is parsed; the stop then comes mid-body.
      await Bun.sleep(300);
      child.kill("SIGTERM");
      // Nothing to await here: a hub that does not wait for the upload has exited by now.
      await Bun.sleep(300);
      // Written, not ended: a half-closed socket is one Bun's `node:http` closes without answering.
      socket.write(body.slice(half));
      await closed;

      expect(answer.split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
      expect(await child.exited).toBe(0);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      await admin.end();
      await rm(filesDir, { recursive: true, force: true });
    }
  }, 30_000);
});
