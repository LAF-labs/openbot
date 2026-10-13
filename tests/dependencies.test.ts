import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What we depend on is a decision, written down here, once.
 *
 * Three rules, each read from the tree and nothing else:
 *
 * 1. Every direct dependency of every workspace `package.json` is on the list below with a reason,
 *    and the list names nothing a `package.json` has dropped. A new line in a `package.json` fails
 *    here until somebody writes why it is worth carrying; a line on the list that nothing installs
 *    any more fails too, so the list cannot rot.
 * 2. Every package `bun.lock` installs carries a licence from the permissive allow-list, read from
 *    its own `package.json`. Anything else — a licence not on the list, or no `license` field at
 *    all — is named in the exceptions table with the file or URL its licence was read from. A bump
 *    re-asks: the table is keyed by version.
 * 3. Nothing is fetched from anywhere but the npm registry, except what the outside list names.
 *
 * The packages are read from bun's own store. `bun install` here is isolated (`bun.lock`'s
 * `configVersion: 1`): `node_modules/<name>` in a workspace is a symlink into
 * `node_modules/.bun/<name>@<version>/node_modules/<name>`, where the real files are, beside symlinks
 * to that package's own dependencies. A naive walk of `node_modules` sees the six root packages and
 * stops; the store is walked instead, and a directory that is not a symlink is a package.
 *
 * Packages in the lock that the store does not hold are the other platforms' binaries — every
 * `optionalDependencies` entry bun chose not to fetch here, and what only those depend on. A package
 * missing for any other reason fails, so "not installed" cannot hide a package from rule 2.
 */

const root = join(import.meta.dir, "..");

// Why each direct dependency is here. One line each; a package that needs a paragraph is a question.
const DECIDED: Record<string, Record<string, string>> = {
  "": {
    "@biomejs/biome": "the gate's lint and format",
    "@types/bun": "Bun's own types, for typecheck",
    knip: "the gate's reachability check (tests/knip.test.ts)",
    roughjs: "draws the architecture diagram (scripts/architecture-diagram.ts)",
    typescript: "the gate's typecheck",
    yaml: "reads the tenant package and compose files in tests and scripts",
  },
  app: {
    "@ag-ui/core": "the AG-UI event and message types the transcript reads",
    "@base-ui/react": "the unstyled primitives under components/ui",
    "@shadcn/react":
      "the message scroller primitive (components/ui/message-scroller.tsx)",
    "@tabler/icons-react": "the icon set",
    "@tanstack/react-form": "the skill fields and the credentials form",
    "@tanstack/react-query": "server state",
    "@tanstack/react-router": "file-based routes",
    "better-auth": "the sign-in client",
    "class-variance-authority": "variant props on the ui primitives",
    clsx: "joins class names (lib/utils.ts)",
    motion:
      "the few animations: panels, stagger, the greeting, the sign screen",
    pretendard:
      "the typeface, shipped as the package's own files (THIRD_PARTY_NOTICES.md)",
    "prompt-area": "the composer's editor",
    react: "the view",
    "react-dom": "the view",
    "remark-cjk-friendly":
      "Korean emphasis in markdown without the spaces CommonMark wants",
    "remark-cjk-friendly-gfm-strikethrough": "the same for ~~strikethrough~~",
    streamdown: "renders the Bot's markdown as it streams",
    "tailwind-merge": "resolves conflicting Tailwind classes (lib/utils.ts)",
    "tw-animate-css": "the animation utilities styles.css imports",
    zod: "schemas for what the gallery cards and tools receive",
    "@babel/core": "the React Compiler coverage check parses with it",
    "@happy-dom/global-registrator": "a DOM for the component tests",
    "@tailwindcss/vite": "Tailwind 4 in the Vite build",
    "@tanstack/router-plugin": "generates the route tree",
    "@types/babel__core": "types for the above",
    "@types/node": "Node's types, for the Vite config",
    "@types/react": "React's types",
    "@types/react-dom": "React DOM's types",
    "@vitejs/plugin-react": "React in Vite, with the compiler plugin",
    "babel-plugin-react-compiler":
      "the React Compiler (CLAUDE.md, 'The React Compiler compiles the app')",
    tailwindcss: "the stylesheet's framework",
    vite: "the app's build and dev server",
  },
  server: {
    "@ag-ui/client": "dials every Bot's AG-UI endpoint",
    "@better-auth/drizzle-adapter": "sign-in's tables through Drizzle",
    "@modelcontextprotocol/sdk": "plugins that are MCP servers",
    "@typesafe-ai/sdk": "the boundary's decision call, typed",
    "better-auth": "sign-in",
    "cel-js": "the boundary rules' expression language (computer/policy.ts)",
    "drizzle-kit": "migrations",
    "drizzle-orm": "the database",
    "file-type":
      "what an upload really is, by its bytes (attachments/files.ts)",
    hono: "the API",
    postgres: "the Postgres driver",
    unpdf: "the text of an uploaded PDF (attachments/extract.ts)",
    xlsx: "the cells of an uploaded sheet, as CSV",
    yaml: "reads the tenant package",
    "@copilotkit/aimock": "a mock model for the live agent-connection test",
  },
  "agent-bot": {
    "@ag-ui/core": "the AG-UI event types every run emits",
    "@ag-ui/encoder": "encodes them for the wire",
    openai: "the model, through an OpenAI-shaped endpoint",
  },
  "agent-computer": {
    "@mozilla/readability": "reads a page as its article",
    playwright: "the Bot's browser",
    yaml: "reads the tenant package",
    typescript: "its own typecheck in the image",
  },
  desktop: {
    "@tauri-apps/cli": "builds the shell",
  },
};

// SPDX identifiers that ask only for attribution. An `OR` expression is allowed when any side is;
// an `AND` when every side is.
const ALLOWED = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "MIT-0",
  "Python-2.0",
  "OFL-1.1",
]);

type Exception = {
  // The SPDX identifier the file or page below says.
  licence: string;
  // Where it was read: a path inside the package, checked to exist, or a URL.
  read: string;
};

// A package whose `package.json` carries no `license` string, or one the allow-list does not name.
// Keyed by `name@version`; a name ending in `*` covers a family of platform binaries at that version.
const EXCEPTIONS: Record<string, Exception> = {
  // The AG-UI protocol packages ship no `license` field; the file in each is the MIT text, one copy
  // (https://github.com/ag-ui-protocol/ag-ui/blob/main/LICENSE).
  "@ag-ui/core@0.0.57": { licence: "MIT", read: "LICENSE" },
  "@ag-ui/client@0.0.57": { licence: "MIT", read: "LICENSE" },
  "@ag-ui/encoder@0.0.57": { licence: "MIT", read: "LICENSE" },
  "@ag-ui/proto@0.0.57": { licence: "MIT", read: "LICENSE" },
  // Browser-support data under browserslist, used at build time by Tailwind and Vite. Attribution
  // only; the data never ships.
  "caniuse-lite@1.0.30001809": { licence: "CC-BY-4.0", read: "LICENSE" },
  // WEAK COPYLEFT, named and not hidden: the Mozilla Public License 2.0 asks that changes to ITS
  // OWN files be published, and nothing more. lightningcss is Tailwind 4's CSS transformer, run at
  // build time by @tailwindcss/node; none of it is bundled into what a person's device receives,
  // and nothing of ours modifies it. Reported to the coordinator 2026-10-13 with this test; the
  // decision whether to carry it is the owner's, not this table's.
  "lightningcss@1.32.0": { licence: "MPL-2.0", read: "LICENSE" },
  "lightningcss-*@1.32.0": { licence: "MPL-2.0", read: "LICENSE" },
};

// Packages fetched from somewhere other than the npm registry, with why. `name@spec`, as the lock
// writes them.
const OUTSIDE_THE_REGISTRY: Record<string, string> = {
  // SheetJS stopped publishing to npm at 0.18.5 and serves newer builds from its own CDN. Adopted
  // in 868c4e86 (2026-09-26, the attachments feature), which records the source and that it is
  // Apache-2.0 and nothing more; the tarball is pinned by its integrity hash in bun.lock.
  "xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz":
    "SheetJS 0.20.x exists only on cdn.sheetjs.com",
};

// ---------------------------------------------------------------------------------------------------

type Manifest = {
  name?: string;
  version?: string;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  license?: unknown;
};

function manifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

function directDependencies(m: Manifest): string[] {
  return [
    ...Object.keys(m.dependencies ?? {}),
    ...Object.keys(m.devDependencies ?? {}),
    ...Object.keys(m.optionalDependencies ?? {}),
    ...Object.keys(m.peerDependencies ?? {}),
  ].sort();
}

/** Whether an SPDX expression is covered by the allow-list: any `OR` side, every `AND` side. */
function allowed(expression: string): boolean {
  const bare = expression
    .trim()
    .replace(/^\((.*)\)$/, "$1")
    .trim();
  if (bare === "") return false;
  return bare
    .split(/\s+OR\s+/)
    .some((side) =>
      side
        .split(/\s+AND\s+/)
        .every((atom) => ALLOWED.has(atom.replace(/[()]/g, "").trim())),
    );
}

type LockPackage = [
  id: string,
  registry?: unknown,
  meta?: unknown,
  integrity?: unknown,
];

function splitId(id: string): { name: string; spec: string } {
  const at = id.lastIndexOf("@");
  return { name: id.slice(0, at), spec: id.slice(at + 1) };
}

const lock = Bun.JSONC.parse(readFileSync(join(root, "bun.lock"), "utf8")) as {
  packages: Record<string, LockPackage>;
};

type Installed = {
  name: string;
  version: string;
  dir: string;
  licence: string | undefined;
};

// The real packages in bun's store, by name. A store entry's `node_modules` holds one package as a
// directory and its dependencies as symlinks; scoped names sit one level down.
function readStore(): Map<string, Installed[]> {
  const store = join(root, "node_modules", ".bun");
  const byName = new Map<string, Installed[]>();
  const take = (dir: string, name: string) => {
    const file = join(dir, "package.json");
    if (!existsSync(file)) return;
    const m = manifest(file);
    const entry: Installed = {
      name,
      version: m.version ?? "",
      dir,
      licence: typeof m.license === "string" ? m.license : undefined,
    };
    byName.set(name, [...(byName.get(name) ?? []), entry]);
  };
  for (const entry of readdirSync(store)) {
    const modules = join(store, entry, "node_modules");
    if (entry.startsWith(".") || !existsSync(modules)) continue;
    for (const child of readdirSync(modules)) {
      if (child.startsWith(".")) continue;
      const path = join(modules, child);
      if (lstatSync(path).isSymbolicLink()) continue;
      if (child.startsWith("@")) {
        for (const grandchild of readdirSync(path)) {
          const scoped = join(path, grandchild);
          if (!lstatSync(scoped).isSymbolicLink())
            take(scoped, `${child}/${grandchild}`);
        }
      } else {
        take(path, child);
      }
    }
  }
  return byName;
}

const store = readStore();

// Every distinct package the lock resolves, once: nested keys (`parent/child`) alias the same tuple.
const locked = new Map<string, LockPackage>();
for (const tuple of Object.values(lock.packages)) locked.set(tuple[0], tuple);

function findInstalled(id: string): Installed | undefined {
  const { name, spec } = splitId(id);
  const candidates = store.get(name) ?? [];
  // A version the registry gave is matched exactly; a URL tarball's manifest says its own version.
  return /^\d/.test(spec)
    ? candidates.find((c) => c.version === spec)
    : candidates[0];
}

function exceptionFor(name: string, version: string): Exception | undefined {
  const exact = EXCEPTIONS[`${name}@${version}`];
  if (exact) return exact;
  for (const [key, exception] of Object.entries(EXCEPTIONS)) {
    const { name: pattern, spec } = splitId(key);
    if (
      pattern.endsWith("*") &&
      name.startsWith(pattern.slice(0, -1)) &&
      spec === version
    ) {
      return exception;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------

const rootManifest = manifest(join(root, "package.json"));
const workspaces = ["", ...(rootManifest.workspaces ?? [])];

describe("what we depend on", () => {
  test.each(workspaces)(
    "%s/package.json names only decided dependencies, and all of them",
    (ws) => {
      const direct = directDependencies(
        manifest(join(root, ws, "package.json")),
      );
      const decided = Object.keys(DECIDED[ws] ?? {}).sort();
      // A new dependency is a decision: write why it is here before the gate lets it in.
      expect(direct.filter((name) => !decided.includes(name))).toEqual([]);
      // A reason for a package nothing installs is a line that will mislead the next reader.
      expect(decided.filter((name) => !direct.includes(name))).toEqual([]);
      expect(direct.length).toBeGreaterThan(0);
    },
  );

  test("the list covers every workspace the root names, and no other", () => {
    expect(Object.keys(DECIDED).sort()).toEqual([...workspaces].sort());
    expect(workspaces).toContain("app");
    expect(workspaces).toContain("server");
  });
});

describe("licences", () => {
  test.each([
    ["MIT", true],
    ["(MIT OR GPL-3.0)", true],
    ["(Apache-2.0 AND BSD-3-Clause)", true],
    ["GPL-3.0", false],
    ["(GPL-2.0 AND MIT)", false],
    ["", false],
  ])("the allow-list reads %j as %p", (expression, verdict) => {
    expect(allowed(expression)).toBe(verdict);
  });

  test("every installed package is permissive or named as an exception", () => {
    const refused: string[] = [];
    for (const id of locked.keys()) {
      const installed = findInstalled(id);
      if (!installed) continue;
      const { name, version, licence } = installed;
      if (licence !== undefined && allowed(licence)) continue;
      const exception = exceptionFor(name, version);
      if (exception) continue;
      refused.push(`${name}@${version}: ${licence ?? "no license field"}`);
    }
    expect(refused).toEqual([]);
    // That the store was read at all, not how big it should be: 470 packages on a Mac on
    // 2026-10-13, once CopilotKit's client had left the app and taken 211 names with it (the bound
    // was 500 against the store before that).
    expect(store.size).toBeGreaterThan(400);
  });

  test("every exception names a package the lock holds and a file that says what it claims", () => {
    const stale: string[] = [];
    const unread: string[] = [];
    const lockedNames = [...locked.keys()].map(splitId);
    for (const [key, exception] of Object.entries(EXCEPTIONS)) {
      const { name: pattern, spec } = splitId(key);
      const matches = pattern.endsWith("*")
        ? lockedNames.filter(
            (p) => p.name.startsWith(pattern.slice(0, -1)) && p.spec === spec,
          )
        : lockedNames.filter((p) => p.name === pattern && p.spec === spec);
      if (matches.length === 0) stale.push(key);
      // An exception whose licence the allow-list already takes is a line that hides a bump.
      for (const match of matches) {
        const installed = findInstalled(`${match.name}@${match.spec}`);
        if (!installed) continue;
        if (installed.licence !== undefined && allowed(installed.licence)) {
          stale.push(`${key} (package.json already says ${installed.licence})`);
        }
        if (
          !/^https?:\/\//.test(exception.read) &&
          !existsSync(join(installed.dir, exception.read))
        ) {
          unread.push(`${key}: no ${exception.read} in ${installed.dir}`);
        }
      }
    }
    expect(stale).toEqual([]);
    expect(unread).toEqual([]);
  });

  test("a package the store lacks is another platform's binary, not a gap", () => {
    const optional = new Set<string>();
    const dependents = new Map<string, Set<string>>();
    for (const [id, tuple] of locked) {
      const meta = (tuple[2] ?? {}) as {
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      for (const name of Object.keys(meta.optionalDependencies ?? {}))
        optional.add(name);
      for (const name of Object.keys(meta.dependencies ?? {})) {
        dependents.set(name, (dependents.get(name) ?? new Set()).add(id));
      }
    }
    const unexplained: string[] = [];
    for (const id of locked.keys()) {
      const { name, spec } = splitId(id);
      if (spec.startsWith("workspace:") || findInstalled(id)) continue;
      if (optional.has(name)) continue;
      // Reached only through packages that are themselves not installed (a wasm fallback's runtime).
      const parents = [...(dependents.get(name) ?? [])];
      if (
        parents.length > 0 &&
        parents.every((parent) => !findInstalled(parent))
      )
        continue;
      unexplained.push(id);
    }
    expect(unexplained).toEqual([]);
  });
});

describe("where packages come from", () => {
  test("every package is the registry's, except the ones named", () => {
    const outside: string[] = [];
    for (const [id, tuple] of locked) {
      const { spec } = splitId(id);
      if (spec.startsWith("workspace:")) continue;
      const fromRegistry =
        /^\d/.test(spec) && tuple.length === 4 && tuple[1] === "";
      if (fromRegistry || id in OUTSIDE_THE_REGISTRY) continue;
      outside.push(id);
    }
    expect(outside).toEqual([]);
    // The outside list cannot rot either.
    expect(
      Object.keys(OUTSIDE_THE_REGISTRY).filter((id) => !locked.has(id)),
    ).toEqual([]);
  });
});
