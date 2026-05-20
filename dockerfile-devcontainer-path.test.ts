import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

void test("Docker image installs a shell hook that prepends devcontainer wrappers to PATH", () => {
  const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf-8");

  assert.match(
    dockerfile,
    /devcontainer-path\.sh/,
  );
  assert.match(
    dockerfile,
    /ENV RALPIX_DEVCONTAINER_BIN_DIR=\/opt\/ralpix\/devcontainer-bin/,
  );
  assert.match(
    dockerfile,
    /ENV RALPIX_HOST_BUN_BIN=bun/,
  );
  assert.match(
    dockerfile,
    /ENV RALPIX_HOST_DOCKER_BIN=docker/,
  );
  assert.match(
    dockerfile,
    /ENV RALPIX_HOST_BUN_MODE=host/,
  );
  assert.match(
    dockerfile,
    /ENV RALPIX_HOST_DOCKER_MODE=host/,
  );
  assert.match(
    dockerfile,
    /ENV RALPIX_WRAPPER_ENABLE_LOCAL_OVERRIDE=1/,
  );
  assert.match(
    dockerfile,
    /ENV RALPIX_WRAPPER_LOCAL_OVERRIDE_DIR=\/workspace\/\.devcontainer\/bin/,
  );
  assert.match(
    dockerfile,
    /ENV RALPIX_WRAPPER_DEBUG=0/,
  );
  assert.match(
    dockerfile,
    /ENV REVDIFF_VERSION=v1\.3\.0/,
  );
  assert.match(
    dockerfile,
    /ENV REVDIFF_AUTO_UPDATE=1/,
  );
  assert.match(
    dockerfile,
    /ENV REVDIFF_GITHUB_REPO=umputun\/revdiff/,
  );
  assert.match(
    dockerfile,
    /ENV REVDIFF_INSTALL_DIR=\/home\/pi\/\.local\/bin/,
  );
  assert.match(
    dockerfile,
    /ENV REVDIFF_VERSION_FILE=\/home\/pi\/\.local\/bin\/\.revdiff-version/,
  );
  assert.match(
    dockerfile,
    /ENV REVDIFF_TARGETARCH=\$TARGETARCH/,
  );
  assert.match(
    dockerfile,
    /ENV PATH="\${REVDIFF_INSTALL_DIR}:\${RALPIX_DEVCONTAINER_BIN_DIR}:\$PATH"/,
  );
});

void test("devcontainer PATH hook prepends wrappers only when the directory exists", () => {
  const hook = readFileSync(new URL("./docker/pi-agent/devcontainer-path.sh", import.meta.url), "utf-8");

  assert.match(hook, /DEVCONTAINER_BIN="\/workspace\/\.devcontainer\/bin"/);
  assert.match(hook, /\[ -d "\${DEVCONTAINER_BIN}" ]/);
  assert.match(hook, /case ":\$PATH:" in/);
  assert.match(hook, /export PATH="\${DEVCONTAINER_BIN}:\$PATH"/);
});

void test("Docker image installs built-in bun and docker wrappers", () => {
  const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf-8");

  assert.match(dockerfile, /host-wrapper\.sh/);
  assert.match(dockerfile, /devcontainer-bin\/bun/);
  assert.match(dockerfile, /devcontainer-bin\/docker/);
});

void test("built-in bun wrapper defers to local override or host bun with defaults", () => {
  const wrapper = readFileSync(new URL("./docker/pi-agent/devcontainer-bin/bun", import.meta.url), "utf-8");

  assert.match(wrapper, /TOOL_NAME="bun"/);
  assert.match(wrapper, /DEFAULT_HOST_BIN="bun"/);
  assert.match(wrapper, /source "\/opt\/ralpix\/docker\/pi-agent\/host-wrapper\.sh"/);
});

void test("built-in docker wrapper defers to local override or host docker with defaults", () => {
  const wrapper = readFileSync(new URL("./docker/pi-agent/devcontainer-bin/docker", import.meta.url), "utf-8");

  assert.match(wrapper, /TOOL_NAME="docker"/);
  assert.match(wrapper, /DEFAULT_HOST_BIN="docker"/);
  assert.match(wrapper, /source "\/opt\/ralpix\/docker\/pi-agent\/host-wrapper\.sh"/);
});

void test("shared host wrapper supports local overrides and env-driven host forwarding", () => {
  const wrapper = readFileSync(new URL("./docker/pi-agent/host-wrapper.sh", import.meta.url), "utf-8");

  assert.match(wrapper, /RALPIX_WRAPPER_ENABLE_LOCAL_OVERRIDE/);
  assert.match(wrapper, /RALPIX_WRAPPER_LOCAL_OVERRIDE_DIR/);
  assert.match(wrapper, /RALPIX_WRAPPER_DEBUG/);
  assert.match(wrapper, /override_path="\${override_dir}\/\${tool_name}"/);
  assert.match(wrapper, /exec "\${override_path}" "\$@"/);
  assert.match(wrapper, /mode_var="RALPIX_HOST_\${tool_upper}_MODE"/);
  assert.match(wrapper, /bin_var="RALPIX_HOST_\${tool_upper}_BIN"/);
  assert.match(wrapper, /exec pi --host "\${host_bin}" "\$@"/);
  assert.match(wrapper, /Unsupported %s wrapper mode: %s/);
});

void test("Docker image installs revdiff helpers and bootstraps the pinned binary at build time", () => {
  const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf-8");

  assert.match(dockerfile, /curl/);
  assert.match(dockerfile, /ARG TARGETARCH/);
  assert.doesNotMatch(dockerfile, /cp docker\/pi-agent\/host-wrapper\.sh \/opt\/ralpix\/docker\/pi-agent\/host-wrapper\.sh/);
  assert.doesNotMatch(dockerfile, /cp docker\/pi-agent\/revdiff-common\.sh \/opt\/ralpix\/docker\/pi-agent\/revdiff-common\.sh/);
  assert.doesNotMatch(dockerfile, /cp docker\/pi-agent\/install-revdiff\.sh \/opt\/ralpix\/docker\/pi-agent\/install-revdiff\.sh/);
  assert.doesNotMatch(dockerfile, /cp docker\/pi-agent\/update-revdiff\.sh \/opt\/ralpix\/docker\/pi-agent\/update-revdiff\.sh/);
  assert.match(dockerfile, /\/opt\/ralpix\/docker\/pi-agent\/install-revdiff\.sh/);
});

void test("revdiff helper selects release assets for the image architecture", () => {
  const helper = readFileSync(new URL("./docker/pi-agent/revdiff-common.sh", import.meta.url), "utf-8");

  assert.match(helper, /REVDIFF_TARGETARCH/);
  assert.match(helper, /case "\${REVDIFF_TARGETARCH:-}" in/);
  assert.match(helper, /\bx86_64\|amd64\b/);
  assert.match(helper, /\baarch64\|arm64\b/);
  assert.match(helper, /assets\.find/);
  assert.match(helper, /name\.includes\(process\.argv\[1]\)/);
  assert.match(helper, /name\.endsWith\("\.tar\.gz"\)/);
});

void test("revdiff install script fetches the pinned release tag", () => {
  const script = readFileSync(new URL("./docker/pi-agent/install-revdiff.sh", import.meta.url), "utf-8");

  assert.match(script, /REVDIFF_VERSION="\${REVDIFF_VERSION:\?REVDIFF_VERSION is required}"/);
  assert.match(script, /REVDIFF_API_URL}\/tags\/\${REVDIFF_VERSION}/);
  assert.match(script, /revdiff_install_from_release_json/);
});

void test("revdiff updater checks latest release and updates only when needed", () => {
  const script = readFileSync(new URL("./docker/pi-agent/update-revdiff.sh", import.meta.url), "utf-8");

  assert.match(script, /REVDIFF_VERSION_FILE/);
  assert.match(script, /REVDIFF_API_URL}\/latest/);
  assert.match(script, /latest_version=/);
  assert.match(script, /\[ "\${current_version}" = "\${latest_version}" ]/);
  assert.match(script, /revdiff: updating from/);
});

void test("start-pi ignores revdiff update failures after printing them", () => {
  const script = readFileSync(new URL("./docker/pi-agent/start-pi.sh", import.meta.url), "utf-8");

  assert.match(script, /REVDIFF_AUTO_UPDATE="\${REVDIFF_AUTO_UPDATE:-1}"/);
  assert.match(script, /if ! \/opt\/ralpix\/docker\/pi-agent\/update-revdiff\.sh; then/);
  assert.match(script, /revdiff: update failed, continuing startup/);
});
