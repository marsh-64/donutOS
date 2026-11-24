import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const minimumFreeGiB = 55;
// On the author's Windows machine, build artifacts go to a data drive so C:
// does not fill up. An explicit CARGO_TARGET_DIR always wins. Other platforms
// keep cargo's default target dir: `D:` contains `:`, which is the
// DYLD_FALLBACK_LIBRARY_PATH separator, and rustc refuses to start.
const defaultTargetDir = "D:/ZDownloads/donut-free-target";
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cargoCwd = join(repoRoot, "src-tauri");
const safeWithoutSpace = new Set([
  "clean",
  "fmt",
  "help",
  "locate-project",
  "metadata",
  "pkgid",
  "read-manifest",
  "version",
]);

export function runCargoGuard({
  args = process.argv.slice(2),
  spawn = spawnSync,
  platform = process.platform,
  env = process.env,
} = {}) {
  const cargoArgs = [...args];
  if (cargoArgs[0] === "--") cargoArgs.shift();

  if (cargoArgs.length === 0) {
    console.error("Usage: node scripts/cargo-guard.mjs -- <cargo arguments>");
    return 64;
  }

  // The disk gate guards THIS shared Windows host, where C: runs close to
  // full. CI runners neither need it nor satisfy it (windows-latest ships
  // with far less than the threshold), so keep the gate host-only.
  if (!env.CI && !safeWithoutSpace.has(cargoArgs[0]) && platform === "win32") {
    const probe = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::Write((Get-PSDrive -Name C -ErrorAction Stop).Free.ToString([System.Globalization.CultureInfo]::InvariantCulture))",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const match = /^\s*(\d+)\s*$/.exec(probe.stdout ?? "");
    if (probe.error || probe.status !== 0 || !match) {
      console.error(
        "CARGO_GUARD_ERROR: could not read free space on C:; refusing to start Cargo.",
      );
      return 72;
    }

    const freeBytes = Number(match[1]);
    if (!Number.isSafeInteger(freeBytes)) {
      console.error(
        "CARGO_GUARD_ERROR: invalid free-space reading; refusing to start Cargo.",
      );
      return 72;
    }

    const requiredBytes = minimumFreeGiB * 1024 ** 3;
    console.log(
      `CARGO_GUARD: C: free ${(freeBytes / 1024 ** 3).toFixed(2)} GiB; minimum ${minimumFreeGiB} GiB.`,
    );
    if (freeBytes < requiredBytes) {
      console.error(
        "CARGO_GUARD_BLOCKED: not enough free space; no Cargo process was started.",
      );
      return 71;
    }
  }

  const childEnv = {
    ...env,
    CARGO_BUILD_JOBS: "2",
    CARGO_INCREMENTAL: "0",
  };
  // The data-drive default is a Windows path. CI and every other OS keep
  // cargo's own target dir (or an explicit CARGO_TARGET_DIR already in env,
  // which the spread above preserves). Joining `D:/...` onto the manifest
  // dir breaks rustc on macOS: `:` is the DYLD_FALLBACK_LIBRARY_PATH separator.
  if (!env.CI && platform === "win32" && !env.CARGO_TARGET_DIR) {
    childEnv.CARGO_TARGET_DIR = defaultTargetDir;
  }
  const result = spawn("cargo", cargoArgs, {
    cwd: cargoCwd,
    env: childEnv,
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.error) {
    console.error(
      `CARGO_GUARD_ERROR: could not start Cargo: ${result.error.message}`,
    );
    return 127;
  }
  return result.status ?? 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  process.exitCode = runCargoGuard();
}
