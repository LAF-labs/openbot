import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => {
  GlobalRegistrator.register();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/**
 * A file dropped where nothing takes it must not replace the app. The installed app stopped taking
 * file drops for itself so the composer could have them (`dragDropEnabled: false`), and a webview's
 * answer to a drop nothing claimed is to open the file in the window — which has no Back.
 */

type Drag = Event & {
  dataTransfer: { types: readonly string[]; dropEffect: string };
};

/** happy-dom has no DragEvent; the guard reads only these two fields of one. */
function drag(type: "dragover" | "drop", types: string[]): Drag {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Drag;
  Object.defineProperty(event, "dataTransfer", {
    value: { types, dropEffect: "copy" },
  });
  return event;
}

describe("a file dropped where nothing takes it", () => {
  test("is refused, and never opened in place of the page", async () => {
    const { guardStrayDrops } = await import("../src/lib/stray-drops");
    const release = guardStrayDrops(window as unknown as Window);
    try {
      const over = drag("dragover", ["Files"]);
      document.body.dispatchEvent(over);
      expect(over.defaultPrevented).toBe(true);
      expect(over.dataTransfer.dropEffect).toBe("none");

      const dropped = drag("drop", ["Files"]);
      document.body.dispatchEvent(dropped);
      expect(dropped.defaultPrevented).toBe(true);
    } finally {
      release();
    }
  });

  test("leaves a drop target's own drag alone", async () => {
    const { guardStrayDrops } = await import("../src/lib/stray-drops");
    const release = guardStrayDrops(window as unknown as Window);
    const form = document.createElement("form");
    document.body.append(form);
    // What the composer's form does with a drag it can take.
    form.addEventListener("dragover", (event) => {
      event.preventDefault();
      (event as unknown as Drag).dataTransfer.dropEffect = "copy";
    });
    try {
      const over = drag("dragover", ["Files"]);
      form.dispatchEvent(over);
      expect(over.dataTransfer.dropEffect).toBe("copy");
    } finally {
      release();
      form.remove();
    }
  });

  test("is not about text being dragged within the page", async () => {
    const { guardStrayDrops } = await import("../src/lib/stray-drops");
    const release = guardStrayDrops(window as unknown as Window);
    try {
      const over = drag("dragover", ["text/plain"]);
      document.body.dispatchEvent(over);
      expect(over.defaultPrevented).toBe(false);
    } finally {
      release();
    }
  });

  test("is guarded from the first screen, before anything renders", () => {
    const main = readFileSync(join(import.meta.dir, "../src/main.tsx"), "utf8");
    const guarded = main.indexOf("guardStrayDrops();");
    expect(guarded).toBeGreaterThan(-1);
    expect(guarded).toBeLessThan(main.indexOf("createRoot("));
  });
});
