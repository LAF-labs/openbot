import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  DOOR_FILES,
  DOOR_USER,
  doorOf,
  latestJson,
  readPublicKey,
  type ShellConfig,
  stageRelease,
  verifySignature,
} from "../desktop/scripts/front-door";

/**
 * Where installed apps find their next version, and what a release is allowed to put there.
 *
 * Until 2026-09-14 the updater read `github.com/LAF-labs/openbot/releases/latest/download/latest.json`,
 * and since the repository went private on 2026-09-10 that URL answered 404 to every installed app —
 * measured, anonymously. Nothing failed loudly: the app logged a failed check and kept running.
 * The feed now lives on the fleet's front door, and a feed is only written when its signatures
 * verify against the key the app embeds — the other silent way an update never arrives.
 */

const repositoryRoot = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(repositoryRoot, path), "utf8");
const shellConfig = JSON.parse(
  read("desktop/src-tauri/tauri.conf.json"),
) as ShellConfig;

/**
 * Signed by `tauri signer sign` (tauri-cli 2.11.4) with a throwaway key made for these tests — key id
 * 4488DA32A552B3CC, private half deleted the same minute. Real minisign output, so the verifier is
 * judged against what the bundler writes rather than against its own idea of the format.
 */
const FIXTURE = {
  pubkey:
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ0ODhEQTMyQTU1MkIzQ0MKUldUTXMxS2xNdHFJUlBoZkdEdVdFN0FaTUV1dE4xWE83bW9CcTc4Uk9taWJDaVREUXJObURQdW4K",
  version: "9.9.1",
  mac: {
    bundle: "mac updater bundle fixture\n",
    signature:
      "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUTXMxS2xNdHFJUkZEbSs3am41UW90VnRXM0orNjhTemM5ZjBDQzJuQ3o1ODlzSG5SdjczS0ZoN1A5YmxVZ2lHYmxrREVFc2FBNkRMVnJaTGFMc3FLaDErdi9kcHVmN2c0PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg5MzU4ODM2CWZpbGU6TEFGIEFnZW50LmFwcC50YXIuZ3oKUWViZUdiMzk3MHVObWRwL2xZSEVzQ0FaQXBJUUdnWlhyVnNPUlMwdFVLUEZyL1hJOGR5SjBSZGc5TU9WWkxNdkFuSlgxeWl6UUNlTGdWTmR1em0vQlE9PQo=",
  },
  windows: {
    installer: "windows installer fixture\n",
    signature:
      "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUTXMxS2xNdHFJUk1Td1VqQnNDNEdRWjhidE5Kdk1mdHMzSGdNYzJ3dHIzSFZXVkdFRktJQWVaL3NVUm9JK1FZWi9mMXorcStqczhyeHJIMjBJZEVkc2kyb2xuWXBPMmdvPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg5MzU4ODM2CWZpbGU6TEFGIEFnZW50XzkuOS4xX3g2NC1zZXR1cC5leGUKS0pIbDZCUFVUTndab2dRcDcxQXlhd3BGY3FIZFRPTzlFYzZGZWF1bDgzeHNDYTBCaU5EMldvME9OS2RwcG5zUzU0ZE5SeFFKa3hWM1Jmd3UzWEZIREE9PQo=",
  },
};

const fixtureConfig: ShellConfig = {
  plugins: {
    updater: {
      pubkey: FIXTURE.pubkey,
      endpoints: ["https://door.test/desktop/latest.json"],
    },
  },
};

const scratch = mkdtempSync(join(tmpdir(), "front-door-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * The tree `actions/download-artifact` leaves in the door job: one directory per platform's
 * artifact, Tauri's own names inside (`bundle/dmg`, `bundle/macos`, `bundle/nsis`).
 */
const artifacts = (options: {
  version?: string;
  windowsVersion?: string;
  updater?: boolean;
  omit?: string[];
  overrides?: Record<string, string>;
}) => {
  const version = options.version ?? FIXTURE.version;
  const from = mkdtempSync(join(scratch, "in-"));
  const files: Record<string, string> = {
    [`door-macos/dmg/LAF Agent_${version}_universal.dmg`]: "a universal dmg\n",
    [`door-windows/LAF Agent_${options.windowsVersion ?? version}_x64-setup.exe`]:
      FIXTURE.windows.installer,
  };
  if (options.updater !== false) {
    files["door-macos/macos/LAF Agent.app.tar.gz"] = FIXTURE.mac.bundle;
    files["door-macos/macos/LAF Agent.app.tar.gz.sig"] = FIXTURE.mac.signature;
    files[
      `door-windows/LAF Agent_${options.windowsVersion ?? version}_x64-setup.exe.sig`
    ] = FIXTURE.windows.signature;
  }
  for (const [path, content] of Object.entries({
    ...files,
    ...options.overrides,
  })) {
    if (options.omit?.some((suffix) => path.endsWith(suffix))) continue;
    mkdirSync(join(from, path, ".."), { recursive: true });
    writeFileSync(join(from, path), content);
  }
  return from;
};

const stage = (
  from: string,
  extra: { version?: string; config?: ShellConfig } = {},
) =>
  stageRelease({
    from,
    stage: mkdtempSync(join(scratch, "stage-")),
    config: extra.config ?? fixtureConfig,
    now: new Date("2026-09-14T09:00:00Z"),
    ...(extra.version ? { version: extra.version } : {}),
  });

describe("where the installed app looks", () => {
  test("the updater's one endpoint is the fleet's front door, which answers without an account", () => {
    const shell = read("desktop/src-tauri/src/lib.rs");
    const domain = shell.match(/const FLEET_DOMAIN: &str = "([^"]+)"/)?.[1];
    expect(domain).toBeTruthy();
    expect(shellConfig.plugins?.updater?.endpoints).toEqual([
      `https://${domain}/desktop/latest.json`,
    ]);
    expect(read("desktop/src-tauri/tauri.conf.json")).not.toContain(
      "github.com",
    );

    const door = doorOf(shellConfig);
    expect(door).toEqual({
      base: `https://${domain}/desktop/`,
      host: domain as string,
      pubkey: shellConfig.plugins?.updater?.pubkey as string,
    });
    // The embedded key parses: a malformed pubkey would make every tag's door job refuse.
    expect(readPublicKey(door.pubkey).id).toBe("3E9A4235FEC7D535");
  });

  test("the upload account is the one laf-control forces into the receiver", () => {
    expect(DOOR_USER).toBe("laf-desktop");
  });
});

describe("staging a release for the door", () => {
  test("a tag build: both installers, the mac bundle, both signatures and a feed pointing at them", () => {
    const staged = stage(artifacts({}), { version: FIXTURE.version });
    expect(staged.version).toBe(FIXTURE.version);
    expect(staged.feed).toBe(true);
    expect(staged.files).toEqual(Object.values(DOOR_FILES).sort());
    expect(
      readFileSync(join(staged.dir, DOOR_FILES.windowsInstaller), "utf8"),
    ).toBe(FIXTURE.windows.installer);

    const feed = JSON.parse(
      readFileSync(join(staged.dir, DOOR_FILES.feed), "utf8"),
    );
    expect(feed.version).toBe(FIXTURE.version);
    expect(feed.pub_date).toBe("2026-09-14T09:00:00.000Z");
    const macUrl = `https://door.test/desktop/${FIXTURE.version}/LAF-Agent-mac.app.tar.gz`;
    const windowsUrl = `https://door.test/desktop/${FIXTURE.version}/LAF-Agent-windows.exe`;
    // Both spellings the updater asks for (`{os}-{arch}-{installer}`, then `{os}-{arch}`), and the
    // signature is the .sig's content, byte for byte — that is what the app decodes.
    expect(feed.platforms).toEqual({
      "darwin-aarch64": { signature: FIXTURE.mac.signature, url: macUrl },
      "darwin-x86_64": { signature: FIXTURE.mac.signature, url: macUrl },
      "darwin-aarch64-app": { signature: FIXTURE.mac.signature, url: macUrl },
      "darwin-x86_64-app": { signature: FIXTURE.mac.signature, url: macUrl },
      "windows-x86_64": {
        signature: FIXTURE.windows.signature,
        url: windowsUrl,
      },
      "windows-x86_64-nsis": {
        signature: FIXTURE.windows.signature,
        url: windowsUrl,
      },
    });
    expect(
      latestJson({
        version: FIXTURE.version,
        base: "https://door.test/desktop/",
        macSignature: FIXTURE.mac.signature,
        windowsSignature: FIXTURE.windows.signature,
        pubDate: "2026-09-14T09:00:00.000Z",
      }),
    ).toBe(readFileSync(join(staged.dir, DOOR_FILES.feed), "utf8"));
  });

  test("a build-only run: installers and no feed, because nothing signed one", () => {
    const staged = stage(artifacts({ updater: false }));
    expect(staged.feed).toBe(false);
    expect(readdirSync(staged.dir).sort()).toEqual([
      DOOR_FILES.macInstaller,
      DOOR_FILES.windowsInstaller,
    ]);
  });

  test("a signature from the key the app embeds, over other bytes, is refused", () => {
    const from = artifacts({
      overrides: {
        "door-macos/macos/LAF Agent.app.tar.gz": "a different bundle\n",
      },
    });
    expect(() => stage(from)).toThrow(
      "LAF Agent.app.tar.gz.sig does not match these bytes",
    );
  });

  test("a signature from any other key is refused by name — the half-rotated secret", () => {
    // The fixture's signatures against the key this repository's app really embeds.
    expect(() =>
      stage(artifacts({}), {
        config: { plugins: { updater: { ...shellConfig.plugins?.updater } } },
      }),
    ).toThrow(
      "is signed by key 4488DA32A552B3CC, and tauri.conf.json trusts 3E9A4235FEC7D535",
    );
  });

  test("a trusted comment the key did not sign is refused", () => {
    const lines = Buffer.from(FIXTURE.mac.signature, "base64")
      .toString("utf8")
      .split("\n");
    lines[2] = "trusted comment: timestamp:1789358836\tfile:something-else";
    const forged = Buffer.from(lines.join("\n")).toString("base64");
    const key = readPublicKey(FIXTURE.pubkey);
    expect(() =>
      verifySignature(key, Buffer.from(FIXTURE.mac.bundle), forged, "bundle"),
    ).toThrow("has a trusted comment its key did not sign");
    expect(() =>
      verifySignature(
        key,
        Buffer.from(FIXTURE.mac.bundle),
        FIXTURE.mac.signature,
        "bundle",
      ),
    ).not.toThrow();
  });

  test("half an updater is refused: one platform signed leaves the other on its old version", () => {
    expect(() => stage(artifacts({ omit: ["_x64-setup.exe.sig"] }))).toThrow(
      "needs the mac bundle and both signatures",
    );
    expect(() => stage(artifacts({ omit: [".app.tar.gz"] }))).toThrow(
      "needs the mac bundle and both signatures",
    );
  });

  test("the version is the tag's, and both installers must carry it", () => {
    expect(() => stage(artifacts({}), { version: "9.9.2" })).toThrow(
      "the tag says 9.9.2 and the installers say 9.9.1",
    );
    expect(() =>
      stage(artifacts({ windowsVersion: "9.9.0", updater: false })),
    ).toThrow("the installers disagree about their version");
    expect(() =>
      stage(artifacts({ updater: false, omit: ["_universal.dmg"] })),
    ).toThrow("expected exactly one macOS installer");
  });
});

/**
 * The workflow half of the same decision. The build jobs hold the updater's signing key while they
 * run other people's build code, so they hold nothing that writes; only the door job holds the
 * door's key, and only after both platforms built.
 */
describe("the release workflow", () => {
  type Step = {
    name?: string;
    uses?: string;
    if?: string;
    run?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
  };
  type Job = {
    needs?: string | string[];
    if?: string;
    permissions?: Record<string, string>;
    steps: Step[];
  };
  const workflow = parse(read(".github/workflows/release.yml")) as {
    permissions: Record<string, string>;
    jobs: Record<string, Job>;
  };

  test("writes no GitHub release and asks for no write permission", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(workflow.jobs)) {
      for (const scope of Object.values(job.permissions ?? {}))
        expect(scope).not.toBe("write");
    }
    const build = workflow.jobs.build?.steps.find((step) =>
      step.uses?.startsWith("tauri-apps/tauri-action@"),
    );
    expect(build?.with).not.toHaveProperty("tagName");
    expect(build?.with).not.toHaveProperty("releaseDraft");
  });

  test("the door job runs on a tag, after both builds, with the key laf-control sets", () => {
    const door = workflow.jobs.door as Job;
    expect(door.needs).toBe("build");
    expect(door.if).toBe("github.ref_type == 'tag'");
    const carry = door.steps.find((step) =>
      step.run?.includes("desktop/scripts/front-door.ts"),
    );
    expect(carry?.env).toMatchObject({
      DOOR_KEY: "${{ secrets.DESKTOP_DOOR_SSH_KEY }}",
      DOOR_KNOWN_HOSTS: "${{ secrets.DESKTOP_DOOR_KNOWN_HOSTS }}",
      DOOR_FINGERPRINT: "${{ vars.DESKTOP_DOOR_KEY_FINGERPRINT }}",
    });
    // No other job can read the door's key.
    const others = Object.entries(workflow.jobs).filter(
      ([name]) => name !== "door",
    );
    expect(JSON.stringify(others)).not.toContain("DESKTOP_DOOR_SSH_KEY");
  });
});
