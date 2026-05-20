import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const WORKSPACE_TMP_PARTS = [".ralpix", "tmp"] as const;
const SANDBOX_PROFILE_NAME = "pi-workspace.sb";

interface ResolveWorkspacePathOptions {
  kind: "create" | "read";
  label: string;
}

interface PiInvocation {
  command: string;
  args: string[];
}

interface SandboxedInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function canonicalPath(path: string): string {
  return realpathSync.native(path);
}

function resolveFromRoot(root: string, input: string): string {
  return isAbsolute(input) ? resolve(input) : resolve(root, input);
}

function isWithinWorkspace(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function canonicalExistingAncestor(path: string): string {
  let current = resolve(path);
  for (;;) {
    if (existsSync(current)) {
      return canonicalPath(current);
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`ralpix: unable to resolve an existing parent for ${path}`);
    }
    current = parent;
  }
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function quoteSb(value: string): string {
  const escaped = value
    .replaceAll(String.fromCodePoint(92), String.raw`\\`)
    .replaceAll('"', String.raw`\"`);
  return `"${escaped}"`;
}

function existingPath(path: string): string | null {
  if (!existsSync(path)) return null;
  return canonicalPath(path);
}

function existingSubpath(base: string, child?: string): string | null {
  const target = child == null ? base : join(base, child);
  return existingPath(target);
}

function workspaceRootFor(rootOrCwd: string): string {
  const resolved = resolve(rootOrCwd);
  if (!existsSync(resolved)) {
    throw new Error(`ralpix: workspace does not exist: ${resolved}`);
  }
  return canonicalPath(resolved);
}

export function assertWorkspacePath(
  rootOrCwd: string,
  candidatePath: string,
  label: string,
): string {
  const root = workspaceRootFor(rootOrCwd);
  const absolute = resolveFromRoot(root, candidatePath);
  const canonical = existsSync(absolute) ? canonicalPath(absolute) : absolute;

  if (!isWithinWorkspace(root, canonical)) {
    throw new Error(`ralpix: ${label} path is outside the workspace: ${absolute}`);
  }

  return canonical;
}

export function resolveWorkspacePath(
  rootOrCwd: string,
  inputPath: string,
  options: ResolveWorkspacePathOptions,
): string {
  const root = workspaceRootFor(rootOrCwd);
  const absolute = resolveFromRoot(root, inputPath);

  if (options.kind === "read") {
    if (!existsSync(absolute)) {
      throw new Error(`ralpix: ${options.label} path does not exist: ${absolute}`);
    }
    return assertWorkspacePath(root, canonicalPath(absolute), options.label);
  }

  const canonicalParent = canonicalExistingAncestor(dirname(absolute));
  if (!isWithinWorkspace(root, canonicalParent)) {
    throw new Error(`ralpix: ${options.label} path is outside the workspace: ${absolute}`);
  }
  return assertWorkspacePath(root, absolute, options.label);
}

export function workspaceTempDir(rootOrCwd: string): string {
  const root = workspaceRootFor(rootOrCwd);
  const tempDir = resolveWorkspacePath(root, join(...WORKSPACE_TMP_PARTS), {
    kind: "create",
    label: "workspace temp",
  });
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
  return tempDir;
}

export function workspaceSandboxEnv(rootOrCwd: string): NodeJS.ProcessEnv {
  const tempDir = workspaceTempDir(rootOrCwd);
  return {
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
  };
}

function sandboxProfilePath(rootOrCwd: string): string {
  return resolveWorkspacePath(rootOrCwd, join(...WORKSPACE_TMP_PARTS, SANDBOX_PROFILE_NAME), {
    kind: "create",
    label: "sandbox profile",
  });
}

function sandboxRuntimeReadRoots(root: string): string[] {
  const home = homedir();
  const execVersionRoot = existingPath(dirname(dirname(process.execPath)));
  const piAgentDir = existingSubpath(home, ".pi");
  const ralpixHomeDir = existingSubpath(home, ".ralpix");
  const nvmDir = existingSubpath(home, ".nvm");

  return dedupePaths([
    root,
    existingPath("/bin"),
    existingPath("/sbin"),
    existingPath("/usr"),
    existingPath("/System"),
    existingPath("/dev"),
    existingPath("/etc"),
    existingPath("/private/etc"),
    existingPath("/private/var/db"),
    existingPath("/private/var/run"),
    existingPath("/opt/homebrew"),
    execVersionRoot,
    nvmDir,
    piAgentDir,
    ralpixHomeDir,
  ].filter((path): path is string => path != null));
}

function sandboxRuntimeWriteRoots(root: string): string[] {
  const home = homedir();
  return dedupePaths([
    root,
    existingSubpath(home, ".pi"),
  ].filter((path): path is string => path != null));
}

function buildSandboxProfile(root: string): string {
  const readRoots = sandboxRuntimeReadRoots(root);
  const writeRoots = sandboxRuntimeWriteRoots(root);
  const readClauses = readRoots.map((path) => `    (subpath ${quoteSb(path)})`).join("\n");
  const writeClauses = writeRoots.map((path) => `    (subpath ${quoteSb(path)})`).join("\n");

  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow network*)",
    "(allow file-read-metadata)",
    "(allow file-read*",
    readClauses,
    ")",
    "(allow file-map-executable",
    readClauses,
    ")",
    "(allow file-write*",
    writeClauses,
    ")",
    "",
  ].join("\n");
}

function ensureSandboxProfile(rootOrCwd: string): string {
  const root = workspaceRootFor(rootOrCwd);
  const profilePath = sandboxProfilePath(root);
  const profile = buildSandboxProfile(root);
  writeFileSync(profilePath, profile, "utf-8");
  return profilePath;
}

export function sandboxPiInvocation(
  rootOrCwd: string,
  invocation: PiInvocation,
  baseEnv: NodeJS.ProcessEnv = process.env,
): SandboxedInvocation {
  const root = workspaceRootFor(rootOrCwd);
  const env = {
    ...baseEnv,
    ...workspaceSandboxEnv(root),
  };

  if (process.platform !== "darwin") {
    throw new Error("ralpix: workspace sandboxing currently requires macOS sandbox-exec");
  }

  const sandboxExec = "/usr/bin/sandbox-exec";
  if (!existsSync(sandboxExec)) {
    throw new Error("ralpix: sandbox-exec is required for workspace sandboxing");
  }

  const profilePath = ensureSandboxProfile(root);
  return {
    command: sandboxExec,
    args: ["-f", profilePath, invocation.command, ...invocation.args],
    env,
  };
}
