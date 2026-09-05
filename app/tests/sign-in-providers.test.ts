import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bakedProviders,
  fetchSignInProviders,
  parseProviders,
  signInProvidersQueryOptions,
} from "@/lib/auth/providers";
import { stubFetch } from "./support/fetch";

/**
 * The sign-in buttons are drawn from the deployment's answer, and the list compiled into the
 * image is only where the surface lands when there is no answer. The fleet measured the other
 * arrangement: a `google` image on a `laf` VM, and a button that posted into nothing.
 */
const answering = (status: number, body: unknown) =>
  stubFetch(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );

describe("which sign-ins the screen offers", () => {
  test("the deployment's answer wins over the build's", async () => {
    const providers = await fetchSignInProviders(
      answering(200, { providers: ["laf"] }),
    );
    expect(providers).toEqual(["laf"]);
  });

  test("an empty answer is an answer — nobody can sign in yet, and the screen says so", async () => {
    expect(
      await fetchSignInProviders(answering(200, { providers: [] })),
    ).toEqual([]);
  });

  test("a server too old to have the route leaves the baked list standing", async () => {
    expect(await fetchSignInProviders(answering(404, "Not Found"))).toBe(
      bakedProviders,
    );
  });

  test("no server at all leaves the baked list standing", async () => {
    const offline = stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchSignInProviders(offline)).toBe(bakedProviders);
  });

  test("a body this app cannot read leaves the baked list standing", async () => {
    expect(await fetchSignInProviders(answering(200, "<html>"))).toBe(
      bakedProviders,
    );
    expect(
      await fetchSignInProviders(answering(200, { providers: "laf" })),
    ).toBe(bakedProviders);
  });

  test("a name this build has no button for is dropped, and the rest are kept", () => {
    expect(
      parseProviders({ providers: ["kakao", "facebook", 3, "laf"] }),
    ).toEqual(["kakao", "laf"]);
    expect(parseProviders({})).toBeNull();
    expect(parseProviders(null)).toBeNull();
  });

  test("the query asks the one route, once per screen visit", () => {
    const options = signInProvidersQueryOptions();
    expect([...options.queryKey]).toEqual(["auth", "providers"]);
    expect(options.staleTime).toBeGreaterThan(0);
  });

  /*
   * The route reads the query and not the generated config for its buttons. Walked as text
   * because the property is about which source the screen consults — a screen that quietly went
   * back to `appConfig.auth.providers` would pass every render test and still draw the wrong
   * buttons on the fleet.
   */
  test("the sign screen consults the deployment, not the generated config, for its buttons", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../src/routes/sign.tsx"),
      "utf8",
    );
    expect(source).toContain("signInProvidersQueryOptions()");
    expect(source).not.toContain("appConfig.auth");
  });
});
