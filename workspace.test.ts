import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertWorkspacePath,
  resolveWorkspacePath,
  workspaceSandboxEnv,
} from "./workspace.js";

void test("resolveWorkspacePath keeps relative project paths inside the workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "ralpix-workspace-"));
  const canonicalRoot = realpathSync(root);

  const resolved = resolveWorkspacePath(root, "docs/plans/demo.md", { kind: "create", label: "plan" });

  assert.equal(resolved, join(canonicalRoot, "docs/plans/demo.md"));
});

void test("assertWorkspacePath rejects paths outside the workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "ralpix-workspace-"));
  const outside = join(tmpdir(), "outside.md");
  writeFileSync(outside, "x", "utf-8");

  assert.throws(
    () => {
      assertWorkspacePath(root, outside, "plan");
    },
    /outside the workspace/i,
  );
});

void test("resolveWorkspacePath rejects symlink escapes when reading existing files", () => {
  const root = mkdtempSync(join(tmpdir(), "ralpix-workspace-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "ralpix-outside-"));
  const outsideFile = join(outsideDir, "secret.md");
  const linkedDir = join(root, "linked");

  writeFileSync(outsideFile, "secret", "utf-8");
  symlinkSync(outsideDir, linkedDir);

  assert.throws(
    () => {
      resolveWorkspacePath(root, "linked/secret.md", { kind: "read", label: "plan" });
    },
    /outside the workspace/i,
  );
});

void test("workspaceSandboxEnv redirects temporary files into the project", () => {
  const root = mkdtempSync(join(tmpdir(), "ralpix-workspace-"));
  const canonicalRoot = realpathSync(root);
  mkdirSync(join(root, ".ralpix"), { recursive: true });

  const env = workspaceSandboxEnv(root) as Record<string, string | undefined>;
  const tempDir = env["TMPDIR"];
  const tmp = env["TMP"];
  const temp = env["TEMP"];

  assert.equal(tempDir, join(canonicalRoot, ".ralpix", "tmp"));
  assert.equal(tmp, join(canonicalRoot, ".ralpix", "tmp"));
  assert.equal(temp, join(canonicalRoot, ".ralpix", "tmp"));
});
