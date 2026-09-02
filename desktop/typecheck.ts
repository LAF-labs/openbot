/**
 * The shell's share of `bun run typecheck`, which is `cargo check` wherever that can run.
 *
 * It used to be `echo 'desktop: Rust only; checked by cargo'` — a workspace that reported success
 * without looking at anything, so the one part of this repository the product is installed from was
 * the one part the gate never read.
 *
 * WHY IT CAN STILL SKIP. The repository's CI runs on Linux, where this crate does not build: Tauri
 * links against `webkit2gtk` and `libsoup` development packages that a Linux runner has no reason
 * to install, for a binary that only ever ships as a .app and an .exe. A contributor may equally
 * have no Rust toolchain at all. Neither is a reason to fail somebody's gate, and neither is a
 * reason to lie about what was checked — so this says out loud which of the two happened, and the
 * real check for those platforms is `cargo test` in `.github/workflows/release.yml`, which runs on
 * the macOS and Windows runners the shell is actually built on.
 */
import { spawnSync } from "node:child_process";

const skip = (reason: string) => {
  console.log(`desktop: cargo check skipped — ${reason}`);
  process.exit(0);
};

if (process.platform === "linux") {
  skip(
    "this crate needs webkit2gtk and libsoup development packages on Linux, and never ships there. Checked on macOS and Windows by the release workflow's `cargo test`.",
  );
}

const cargo = spawnSync("cargo", ["--version"], { stdio: "ignore" });
if (cargo.error || cargo.status !== 0) {
  skip(
    "no Rust toolchain on this machine (install one from https://rustup.rs)",
  );
}

const checked = spawnSync("cargo", ["check", "--all-targets"], {
  cwd: new URL("src-tauri/", import.meta.url).pathname,
  stdio: "inherit",
});
process.exit(checked.status ?? 1);
