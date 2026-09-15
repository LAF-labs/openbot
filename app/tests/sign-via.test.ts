import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Route, VIA_STARTED_KEY, viaToStart } from "../src/routes/sign";
import type { ViaShown } from "./support/sign-via-render";

/**
 * `/sign?via=google` — the front door's hand-off, pressed once for the person and never again.
 *
 * A new trial's owner has just signed in at the front door; their broker session is alive, and
 * `https://<slug>…/sign?via=google` is where the door sends them (self-serve contract §3-11, §4.6).
 * Making them press the same button a second time is the one click the flow promises not to ask
 * for. But a start that is refused comes BACK to this screen, and a screen that started again on
 * every arrival would be a loop between the broker and here that no person can get out of — so it
 * starts once per tab, remembers that in the tab, and never on an arrival that carries a refusal.
 */

const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
};

describe("which door the screen starts on its own", () => {
  test("the one named, the first time this tab arrives", () => {
    const storage = memory();
    expect(
      viaToStart({
        via: "google",
        isOffered: true,
        isRefusedOnArrival: false,
        storage,
      }),
    ).toBe("google");
    expect(storage.values.has(VIA_STARTED_KEY)).toBe(true);
  });

  test("never a second time in the same tab", () => {
    const storage = memory();
    const arrive = () =>
      viaToStart({
        via: "google",
        isOffered: true,
        isRefusedOnArrival: false,
        storage,
      });
    expect(arrive()).toBe("google");
    expect(arrive()).toBeNull();
    expect(arrive()).toBeNull();
  });

  test("not on an arrival that carries a refusal, and not afterwards in that tab either", () => {
    const storage = memory();
    expect(
      viaToStart({
        via: "google",
        isOffered: true,
        isRefusedOnArrival: true,
        storage,
      }),
    ).toBeNull();
    expect(
      viaToStart({
        via: "google",
        isOffered: true,
        isRefusedOnArrival: false,
        storage,
      }),
    ).toBeNull();
  });

  test("not a door this deployment does not offer", () => {
    const storage = memory();
    expect(
      viaToStart({
        via: "naver",
        isOffered: false,
        isRefusedOnArrival: false,
        storage,
      }),
    ).toBeNull();
    // And that is not remembered as having started: nothing did.
    expect(storage.values.size).toBe(0);
  });

  test("not without somewhere to remember it — a tab that cannot remember cannot promise once", () => {
    expect(
      viaToStart({
        via: "google",
        isOffered: true,
        isRefusedOnArrival: false,
        storage: null,
      }),
    ).toBeNull();
    const refusing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(
      viaToStart({
        via: "google",
        isOffered: true,
        isRefusedOnArrival: false,
        storage: refusing,
      }),
    ).toBeNull();
  });

  test("not a door that does not exist, whatever reached the screen past the validator", () => {
    // The router merges the root's unvalidated search in, so this is what the screen can be handed.
    for (const via of ["github", "laf", "GOOGLE", 3, null]) {
      expect(
        viaToStart({
          via,
          isOffered: true,
          isRefusedOnArrival: false,
          storage: memory(),
        }),
      ).toBeNull();
    }
  });

  test("nothing, when no door was named", () => {
    expect(
      viaToStart({
        via: undefined,
        isOffered: true,
        isRefusedOnArrival: false,
        storage: memory(),
      }),
    ).toBeNull();
  });
});

describe("what the address may name", () => {
  const validate = Route.options.validateSearch as (
    search: Record<string, unknown>,
  ) => Record<string, unknown>;

  test.each(["kakao", "naver", "google"])("%s is a door", (via) => {
    expect(validate({ via })).toMatchObject({ via });
  });

  test.each(["github", "laf", "", "GOOGLE", 3])("%p is not", (via) => {
    expect(validate({ via })).not.toHaveProperty("via");
  });
});

let rendering: Promise<ViaShown[]> | undefined;

/** The real screen, in one tab, opened five ways in a row. */
function rendered(): Promise<ViaShown[]> {
  rendering ??= (async () => {
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "support/sign-via-render.tsx")],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const line = stdout
      .split("\n")
      .find((candidate) => candidate.startsWith("SIGN_VIA_RENDER "));
    if (status !== 0 || !line) {
      throw new Error(
        `the render did not finish (exit ${status}):\n${stderr.slice(-3000)}`,
      );
    }
    return JSON.parse(line.slice("SIGN_VIA_RENDER ".length)) as ViaShown[];
  })();
  return rendering;
}

describe("the screen itself, opened by the front door", () => {
  test("starts the named door once, through the broker, and not again when the refusal sends it back", async () => {
    const [first, again] = await rendered();
    expect(first).toMatchObject({ path: "/sign?via=google", started: 1 });
    expect(first?.body).toMatchObject({
      providerId: "laf",
      additionalData: { provider: "google" },
    });
    expect(again).toMatchObject({ path: "/sign?via=google", started: 0 });
  }, 60_000);

  test("starts nothing on a refusal, on a door it does not know, or with no door named", async () => {
    const [, , refused, unknown, plain] = await rendered();
    expect(refused).toMatchObject({ started: 0 });
    expect(unknown).toMatchObject({ path: "/sign?via=github", started: 0 });
    expect(plain).toMatchObject({ path: "/sign", started: 0 });
  }, 60_000);
});
