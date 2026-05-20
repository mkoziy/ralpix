import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

void test("Docker image no longer bakes in devcontainer wrapper env or PATH hooks", () => {
  const dockerfile = readFileSync(resolve(process.cwd(), "Dockerfile"), "utf-8");

  assert.doesNotMatch(dockerfile, /RALPIX_DEVCONTAINER_BIN_DIR/);
  assert.doesNotMatch(dockerfile, /RALPIX_HOST_/);
  assert.doesNotMatch(dockerfile, /RALPIX_WRAPPER_/);
  assert.doesNotMatch(dockerfile, /devcontainer-path\.sh/);
  assert.doesNotMatch(dockerfile, /devcontainer-bin\/bun/);
  assert.doesNotMatch(dockerfile, /devcontainer-bin\/docker/);
  assert.match(dockerfile, /ENV PATH="\${REVDIFF_INSTALL_DIR}:\$PATH"/);
});

void test("README no longer documents devcontainer wrapper bootstrap flow", () => {
  const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf-8");

  assert.doesNotMatch(readme, /^## Dev Container$/m);
  assert.doesNotMatch(readme, /RALPIX_HOST_/);
  assert.doesNotMatch(readme, /\.devcontainer\/bin/);
  assert.doesNotMatch(readme, /host\.docker\.internal/);
});

void test("devcontainer wrapper assets are removed from the repository", () => {
  assert.equal(existsSync(resolve(process.cwd(), "docker/pi-agent/host-wrapper.sh")), false);
  assert.equal(existsSync(resolve(process.cwd(), "docker/pi-agent/devcontainer-path.sh")), false);
  assert.equal(existsSync(resolve(process.cwd(), "docker/pi-agent/devcontainer-bin/bun")), false);
  assert.equal(existsSync(resolve(process.cwd(), "docker/pi-agent/devcontainer-bin/docker")), false);
  assert.equal(existsSync(resolve(process.cwd(), "LLM.txt")), false);
});
