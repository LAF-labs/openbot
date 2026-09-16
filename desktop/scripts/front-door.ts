/**
 * The desktop shell's front door: what a release puts on
 * `https://agent.laf-co.com/desktop/`, and the one way it gets there.
 *
 * WHY NOT GITHUB. The updater used to read this repository's
 * `releases/latest/download/latest.json`. The repository was private from
 * 2026-09-10 to 2026-09-16, and for that week the URL answered 404 to anybody
 * without an account — every installed app, and every person who had not bought
 * anything yet. So the tag build carries the signed files to the fleet's own
 * front door, the one address every installed app already trusts, and a
 * visibility change can no longer stop an update.
 *
 *   bun desktop/scripts/front-door.ts --from <artifacts> --stage <dir> [--version X.Y.Z]
 *                                     [--key <file> --known-hosts <file>]
 *
 * `--from` is whatever the build jobs left (walked, so the layout of a
 * downloaded artifact does not matter). Without `--key` it only stages. With
 * it, the staged version goes over ssh as a tar on stdin to `laf-desktop@<host>`
 * — a key the entry VM forces into one receiver (laf-control
 * `core/desktop-door.ts`, installed by `laf desktop door`) — and is then read
 * back from outside, byte for byte.
 *
 * WHAT IS REFUSED HERE, BEFORE ANY CONNECTION: an updater signature made by any
 * key but the one `tauri.conf.json` embeds, or over any bytes but these. The
 * installed app refuses such an update silently — it logs a failed check and
 * keeps running the old version, forever — so the one moment to learn it is
 * before the feed is published, not after.
 *
 * The host, the path and the signing key all come from `tauri.conf.json`: the
 * feed's URLs are the endpoint's directory, so the app and the feed cannot
 * disagree about where the door is.
 */
import {
  createHash,
  createPublicKey,
  type KeyObject,
  verify,
} from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

/** The account the entry VM forces into the receiver (laf-control core/desktop-door.ts DOOR_USER). */
export const DOOR_USER = "laf-desktop";

/**
 * The names the door serves. Tauri's own carry spaces and the version (`LAF Agent_0.5.0_universal.dmg`);
 * these are what a person downloads and what a URL can say without escaping. The Windows updater bundle
 * IS the NSIS installer — Tauri 2 signs the `-setup.exe` itself — so there is no separate Windows bundle.
 */
export const DOOR_FILES = {
  macInstaller: "LAF-Agent-mac.dmg",
  windowsInstaller: "LAF-Agent-windows.exe",
  macBundle: "LAF-Agent-mac.app.tar.gz",
  macSignature: "LAF-Agent-mac.app.tar.gz.sig",
  windowsSignature: "LAF-Agent-windows.exe.sig",
  feed: "latest.json",
} as const;

const VERSION = /^\d+\.\d+\.\d+$/;

export type ShellConfig = {
  plugins?: { updater?: { pubkey?: string; endpoints?: string[] } };
};

export type Door = { base: string; host: string; pubkey: string };

/** Where the door is, as the installed app will look for it. */
export function doorOf(config: ShellConfig): Door {
  const endpoints = config.plugins?.updater?.endpoints ?? [];
  const pubkey = config.plugins?.updater?.pubkey ?? "";
  const [endpoint] = endpoints;
  if (endpoints.length !== 1 || !endpoint) {
    throw new Error(
      `tauri.conf.json must name exactly one updater endpoint, and names ${endpoints.length}`,
    );
  }
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" ||
    !url.pathname.endsWith(`/${DOOR_FILES.feed}`) ||
    url.search
  ) {
    throw new Error(
      `the updater endpoint ${endpoint} is not an https …/${DOOR_FILES.feed}`,
    );
  }
  if (!pubkey) throw new Error("tauri.conf.json has no updater pubkey");
  return {
    base: `${url.origin}${url.pathname.slice(0, -DOOR_FILES.feed.length)}`,
    host: url.hostname,
    pubkey,
  };
}

type PublicKey = { id: string; keyId: Buffer; key: KeyObject };

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const keyName = (keyId: Buffer) =>
  Buffer.from(keyId).reverse().toString("hex").toUpperCase();

/** The pubkey as Tauri stores it: base64 of minisign's two-line public key file. */
export function readPublicKey(pubkey: string): PublicKey {
  const raw = Buffer.from(
    Buffer.from(pubkey, "base64").toString("utf8").trim().split("\n")[1] ?? "",
    "base64",
  );
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("the updater pubkey is not a minisign Ed25519 public key");
  }
  const keyId = raw.subarray(2, 10);
  return {
    id: keyName(keyId),
    keyId,
    key: createPublicKey({
      key: Buffer.concat([SPKI_ED25519, raw.subarray(10)]),
      format: "der",
      type: "spki",
    }),
  };
}

/**
 * A `.sig` exactly as the updater will judge it (minisign-verify): the key id, the signature over the
 * bytes — BLAKE2b-512 of them for `ED`, the bytes themselves for legacy `Ed` — and the global signature
 * over the trusted comment.
 */
export function verifySignature(
  publicKey: PublicKey,
  data: Uint8Array,
  signatureFile: string,
  label: string,
): void {
  const lines = Buffer.from(signatureFile.trim(), "base64")
    .toString("utf8")
    .split("\n");
  const signature = Buffer.from(lines[1] ?? "", "base64");
  const trusted = lines[2] ?? "";
  const global = Buffer.from(lines[3] ?? "", "base64");
  if (
    signature.length !== 74 ||
    !trusted.startsWith("trusted comment: ") ||
    global.length !== 64
  ) {
    throw new Error(`${label}.sig is not a minisign signature`);
  }
  const keyId = signature.subarray(2, 10);
  if (!keyId.equals(publicKey.keyId)) {
    throw new Error(
      `${label} is signed by key ${keyName(keyId)}, and tauri.conf.json trusts ${publicKey.id}: every installed app would refuse this update`,
    );
  }
  const algorithm = signature.subarray(0, 2).toString("latin1");
  const message =
    algorithm === "ED"
      ? createHash("blake2b512").update(data).digest()
      : algorithm === "Ed"
        ? data
        : undefined;
  if (!message)
    throw new Error(`${label}.sig uses an algorithm the updater does not know`);
  if (!verify(null, message, publicKey.key, signature.subarray(10))) {
    throw new Error(`${label}.sig does not match these bytes`);
  }
  const comment = Buffer.from(
    trusted.slice("trusted comment: ".length),
    "utf8",
  );
  if (
    !verify(
      null,
      Buffer.concat([signature.subarray(10), comment]),
      publicKey.key,
      global,
    )
  ) {
    throw new Error(`${label}.sig has a trusted comment its key did not sign`);
  }
}

/** The static feed the updater reads: every platform it may ask for, each at this version's own URL. */
export function latestJson(input: {
  version: string;
  base: string;
  macSignature: string;
  windowsSignature: string;
  pubDate: string;
}): string {
  const at = (name: string) => `${input.base}${input.version}/${name}`;
  const mac = { signature: input.macSignature, url: at(DOOR_FILES.macBundle) };
  const windows = {
    signature: input.windowsSignature,
    url: at(DOOR_FILES.windowsInstaller),
  };
  // The updater asks for `{os}-{arch}-{installer}` first and `{os}-{arch}` after it (tauri-plugin-updater
  // get_urls); both spellings, for both Mac architectures the universal bundle serves.
  return `${JSON.stringify(
    {
      version: input.version,
      notes: `LAF Agent ${input.version}`,
      pub_date: input.pubDate,
      platforms: {
        "darwin-aarch64": mac,
        "darwin-x86_64": mac,
        "darwin-aarch64-app": mac,
        "darwin-x86_64-app": mac,
        "windows-x86_64": windows,
        "windows-x86_64-nsis": windows,
      },
    },
    null,
    2,
  )}\n`;
}

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.isFile()
        ? [join(dir, entry.name)]
        : [],
  );

type Found = {
  version: string;
  macInstaller: string;
  windowsInstaller: string;
  updater: {
    macBundle: string;
    macSignature: string;
    windowsSignature: string;
  } | null;
};

/** What the build jobs left, by Tauri's names: two installers, and from a tag the three updater files. */
export function findBundles(from: string): Found {
  const files = walk(from);
  const pick = (
    what: string,
    suffix: string,
    required: boolean,
  ): string | undefined => {
    const hits = files.filter((file) => file.endsWith(suffix));
    if (hits.length > 1 || (required && hits.length === 0)) {
      throw new Error(
        `expected ${required ? "exactly one" : "at most one"} ${what} (*${suffix}) under ${from}, found ${hits.length}${
          hits.length ? `: ${hits.map((hit) => basename(hit)).join(", ")}` : ""
        }`,
      );
    }
    return hits[0];
  };
  const macInstaller = pick(
    "macOS installer",
    "_universal.dmg",
    true,
  ) as string;
  const windowsInstaller = pick(
    "Windows installer",
    "_x64-setup.exe",
    true,
  ) as string;
  const macBundle = pick("macOS updater bundle", ".app.tar.gz", false);
  const macSignature = pick(
    "macOS updater signature",
    ".app.tar.gz.sig",
    false,
  );
  const windowsSignature = pick(
    "Windows updater signature",
    "_x64-setup.exe.sig",
    false,
  );

  const macVersion = /_(\d+\.\d+\.\d+)_universal\.dmg$/.exec(
    basename(macInstaller),
  )?.[1];
  const windowsVersion = /_(\d+\.\d+\.\d+)_x64-setup\.exe$/.exec(
    basename(windowsInstaller),
  )?.[1];
  if (!macVersion || macVersion !== windowsVersion) {
    throw new Error(
      `the installers disagree about their version: ${basename(macInstaller)} and ${basename(windowsInstaller)}`,
    );
  }

  const updater = [macBundle, macSignature, windowsSignature];
  if (updater.every((file) => !file))
    return {
      version: macVersion,
      macInstaller,
      windowsInstaller,
      updater: null,
    };
  if (!macBundle || !macSignature || !windowsSignature) {
    throw new Error(
      "the update feed needs the mac bundle and both signatures; a build that signed one platform would leave the other on its old version without a word",
    );
  }
  return {
    version: macVersion,
    macInstaller,
    windowsInstaller,
    updater: { macBundle, macSignature, windowsSignature },
  };
}

export type Staged = {
  version: string;
  root: string;
  dir: string;
  feed: boolean;
  files: string[];
  door: Door;
};

/** `<stage>/<version>/` under the door's names, with `latest.json` when — and only when — the signatures verify. */
export function stageRelease(options: {
  from: string;
  stage: string;
  config: ShellConfig;
  version?: string;
  now?: Date;
}): Staged {
  const door = doorOf(options.config);
  const found = findBundles(options.from);
  if (options.version !== undefined && options.version !== found.version) {
    throw new Error(
      `the tag says ${options.version} and the installers say ${found.version}`,
    );
  }
  if (!VERSION.test(found.version))
    throw new Error(`${found.version} is not X.Y.Z`);
  const dir = join(options.stage, found.version);
  mkdirSync(dir, { recursive: true });
  copyFileSync(found.macInstaller, join(dir, DOOR_FILES.macInstaller));
  copyFileSync(found.windowsInstaller, join(dir, DOOR_FILES.windowsInstaller));
  if (found.updater) {
    const publicKey = readPublicKey(door.pubkey);
    const macSignature = readFileSync(found.updater.macSignature, "utf8");
    const windowsSignature = readFileSync(
      found.updater.windowsSignature,
      "utf8",
    );
    verifySignature(
      publicKey,
      readFileSync(found.updater.macBundle),
      macSignature,
      basename(found.updater.macBundle),
    );
    verifySignature(
      publicKey,
      readFileSync(found.windowsInstaller),
      windowsSignature,
      basename(found.windowsInstaller),
    );
    copyFileSync(found.updater.macBundle, join(dir, DOOR_FILES.macBundle));
    writeFileSync(join(dir, DOOR_FILES.macSignature), macSignature);
    writeFileSync(join(dir, DOOR_FILES.windowsSignature), windowsSignature);
    writeFileSync(
      join(dir, DOOR_FILES.feed),
      latestJson({
        version: found.version,
        base: door.base,
        macSignature,
        windowsSignature,
        pubDate: (options.now ?? new Date()).toISOString(),
      }),
    );
  }
  return {
    version: found.version,
    root: options.stage,
    dir,
    feed: found.updater !== null,
    files: readdirSync(dir).sort(),
    door,
  };
}

/** The staged version over ssh, as a tar on stdin; the receiver's own lines are the log. */
export async function publish(
  staged: Staged,
  options: { key: string; knownHosts: string },
): Promise<void> {
  const tar = Bun.spawn(
    ["tar", "--format=ustar", "-C", staged.root, "-cf", "-", staged.version],
    {
      // macOS tar would otherwise add AppleDouble `._` members, which the receiver refuses by name.
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const ssh = Bun.spawn(
    [
      "ssh",
      "-F",
      "/dev/null",
      "-i",
      options.key,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=20",
      "-o",
      `UserKnownHostsFile=${options.knownHosts}`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "StrictHostKeyChecking=yes",
      `${DOOR_USER}@${staged.door.host}`,
      // Ignored by the forced command; an exec request rather than a shell keeps a login banner out of the log.
      "receive",
    ],
    { stdin: tar.stdout, stdout: "inherit", stderr: "inherit" },
  );
  const [sent, received] = await Promise.all([tar.exited, ssh.exited]);
  if (received !== 0)
    throw new Error(
      `the door did not take ${staged.version} (ssh exit ${received}); its reason is above`,
    );
  if (sent !== 0)
    throw new Error(`tar exited ${sent} while sending ${staged.version}`);
}

const sha256 = (bytes: ArrayBuffer | Uint8Array) =>
  createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

/** Read back from outside, the way a person and the updater will: the installers byte for byte, the feed by version. */
export async function readBack(
  staged: Staged,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const lines: string[] = [];
  for (const name of [DOOR_FILES.macInstaller, DOOR_FILES.windowsInstaller]) {
    const url = `${staged.door.base}${name}`;
    const response = await fetcher(url, {
      redirect: "manual",
      cache: "no-store",
    });
    const body = await response.arrayBuffer();
    const expected = readFileSync(join(staged.dir, name));
    if (response.status !== 200 || sha256(body) !== sha256(expected)) {
      throw new Error(
        `${url} answered ${response.status} with ${body.byteLength} bytes, and ${staged.version}'s ${name} is ${statSync(join(staged.dir, name)).size}`,
      );
    }
    lines.push(
      `${url} 200, ${body.byteLength} bytes, sha256 ${sha256(body).slice(0, 12)}`,
    );
  }
  const feedUrl = `${staged.door.base}${DOOR_FILES.feed}`;
  const feed = await fetcher(feedUrl, {
    redirect: "manual",
    cache: "no-store",
  });
  if (staged.feed) {
    const served =
      feed.status === 200
        ? ((await feed.json()) as { version?: string }).version
        : undefined;
    if (served !== staged.version) {
      throw new Error(
        `${feedUrl} answered ${feed.status} with version ${served}, not ${staged.version}`,
      );
    }
    lines.push(`${feedUrl} 200, version ${served}`);
  } else {
    lines.push(
      `${feedUrl} ${feed.status}: no update feed until a tag build signs one`,
    );
  }
  return lines;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      stage: { type: "string" },
      version: { type: "string" },
      key: { type: "string" },
      "known-hosts": { type: "string" },
    },
  });
  if (
    !values.from ||
    !values.stage ||
    Boolean(values.key) !== Boolean(values["known-hosts"])
  ) {
    console.error(
      "usage: bun desktop/scripts/front-door.ts --from <artifacts> --stage <dir> [--version X.Y.Z] [--key <file> --known-hosts <file>]",
    );
    process.exit(64);
  }
  const configPath = join(
    import.meta.dir,
    "..",
    "src-tauri",
    "tauri.conf.json",
  );
  try {
    const staged = stageRelease({
      from: values.from,
      stage: values.stage,
      config: JSON.parse(readFileSync(configPath, "utf8")) as ShellConfig,
      ...(values.version ? { version: values.version } : {}),
    });
    console.log(
      `staged ${staged.version} for ${staged.door.base}: ${staged.files.join(", ")}${staged.feed ? "" : " (no update feed: installers only)"}`,
    );
    if (values.key && values["known-hosts"]) {
      await publish(staged, {
        key: values.key,
        knownHosts: values["known-hosts"],
      });
      for (const line of await readBack(staged)) console.log(line);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
