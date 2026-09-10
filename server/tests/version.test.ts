import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * `GET /api/version`: which build is answering.
 *
 * Read once when the app is created, from the process environment — the image bakes `GIT_SHA` and
 * `BUILD_CHANNEL` in (server/Dockerfile), compose passes `IMAGE_TAG` — so the environment is set
 * here BEFORE `createApp`, the way a container has it before the process starts.
 */

const BAKED = ["BUILD_CHANNEL", "GIT_SHA", "IMAGE_TAG"] as const;
const previous = Object.fromEntries(
  BAKED.map((name) => [name, process.env[name]]),
);

function bakedInto(
  environment: Partial<Record<(typeof BAKED)[number], string>>,
) {
  for (const name of BAKED) {
    if (environment[name] === undefined) delete process.env[name];
    else process.env[name] = environment[name];
  }
  return createApp(loadConfig(testEnvironment()));
}

afterEach(() => {
  for (const name of BAKED) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

describe("GET /api/version", () => {
  test("says the build, the commit and the channel an image was pulled by", async () => {
    const app = bakedInto({
      BUILD_CHANNEL: "v0.4.5",
      GIT_SHA: "dba36c3f0c4b6b1e6b2b8a4d1f1e9c7d5a3b2c1d",
      IMAGE_TAG: "stable",
    });
    const response = await app.request("http://laf.local/api/version");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: "v0.4.5",
      revision: "dba36c3f0c4b6b1e6b2b8a4d1f1e9c7d5a3b2c1d",
      channel: "stable",
    });
  });

  /*
   * A local build passes no build args, and the Dockerfile's defaults are EMPTY strings, not
   * "unknown" — an empty value is absent, and absent says `source`. The compose channel alone is
   * still a version, because it was the only one for a year and the fleet's pull is named by it.
   */
  test("falls back to the compose channel, and to `source` when nothing was baked", async () => {
    const pulled = bakedInto({
      BUILD_CHANNEL: "",
      GIT_SHA: "",
      IMAGE_TAG: "edge",
    });
    const pulledAnswer = await pulled.request("http://laf.local/api/version");
    await expect(pulledAnswer.json()).resolves.toEqual({
      version: "edge",
      channel: "edge",
    });

    const checkout = bakedInto({});
    const checkoutAnswer = await checkout.request(
      "http://laf.local/api/version",
    );
    await expect(checkoutAnswer.json()).resolves.toEqual({
      version: "source",
    });
  });

  /*
   * Public, so it is held to the same rule as `/api/capabilities`: named fields, never the config
   * object. The two canaries are the test environment's key and secret.
   */
  test("publishes three named facts and nothing out of the configuration", async () => {
    const app = bakedInto({
      BUILD_CHANNEL: "edge",
      GIT_SHA: "abc",
      IMAGE_TAG: "edge",
    });
    const answer = await app.request("http://laf.local/api/version");
    const body = await answer.text();

    expect(Object.keys(JSON.parse(body) as object).sort()).toEqual([
      "channel",
      "revision",
      "version",
    ]);
    expect(body).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    expect(body).not.toContain("google-client-secret");
  });
});
