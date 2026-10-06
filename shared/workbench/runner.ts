/**
 * THE LANGUAGE A SCRIPT IS WRITTEN IN — the whole of it, in this one file.
 *
 * Everything else about the workbench is the same whatever a model writes: the walls, the bounds,
 * the sweep, the protocol. What differs between languages is five things, and they are the five
 * fields of {@link Runner}: what the script's file is called, the command that runs it, the
 * environment it starts with, what has to be put beside it first, and which names in the data
 * directory mean something to the interpreter and so may not be an input's.
 *
 * TypeScript on Bun with SheetJS today, because both are already in the server's image — no byte
 * added and no second runtime. Whether a model writes sheet code well enough in it is a question
 * for a measurement, not for this file; a different verdict replaces `RUNNER` below and nothing
 * outside this file knows which language it was.
 */
import { existsSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Runner = {
  /** The script's file, in the run's own directory — never in the directory its data is in. */
  scriptName: string;
  /** The command that runs it. Its working directory is the data directory, not the script's. */
  command(scriptPath: string): string[];
  /**
   * Everything of the environment a script starts with. Nothing of the daemon's is handed on, and
   * the daemon was handed nothing worth having in the first place.
   */
  environment(directories: {
    home: string;
    temporary: string;
  }): Record<string, string>;
  /** What must be beside the script before it starts — a library it may import. */
  prepare(scriptDirectory: string): Promise<void>;
  /**
   * Names at the top of the data directory that the interpreter reads for itself. An input may not
   * land on one: its bytes are a stranger's, and a file a stranger wrote must stay data.
   */
  reserved: readonly string[];
  /**
   * What this image lacks that the runner cannot work without. Asked once, before the daemon
   * listens, so the wrong image is a service that says why it will not start and not a tool that
   * fails every script.
   */
  missing(): string[];
};

/** The one file Bun reads from the directory a script is started in. See `bunTypeScript`. */
const CONFIG = "bunfig.toml";

/**
 * TypeScript, run by Bun, with the libraries named linked in beside the script.
 *
 * `--no-install`: Bun answers an import it cannot find — when no `node_modules` is in sight — by
 * trying to download it (`converter-process.ts` measured it on a PDF). There is no network here to
 * download from, so it would only fail more slowly, and a package a model invents should fail as an
 * import that is not there. `--no-env-file`: Bun reads a `.env` from where it starts, and where a
 * script starts is the directory its data is in.
 *
 * THE SCRIPT IS NOT IN ITS DATA'S DIRECTORY. Bun resolves an import, and reads a `tsconfig.json`,
 * from the importing file's own directory upward. That directory holds the script and the linked
 * libraries and nothing an input can be. What Bun reads from the WORKING directory instead is
 * `bunfig.toml`, and a `preload` line in one is code that runs before the script. Measured
 * 2026-10-06 (Bun 1.3.11): with the script one directory up, a `bunfig.toml` in the working
 * directory naming a file beside it ran that file first; a `tsconfig.json` there with a `paths`
 * mapping was not read; a `.env` there was loaded without `--no-env-file` and not with it.
 *
 * So two locks on that one name. No input may land on it (`reserved`), and Bun is told which
 * config to read — an empty one written beside the script — which the same measurement showed
 * stops it looking in the working directory at all.
 */
export function bunTypeScript(options: {
  /** The Bun that runs a script: the daemon's own. */
  bun: string;
  /** What a script may import, by name, and where this image keeps it. */
  libraries: Readonly<Record<string, string>>;
}): Runner {
  return {
    scriptName: "main.ts",
    command: (scriptPath) => [
      options.bun,
      `--config=${join(dirname(scriptPath), CONFIG)}`,
      "--no-env-file",
      "--no-install",
      scriptPath,
    ],
    environment: ({ home, temporary }) => ({
      HOME: home,
      TMPDIR: temporary,
      // Nowhere to keep a transpiled copy, and no reason to: a run is one script, once.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      NO_COLOR: "1",
      DO_NOT_TRACK: "1",
    }),
    async prepare(scriptDirectory) {
      await writeFile(join(scriptDirectory, CONFIG), "");
      const modules = join(scriptDirectory, "node_modules");
      await mkdir(modules, { recursive: true });
      for (const [name, from] of Object.entries(options.libraries)) {
        await symlink(from, join(modules, name));
      }
    },
    reserved: [CONFIG],
    missing() {
      return [
        ...(existsSync(options.bun) ? [] : ["bun"]),
        ...Object.entries(options.libraries)
          .filter(([, from]) => !existsSync(join(from, "package.json")))
          .map(([name]) => name),
      ];
    },
  };
}

/**
 * The runner of the image compose runs this service from.
 *
 * The server's image: its own Bun, and SheetJS where the server's production install put it
 * (`server/Dockerfile`). The one library, on purpose — a script is offered what it is told it has.
 */
export const RUNNER: Runner = bunTypeScript({
  bun: process.execPath,
  libraries: { xlsx: "/app/server/node_modules/xlsx" },
});
