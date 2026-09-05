import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import {
  personInitial,
  personTone,
} from "../src/components/avatar/person-avatar";

/**
 * The person's own face, and the letter that stands in for it.
 *
 * WHY THIS ONE IS RENDERED WHERE THE OTHER APP TESTS WALK SOURCE. The two failures worth catching
 * here are both events rather than markup: a provider's picture URL that 404s has to put the letter
 * back, and a NEW picture after a broken one has to be tried rather than inheriting the old one's
 * verdict. Neither is visible from the class list, and both are one `onError` away from being
 * wrong. happy-dom is registered for this file only, the way `shell-links.test.ts` does it — a DOM
 * installed for every test file would change what `globalThis` means for the pure ones.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** Renders into a fresh host and hands back the host plus a way to re-render into it. */
async function mounted() {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    render: async (element: React.ReactElement) => {
      await act(async () => {
        root.render(element);
      });
    },
    fire: async (target: Element, type: string) => {
      await act(async () => {
        target.dispatchEvent(new Event(type));
      });
    },
  };
}

describe("the letter that stands in for a face", () => {
  test("a Korean name is one syllable, not a romanisation and not two", () => {
    // The footer built these inline and `"김기범".split(/\s+/)` is one word, so it took [0] and
    // uppercased it: the right answer by accident, and only for a name with no space in it.
    expect(personInitial("김기범", "kim@example.com")).toBe("김");
    expect(personInitial("이 순신", "lee@example.com")).toBe("이");
  });

  test("a Latin name is one letter, upper-cased", () => {
    expect(personInitial("ann smith", "a@example.com")).toBe("A");
    expect(personInitial("Ann", "a@example.com")).toBe("A");
  });

  test("a name that leads with something that is not a letter is scanned past", () => {
    // `[0]` of these is a coloured circle inside a coloured circle, or a bracket.
    expect(personInitial("🙂 Zed", "z@example.com")).toBe("Z");
    expect(personInitial("★ 라프", "laf@example.com")).toBe("라");
    expect(personInitial("  ann", "a@example.com")).toBe("A");
  });

  test("it scans, it does not read Korean — the FIRST syllable is the answer", () => {
    // "(주)" is a company prefix and a person might mean 라 here. Knowing that is not something a
    // one-letter circle should try to do, and a rule that guessed would guess wrong elsewhere.
    expect(personInitial("(주)라프", "laf@example.com")).toBe("주");
  });

  test("with no name the address answers", () => {
    expect(personInitial(null, "dev@laf.local")).toBe("D");
    expect(personInitial("   ", "dev@laf.local")).toBe("D");
    expect(personInitial(undefined, "9lives@example.com")).toBe("9");
  });

  test("with nothing at all it is still one character, never empty", () => {
    // An empty circle reads as a picture that failed to load.
    expect(personInitial(null, null)).toBe("?");
    expect(personInitial("", "")).toBe("?");
    expect(personInitial("!!!", "")).toBe("?");
  });
});

describe("the colour", () => {
  test("is the same every time for the same address", () => {
    expect(personTone("kim@example.com")).toBe(personTone("kim@example.com"));
  });

  test("ignores the case of the address, which is not case-sensitive here", () => {
    expect(personTone("Kim@Example.com")).toBe(personTone("kim@example.com"));
    expect(personTone("  kim@example.com  ")).toBe(
      personTone("kim@example.com"),
    );
  });

  test("tells two people in the same roster apart", () => {
    // The point of the colour. One hue for everybody is a row of identical grey circles, which is
    // what it replaced.
    expect(personTone("kim@example.com")).not.toBe(
      personTone("lee@example.com"),
    );
  });

  test("reaches all eight hues rather than crowding onto one", () => {
    const seen = new Set(
      Array.from({ length: 200 }, (_, index) =>
        personTone(`person${index}@example.com`),
      ),
    );
    expect(seen.size).toBe(8);
  });

  test("every hue is readable in the dark theme too", () => {
    // A tone with a light fill and no dark half is a dark grey letter on a pale disc in a dark
    // window — which is what "soft" turns into if only the light theme is checked.
    const tones = new Set(
      Array.from({ length: 200 }, (_, index) =>
        personTone(`person${index}@example.com`),
      ),
    );
    for (const tone of tones) {
      expect(tone).toMatch(/dark:bg-/);
      expect(tone).toMatch(/dark:text-/);
    }
  });
});

describe("the picture", () => {
  test("is drawn when there is one, without telling its host who is looking", async () => {
    // Google's avatar host answers 403 to a referred request from an origin it does not know,
    // which is every deployment of this.
    const { host, render } = await mounted();
    const { PersonAvatar } = await import(
      "../src/components/avatar/person-avatar"
    );
    await render(
      createElement(PersonAvatar, {
        email: "kim@example.com",
        image: "https://pictures.example.com/kim.png",
        name: "김기범",
      }),
    );
    const image = host.querySelector("img");
    expect(image?.getAttribute("src")).toBe(
      "https://pictures.example.com/kim.png",
    );
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  test("is the letter when there is no picture", async () => {
    const { host, render } = await mounted();
    const { PersonAvatar } = await import(
      "../src/components/avatar/person-avatar"
    );
    await render(
      createElement(PersonAvatar, {
        email: "kim@example.com",
        name: "김기범",
      }),
    );
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe("김");
  });

  test("falls back to the letter when the URL fails", async () => {
    // A third-party host expires, rate-limits, or refuses a referrer. Without this the row shows a
    // broken-image glyph where a face was.
    const { fire, host, render } = await mounted();
    const { PersonAvatar } = await import(
      "../src/components/avatar/person-avatar"
    );
    await render(
      createElement(PersonAvatar, {
        email: "kim@example.com",
        image: "https://pictures.example.com/gone.png",
        name: "김기범",
      }),
    );
    const image = host.querySelector("img");
    expect(image).not.toBeNull();
    if (image) await fire(image, "error");
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe("김");
  });

  test("tries a new picture rather than inheriting the broken one's verdict", async () => {
    // The state is the URL that failed, not a boolean. A boolean would keep the letters up after
    // the picture changed to a working one.
    const { fire, host, render } = await mounted();
    const { PersonAvatar } = await import(
      "../src/components/avatar/person-avatar"
    );
    const withImage = (image: string) =>
      createElement(PersonAvatar, {
        email: "kim@example.com",
        image,
        name: "김기범",
      });
    await render(withImage("https://pictures.example.com/gone.png"));
    const broken = host.querySelector("img");
    if (broken) await fire(broken, "error");
    expect(host.querySelector("img")).toBeNull();

    await render(withImage("https://pictures.example.com/new.png"));
    expect(host.querySelector("img")?.getAttribute("src")).toBe(
      "https://pictures.example.com/new.png",
    );
  });

  test("is decorative, because the name is in text beside it", async () => {
    // Announced here as well, a screen reader reads the person's name twice on every row.
    const { host, render } = await mounted();
    const { PersonAvatar } = await import(
      "../src/components/avatar/person-avatar"
    );
    await render(
      createElement(PersonAvatar, {
        email: "kim@example.com",
        name: "김기범",
      }),
    );
    expect(
      host
        .querySelector("[data-slot=person-avatar]")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
  });
});
