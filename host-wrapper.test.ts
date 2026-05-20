import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const BASH_SHEBANG = "#!/usr/bin/env bash";
const STRICT_BASH = "set -euo pipefail";
const SSH_SHIM = [
  BASH_SHEBANG,
  STRICT_BASH,
  "while [ \"$#\" -gt 0 ]; do",
  "  case \"$1\" in",
  "    -o) shift 2 ;;",
  "    --) shift; break ;;",
  "    sh) break ;;",
  "    *) shift ;;",
  "  esac",
  "done",
  "if [ \"${1:-}\" = \"sh\" ] && [ \"${2:-}\" = \"-s\" ] && [ \"${3:-}\" = \"--\" ]; then",
  "  shift 3",
  "fi",
  "exec bash -s -- \"$@\"",
].join("\n");

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf-8");
  chmodSync(path, 0o755);
}

function writeWrapper(path: string, hostWrapperSource: string): void {
  writeExecutable(path, [
    BASH_SHEBANG,
    STRICT_BASH,
    "TOOL_NAME=\"bun\"",
    "DEFAULT_HOST_BIN=\"bun\"",
    `source "${hostWrapperSource}"`,
  ].join("\n"));
}

function escapeForRegex(value: string): string {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}

void test("host wrapper requires a configured host workdir in host mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "ralpix-host-wrapper-"));

  try {
    const wrapperPath = join(dir, "run-wrapper.sh");
    const hostWrapperSource = resolve("docker/pi-agent/host-wrapper.sh");

    writeWrapper(wrapperPath, hostWrapperSource);

    const result = spawnSync(wrapperPath, ["test"], {
      encoding: "utf-8",
      env: process.env,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /host workdir is required for host mode/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("host wrapper executes remote tool within the configured allowed root", () => {
  const dir = mkdtempSync(join(tmpdir(), "ralpix-host-wrapper-"));

  try {
    const fakeBinDir = join(dir, "bin");
    const fakeSshPath = join(fakeBinDir, "ssh");
    const fakeHostBinDir = join(dir, "host-bin");
    const fakeBunPath = join(fakeHostBinDir, "bun");
    const hostRoot = join(dir, "host-root");
    const hostWorkdir = join(hostRoot, "project");
    const wrapperPath = join(dir, "run-wrapper.sh");
    const hostWrapperSource = resolve("docker/pi-agent/host-wrapper.sh");

    mkdirSync(fakeBinDir, { recursive: true });
    mkdirSync(fakeHostBinDir, { recursive: true });
    mkdirSync(hostWorkdir, { recursive: true });

    writeExecutable(fakeSshPath, SSH_SHIM);

    writeExecutable(fakeBunPath, [
      BASH_SHEBANG,
      STRICT_BASH,
      String.raw`printf 'PWD=%s\n' "$PWD"`,
      String.raw`printf 'ARGS=%s\n' "$*"`,
    ].join("\n"));

    writeWrapper(wrapperPath, hostWrapperSource);

    const result = spawnSync(wrapperPath, ["test", "--watch"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
        RALPIX_HOST_WORKDIR: hostWorkdir,
        RALPIX_HOST_ALLOWED_ROOT: hostRoot,
        RALPIX_HOST_PATH: fakeHostBinDir,
      },
    });

    const hostWorkdirReal = realpathSync(hostWorkdir);

    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`PWD=${escapeForRegex(hostWorkdirReal)}`));
    assert.match(result.stdout, /ARGS=test --watch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("host wrapper rejects host workdirs outside the configured allowed root", () => {
  const dir = mkdtempSync(join(tmpdir(), "ralpix-host-wrapper-"));

  try {
    const fakeBinDir = join(dir, "bin");
    const fakeSshPath = join(fakeBinDir, "ssh");
    const wrapperPath = join(dir, "run-wrapper.sh");
    const hostWrapperSource = resolve("docker/pi-agent/host-wrapper.sh");
    const hostRoot = join(dir, "host-root");
    const outsideDir = join(dir, "elsewhere");

    mkdirSync(fakeBinDir, { recursive: true });
    mkdirSync(hostRoot, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    writeExecutable(fakeSshPath, SSH_SHIM);
    writeWrapper(wrapperPath, hostWrapperSource);

    const result = spawnSync(wrapperPath, ["test"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env["PATH"] ?? ""}`,
        RALPIX_HOST_WORKDIR: outsideDir,
        RALPIX_HOST_ALLOWED_ROOT: hostRoot,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside allowed root/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
