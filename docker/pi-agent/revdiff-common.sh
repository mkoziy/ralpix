#!/usr/bin/env bash

set -euo pipefail

REVDIFF_GITHUB_REPO="${REVDIFF_GITHUB_REPO:-umputun/revdiff}"
REVDIFF_INSTALL_DIR="${REVDIFF_INSTALL_DIR:-$HOME/.local/bin}"
REVDIFF_VERSION_FILE="${REVDIFF_VERSION_FILE:-${REVDIFF_INSTALL_DIR}/.revdiff-version}"
REVDIFF_API_URL="https://api.github.com/repos/${REVDIFF_GITHUB_REPO}/releases"

revdiff_target_arch() {
  case "${REVDIFF_TARGETARCH:-}" in
    amd64|arm64)
      printf '%s' "${REVDIFF_TARGETARCH}"
      ;;
    x86_64)
      printf 'amd64'
      ;;
    aarch64)
      printf 'arm64'
      ;;
    "")
      case "$(uname -m)" in
        x86_64|amd64) printf 'amd64' ;;
        aarch64|arm64) printf 'arm64' ;;
        *)
          printf 'unsupported architecture: %s\n' "$(uname -m)" >&2
          return 1
          ;;
      esac
      ;;
    *)
      printf 'unsupported REVDIFF_TARGETARCH: %s\n' "${REVDIFF_TARGETARCH}" >&2
      return 1
      ;;
  esac
}

revdiff_release_json() {
  local endpoint="$1"
  curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: ralpix" "${endpoint}"
}

revdiff_select_asset_url() {
  local arch="$1"
  node -e '
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      const release = JSON.parse(data);
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const asset = assets.find((entry) => {
        const name = String(entry.name ?? "").toLowerCase();
        return name.includes("linux") && name.includes(process.argv[1]) && name.endsWith(".tar.gz");
      });
      if (!asset?.browser_download_url) {
        process.exit(1);
      }
      process.stdout.write(String(asset.browser_download_url));
    });
  ' "${arch}"
}

revdiff_select_tag_name() {
  node -e '
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      const release = JSON.parse(data);
      if (!release.tag_name) {
        process.exit(1);
      }
      process.stdout.write(String(release.tag_name));
    });
  '
}

revdiff_install_from_release_json() {
  local release_json="$1"
  local version="$2"
  local arch tmp_dir asset_url extracted_bin

  arch="$(revdiff_target_arch)"
  asset_url="$(printf '%s' "${release_json}" | revdiff_select_asset_url "${arch}")"
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${tmp_dir}"' RETURN

  mkdir -p "${REVDIFF_INSTALL_DIR}"
  curl -fsSL "${asset_url}" -o "${tmp_dir}/revdiff.tar.gz"
  tar -xzf "${tmp_dir}/revdiff.tar.gz" -C "${tmp_dir}"

  extracted_bin="$(find "${tmp_dir}" -type f -name revdiff | head -n 1)"
  if [ -z "${extracted_bin}" ]; then
    printf 'revdiff binary not found in archive %s\n' "${asset_url}" >&2
    return 1
  fi

  install -m 0755 "${extracted_bin}" "${REVDIFF_INSTALL_DIR}/revdiff"
  printf '%s\n' "${version}" > "${REVDIFF_VERSION_FILE}"
}
