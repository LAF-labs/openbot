import { describe, expect, test } from "bun:test";
import {
  type ChunkEdges,
  lazyBoundaryOffences,
  lazyOnlyPackageOf,
  packageOf,
  staticClosure,
} from "../src/lib/build/static-closure";

/**
 * THE RULE `vite build` REFUSES A BUNDLE BY.
 *
 * `vite.config.ts` runs `lazyBoundaryOffences` over Rollup's real graph and fails the build when the
 * first screen after sign-in would statically fetch the transcript renderer or the CopilotKit
 * runtime. Shown to bite on 2026-09-13: with this config over `61a0fc8`'s sources the build stopped
 * on `_authed-*.js statically reaches markdown-*.js (marked, streamdown, react-markdown, shiki)` and
 * `copilotkit-*.js (@ag-ui/client, @copilotkit/core, @copilotkit/react-core)` — the regression audit
 * A4 measured as 706 kB of an 894 kB first load. What a screen asks for once it is drawn is
 * `first-screen.test.tsx`; this is the graph half, on graphs small enough to read.
 */

const chunk = (
  fileName: string,
  imports: string[],
  more: Partial<ChunkEdges> = {},
): ChunkEdges => ({ fileName, imports, ...more });

describe("the static closure", () => {
  test("follows static imports transitively and never a dynamic one", () => {
    const graph = [
      chunk("index-entry.js", ["vendor-react.js"], { isEntry: true }),
      chunk("vendor-react.js", []),
      // Reached from the entry only through `import()`, which Rollup never lists in `imports`.
      chunk("channel.js", ["markdown.js"]),
      chunk("markdown.js", []),
    ];
    expect(staticClosure("index-entry.js", graph).sort()).toEqual([
      "index-entry.js",
      "vendor-react.js",
    ]);
    expect(staticClosure("channel.js", graph)).toContain("markdown.js");
  });
});

describe("what counts as belonging behind the boundary", () => {
  test("a package read off a bun-isolated path and a hoisted one alike", () => {
    expect(
      packageOf(
        "/r/node_modules/.bun/streamdown@2.5.0/node_modules/streamdown/dist/index.js",
      ),
    ).toBe("streamdown");
    expect(
      packageOf(
        "/r/node_modules/.bun/@copilotkit+react-core@1.67.1+x/node_modules/@copilotkit/react-core/dist/v2/index.mjs",
      ),
    ).toBe("@copilotkit/react-core");
    expect(packageOf("/r/node_modules/react/index.js")).toBe("react");
    expect(packageOf("/r/app/src/main.tsx")).toBeNull();
  });

  test("JavaScript from the renderer or the runtime, and never their stylesheets", () => {
    expect(
      lazyOnlyPackageOf(
        "/r/node_modules/.bun/streamdown@2.5.0/node_modules/streamdown/dist/index.js",
      ),
    ).toBe("streamdown");
    // The first run of the check refused a clean build over this one: `main.tsx` imports it, and a
    // stylesheet is not the megabyte of JavaScript the boundary is about.
    expect(
      lazyOnlyPackageOf(
        "/r/node_modules/@copilotkit/react-core/dist/v2/index.css",
      ),
    ).toBeNull();
    expect(lazyOnlyPackageOf("/r/node_modules/react/index.js")).toBeNull();
  });
});

describe("the offences", () => {
  const authed = "/r/app/src/routes/_authed.tsx?tsr-split=component";
  const home = "/r/app/src/routes/_authed/_app/index.tsx?tsr-split=component";

  test("none for a graph that keeps the renderer and the runtime behind route chunks", () => {
    expect(
      lazyBoundaryOffences([
        chunk("index-entry.js", ["vendor-react.js"], { isEntry: true }),
        chunk("_authed.js", ["vendor-react.js"], { facadeModuleId: authed }),
        chunk("index-home.js", ["vendor-react.js"], { facadeModuleId: home }),
        chunk("vendor-react.js", []),
        chunk("channel.js", ["copilotkit.js", "markdown.js"], {
          facadeModuleId:
            "/r/app/src/routes/_authed/_app/channel/$channelId.tsx?tsr-split=component",
        }),
        chunk("copilotkit.js", [], { heavy: ["@copilotkit/react-core"] }),
        chunk("markdown.js", [], { heavy: ["streamdown"] }),
      ]),
    ).toEqual([]);
  });

  test("names the layout that reached them, the chunk, and what is in it — the regression as measured", () => {
    expect(
      lazyBoundaryOffences([
        chunk("index-entry.js", [], { isEntry: true }),
        chunk("_authed.js", ["copilotkit.js"], { facadeModuleId: authed }),
        chunk("copilotkit.js", ["markdown.js"], {
          heavy: ["@copilotkit/react-core"],
        }),
        chunk("markdown.js", [], { heavy: ["streamdown"] }),
      ]),
    ).toEqual([
      {
        from: "_authed.js",
        reaches: [
          { fileName: "copilotkit.js", packages: ["@copilotkit/react-core"] },
          { fileName: "markdown.js", packages: ["streamdown"] },
        ],
      },
    ]);
  });

  test("Home is a first screen too, though Rollup calls its chunk index like the entry", () => {
    expect(
      lazyBoundaryOffences([
        chunk("index-entry.js", [], { isEntry: true }),
        chunk("index-home.js", ["markdown.js"], { facadeModuleId: home }),
        chunk("markdown.js", [], { heavy: ["streamdown"] }),
      ]).map((offence) => offence.from),
    ).toEqual(["index-home.js"]);
  });
});
