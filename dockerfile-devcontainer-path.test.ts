import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

void test("Docker image installs a shell hook that prepends devcontainer wrappers to PATH", () => {
  const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf-8");

  assert.match(
    dockerfile,
    /devcontainer-path\.sh/,
  );
});

void test("devcontainer PATH hook prepends wrappers only when the directory exists", () => {
  const hook = readFileSync(new URL("./docker/pi-agent/devcontainer-path.sh", import.meta.url), "utf-8");

  assert.match(hook, /DEVCONTAINER_BIN="\/workspace\/\.devcontainer\/bin"/);
  assert.match(hook, /\[ -d "\${DEVCONTAINER_BIN}" ]/);
  assert.match(hook, /case ":\$PATH:" in/);
  assert.match(hook, /export PATH="\${DEVCONTAINER_BIN}:\$PATH"/);
});
